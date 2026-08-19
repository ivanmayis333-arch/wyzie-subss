const UPSTREAM_ORIGIN = "https://stremio.wyzie.io";

const MANIFEST = {
  id: "io.wyzie.nuvio.bridge",
  version: "1.1.0",
  name: "Wyzie Subs for Nuvio",
  description:
    "HTTPS bridge for Wyzie subtitles. Proxies and converts subtitle files so Nuvio does not depend on Stremio's localhost subtitle service.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"]
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Type, Content-Length"
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function buildWyzieConfig(env) {
  if (!env.WYZIE_API_KEY) throw new Error("WYZIE_API_KEY is not configured");

  const config = { apiKey: env.WYZIE_API_KEY };

  if (typeof env.WYZIE_LANGUAGES === "string" && env.WYZIE_LANGUAGES.trim()) {
    config.languages = env.WYZIE_LANGUAGES.trim();
  }

  if (String(env.WYZIE_HI || "").toLowerCase() === "true") {
    config.hi = true;
  }

  return encodeURIComponent(JSON.stringify(config));
}

function isValidSubtitleResourcePath(pathname) {
  return /^\/subtitles\/(movie|series)\/tt[0-9]+(?::[0-9]+:[0-9]+)?\.json$/.test(pathname);
}

function encodeToken(value) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeToken(value) {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

function unwrapLocalSubtitleUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocal =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]";

  if (isLocal) {
    const from = parsed.searchParams.get("from");
    if (!from) return null;

    try {
      const unwrapped = new URL(from);
      if (!["https:", "http:"].includes(unwrapped.protocol)) return null;
      return unwrapped.toString();
    } catch {
      return null;
    }
  }

  if (!["https:", "http:"].includes(parsed.protocol)) return null;
  return parsed.toString();
}

function isAllowedSubtitleSource(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    return (
      u.protocol === "https:" &&
      (u.hostname === "sub.wyzie.io" || u.hostname.endsWith(".wyzie.io"))
    );
  } catch {
    return false;
  }
}

function makeProxyUrl(origin, sourceUrl, id = "") {
  const token = encodeToken(sourceUrl);
  const safeId = String(id || "subtitle").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${origin}/subtitle-file/${safeId}/${token}.vtt`;
}

function rewriteSubtitleJson(payload, requestOrigin) {
  if (!payload || !Array.isArray(payload.subtitles)) {
    return { payload, stats: { total: 0, rewritten: 0, localWrapped: 0 } };
  }

  let rewritten = 0;
  let localWrapped = 0;

  const subtitles = payload.subtitles.map((subtitle, index) => {
    if (!subtitle || typeof subtitle.url !== "string") return subtitle;

    let originalParsed;
    try {
      originalParsed = new URL(subtitle.url);
    } catch {
      return subtitle;
    }

    const host = originalParsed.hostname.toLowerCase();
    const wasLocal =
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]";

    const sourceUrl = unwrapLocalSubtitleUrl(subtitle.url);

    if (!sourceUrl || !isAllowedSubtitleSource(sourceUrl)) {
      return subtitle;
    }

    if (wasLocal) localWrapped += 1;
    rewritten += 1;

    return {
      ...subtitle,
      url: makeProxyUrl(requestOrigin, sourceUrl, subtitle.id || index)
    };
  });

  return {
    payload: { ...payload, subtitles },
    stats: {
      total: payload.subtitles.length,
      rewritten,
      localWrapped
    }
  };
}

function getCharset(contentType, sourceUrl) {
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType || "");
  if (match?.[1]) return match[1].toLowerCase();

  try {
    const encoding = new URL(sourceUrl).searchParams.get("encoding");
    if (encoding) return encoding.toLowerCase();
  } catch {}

  return "utf-8";
}

function normalizeCharset(charset) {
  const value = String(charset || "utf-8").toLowerCase();

  if (["utf8", "utf-8"].includes(value)) return "utf-8";
  if (["latin1", "latin-1", "iso-8859-1", "iso8859-1"].includes(value)) {
    return "windows-1252";
  }
  if (["windows-1252", "cp1252"].includes(value)) return "windows-1252";

  return value;
}

function decodeSubtitleBuffer(buffer, contentType, sourceUrl) {
  const charset = normalizeCharset(getCharset(contentType, sourceUrl));

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}

function srtToVtt(text) {
  let out = stripBom(text).replace(/\r\n?/g, "\n");

  if (/^\s*WEBVTT/i.test(out)) {
    return out.trimStart();
  }

  out = out
    .split("\n")
    .map((line) => {
      if (!line.includes("-->")) return line;
      return line.replace(
        /(\d{1,2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*\d{1,2}:\d{2}:\d{2}),(\d{3})/,
        "$1.$2$3.$4"
      );
    })
    .join("\n");

  return `WEBVTT\n\n${out.trim()}\n`;
}

function assTimeToVtt(value) {
  const m = /^\s*(\d+):(\d{2}):(\d{2})[.](\d{1,2})\s*$/.exec(value);
  if (!m) return null;

  const h = String(Number(m[1])).padStart(2, "0");
  const mm = m[2];
  const ss = m[3];
  const ms = String(Number(m[4]) * 10).padStart(3, "0");

  return `${h}:${mm}:${ss}.${ms}`;
}

function cleanAssText(value) {
  return value
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/gi, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

function assToVtt(text) {
  const lines = stripBom(text).replace(/\r\n?/g, "\n").split("\n");
  let inEvents = false;
  let format = [];
  const cues = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^\[Events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }

    if (/^\[.+\]$/.test(line) && !/^\[Events\]$/i.test(line)) {
      if (inEvents) inEvents = false;
      continue;
    }

    if (!inEvents) continue;

    if (/^Format:/i.test(line)) {
      format = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((x) => x.trim().toLowerCase());
      continue;
    }

    if (!/^Dialogue:/i.test(line) || format.length === 0) continue;

    const raw = line.slice(line.indexOf(":") + 1).trim();

    const parts = [];
    let rest = raw;

    for (let i = 0; i < format.length - 1; i++) {
      const idx = rest.indexOf(",");
      if (idx === -1) {
        parts.push(rest);
        rest = "";
      } else {
        parts.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
      }
    }
    parts.push(rest);

    const values = {};
    format.forEach((key, i) => {
      values[key] = parts[i] ?? "";
    });

    const start = assTimeToVtt(values.start);
    const end = assTimeToVtt(values.end);
    const cueText = cleanAssText(values.text || "");

    if (start && end && cueText) {
      cues.push(`${start} --> ${end}\n${cueText}`);
    }
  }

  if (!cues.length) {
    return `WEBVTT\n\nNOTE Could not convert this ASS subtitle automatically.\n`;
  }

  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function subtitleToVtt(text, sourceUrl) {
  const normalized = stripBom(text).trimStart();

  if (/^WEBVTT/i.test(normalized)) return normalized;

  let format = "";
  try {
    format = (new URL(sourceUrl).searchParams.get("format") || "").toLowerCase();
  } catch {}

  if (
    format === "ass" ||
    format === "ssa" ||
    /^\[Script Info\]/i.test(normalized) ||
    /\n\[Events\]/i.test(normalized)
  ) {
    return assToVtt(normalized);
  }

  return srtToVtt(normalized);
}

async function fetchUpstreamSubtitleList(env, url) {
  const encodedConfig = buildWyzieConfig(env);
  const upstreamUrl =
    `${UPSTREAM_ORIGIN}/${encodedConfig}${url.pathname}${url.search}`;

  const response = await fetch(upstreamUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    cf: {
      cacheEverything: true,
      cacheTtl: 300
    }
  });

  return { response, upstreamUrl };
}

async function proxySubtitleList(request, env, url) {
  let upstream;

  try {
    ({ response: upstream } = await fetchUpstreamSubtitleList(env, url));
  } catch {
    return jsonResponse(
      { subtitles: [], bridgeError: "Could not reach Wyzie upstream" },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  if (!upstream.ok) {
    return jsonResponse(
      {
        subtitles: [],
        bridgeError: `Wyzie upstream returned HTTP ${upstream.status}`
      },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return jsonResponse(
      { subtitles: [], bridgeError: "Wyzie returned invalid JSON" },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  const { payload: rewritten, stats } = rewriteSubtitleJson(payload, url.origin);

  return jsonResponse(rewritten, 200, {
    "Cache-Control": "public, max-age=300",
    "X-Bridge-Subtitle-Count": String(stats.total),
    "X-Bridge-Rewritten-Count": String(stats.rewritten),
    "X-Bridge-Localhost-Count": String(stats.localWrapped)
  });
}

async function proxySubtitleFile(request, sourceUrl) {
  if (!isAllowedSubtitleSource(sourceUrl)) {
    return new Response("Forbidden subtitle source", {
      status: 403,
      headers: CORS_HEADERS
    });
  }

  let upstream;
  try {
    upstream = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        Accept: "text/vtt,text/plain,application/x-subrip,text/srt,*/*;q=0.8",
        "User-Agent": "Wyzie-Nuvio-Bridge/1.1"
      },
      redirect: "follow",
      cf: {
        cacheEverything: true,
        cacheTtl: 86400
      }
    });
  } catch {
    return new Response("Could not download subtitle", {
      status: 502,
      headers: CORS_HEADERS
    });
  }

  if (!upstream.ok) {
    return new Response(`Subtitle upstream returned HTTP ${upstream.status}`, {
      status: 502,
      headers: CORS_HEADERS
    });
  }

  const buffer = await upstream.arrayBuffer();

  if (buffer.byteLength > 5 * 1024 * 1024) {
    return new Response("Subtitle file too large", {
      status: 413,
      headers: CORS_HEADERS
    });
  }

  const text = decodeSubtitleBuffer(
    buffer,
    upstream.headers.get("Content-Type") || "",
    sourceUrl
  );

  const vtt = subtitleToVtt(text, sourceUrl);

  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", "text/vtt; charset=utf-8");
  headers.set("Content-Disposition", 'inline; filename="subtitle.vtt"');
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(vtt, {
    status: 200,
    headers
  });
}

async function upstreamDiagnostic(env) {
  try {
    const encodedConfig = buildWyzieConfig(env);
    const upstreamUrl = `${UPSTREAM_ORIGIN}/${encodedConfig}/manifest.json`;

    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true }
    });

    let manifest = null;
    try {
      manifest = await response.json();
    } catch {}

    return jsonResponse(
      {
        ok: response.ok,
        bridgeVersion: MANIFEST.version,
        upstreamStatus: response.status,
        upstreamId: manifest?.id ?? null,
        upstreamVersion: manifest?.version ?? null,
        resources: manifest?.resources ?? null,
        types: manifest?.types ?? null,
        keyConfigured: Boolean(env.WYZIE_API_KEY),
        languages: env.WYZIE_LANGUAGES ?? ""
      },
      response.ok ? 200 : 502,
      { "Cache-Control": "no-store" }
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        bridgeVersion: MANIFEST.version,
        keyConfigured: Boolean(env.WYZIE_API_KEY),
        error: error instanceof Error ? error.message : "Unknown error"
      },
      500,
      { "Cache-Control": "no-store" }
    );
  }
}

async function rewriteDiagnostic(env, url, pathname) {
  const match =
    /^\/debug\/rewrite\/(movie|series)\/(tt[0-9]+(?::[0-9]+:[0-9]+)?)$/.exec(
      pathname
    );

  if (!match) {
    return jsonResponse(
      {
        error:
          "Use /debug/rewrite/movie/ttXXXXXXX or /debug/rewrite/series/ttXXXXXXX:S:E"
      },
      400
    );
  }

  const fakeUrl = new URL(url.origin);
  fakeUrl.pathname = `/subtitles/${match[1]}/${match[2]}.json`;

  try {
    const { response } = await fetchUpstreamSubtitleList(env, fakeUrl);

    if (!response.ok) {
      return jsonResponse(
        { ok: false, upstreamStatus: response.status },
        502,
        { "Cache-Control": "no-store" }
      );
    }

    const payload = await response.json();
    const { payload: rewritten, stats } = rewriteSubtitleJson(payload, url.origin);

    const sample = Array.isArray(rewritten.subtitles)
      ? rewritten.subtitles.slice(0, 3).map((s) => ({
          id: s?.id ?? null,
          lang: s?.lang ?? null,
          proxied:
            typeof s?.url === "string" && s.url.startsWith(url.origin)
        }))
      : [];

    return jsonResponse(
      {
        ok: true,
        bridgeVersion: MANIFEST.version,
        ...stats,
        sample
      },
      200,
      { "Cache-Control": "no-store" }
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error"
      },
      500,
      { "Cache-Control": "no-store" }
    );
  }
}

function homePage(url) {
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wyzie Subs for Nuvio</title>
</head>
<body>
  <h1>Wyzie Subs for Nuvio</h1>
  <p><strong>Bridge V${MANIFEST.version} activo.</strong></p>
  <p>Manifest: <code>${url.origin}/manifest.json</code></p>
  <p>Health: <code>${url.origin}/health</code></p>
  <p>Upstream: <code>${url.origin}/debug/upstream</code></p>
  <p>Rewrite test: <code>${url.origin}/debug/rewrite/movie/tt0133093</code></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "GET, HEAD, OPTIONS"
      });
    }

    if (url.pathname === "/") return homePage(url);

    if (url.pathname === "/health") {
      return jsonResponse(
        {
          ok: true,
          service: "wyzie-nuvio-bridge",
          bridgeVersion: MANIFEST.version,
          keyConfigured: Boolean(env.WYZIE_API_KEY),
          languages: env.WYZIE_LANGUAGES ?? ""
        },
        200,
        { "Cache-Control": "no-store" }
      );
    }

    if (url.pathname === "/manifest.json") {
      return jsonResponse(MANIFEST, 200, {
        "Cache-Control": "no-cache, no-store, must-revalidate"
      });
    }

    if (url.pathname === "/debug/upstream") {
      return upstreamDiagnostic(env);
    }

    if (url.pathname.startsWith("/debug/rewrite/")) {
      return rewriteDiagnostic(env, url, url.pathname);
    }

    if (url.pathname.startsWith("/subtitle-file/")) {
      const match =
        /^\/subtitle-file\/[^/]+\/([A-Za-z0-9_-]+)\.vtt$/.exec(url.pathname);

      if (!match) {
        return new Response("Invalid subtitle-file URL", {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      let sourceUrl;
      try {
        sourceUrl = decodeToken(match[1]);
      } catch {
        return new Response("Invalid subtitle token", {
          status: 400,
          headers: CORS_HEADERS
        });
      }

      return proxySubtitleFile(request, sourceUrl);
    }

    if (url.pathname.startsWith("/subtitles/")) {
      if (!isValidSubtitleResourcePath(url.pathname)) {
        return jsonResponse(
          { subtitles: [] },
          404,
          { "Cache-Control": "no-store" }
        );
      }

      return proxySubtitleList(request, env, url);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};
