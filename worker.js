const UPSTREAM_ORIGIN = "https://stremio.wyzie.io";

const DISPLAY_LANGUAGE = "Español Latino (IA)";
const TARGET_LANGUAGE = "Spanish";

const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const CACHE_SECONDS = 30 * 24 * 60 * 60;
const AI_URL_TTL_MS = 15 * 60 * 1000;
const ERROR_RETRY_MS = 10 * 60 * 1000;

const MANIFEST = {
  id: "io.wyzie.ai.es419",
  version: "2.0.0",
  name: "Wyzie IA Español Latino",
  description:
    "Subtítulos traducidos por IA al español latinoamericano para Nuvio.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"]
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "Content-Type, Content-Length, X-AI-Status, X-AI-Reason, X-Wyzie-Status"
};

// =========================================================
// RESPUESTAS
// =========================================================

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function subtitleResponse(body, source = "unknown") {
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition":
        'inline; filename="espanol-latino-ai.srt"',
      "Cache-Control":
        `public, max-age=${CACHE_SECONDS}, immutable`,
      "X-AI-Status": source,
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function asciiHeaderValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 180);
}

function failureSrt(reason = "AI unavailable", upstreamStatus = "") {
  const emptySrt =
    "1\r\n" +
    "00:00:00,000 --> 00:00:00,001\r\n" +
    "\r\n";

  return new Response(emptySrt, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition":
        'inline; filename="espanol-latino-ai.srt"',
      "Cache-Control": "no-store",
      "X-AI-Status": "error",
      "X-AI-Reason": asciiHeaderValue(reason),
      "X-Wyzie-Status": String(upstreamStatus || "")
    }
  });
}

// =========================================================
// PARSEO DE RUTAS STREMIO
// =========================================================

function parseMediaPath(pathname) {
  const movie = pathname.match(
    /^\/subtitles\/movie\/(tt\d+)\.json$/i
  );

  if (movie) {
    return {
      type: "movie",
      mediaId: movie[1],
      season: "",
      episode: ""
    };
  }

  const series = pathname.match(
    /^\/subtitles\/series\/(tt\d+):(\d+):(\d+)\.json$/i
  );

  if (series) {
    return {
      type: "series",
      mediaId: series[1],
      season: series[2],
      episode: series[3]
    };
  }

  return null;
}

function parseTranslatePath(pathname) {
  const movie = pathname.match(
    /^\/translate\/movie\/(tt\d+)\.srt$/i
  );

  if (movie) {
    return {
      type: "movie",
      mediaId: movie[1],
      season: "",
      episode: ""
    };
  }

  const series = pathname.match(
    /^\/translate\/series\/(tt\d+):(\d+):(\d+)\.srt$/i
  );

  if (series) {
    return {
      type: "series",
      mediaId: series[1],
      season: series[2],
      episode: series[3]
    };
  }

  return null;
}

function buildUpstreamPath(media) {
  if (media.type === "series") {
    return `/subtitles/series/${media.mediaId}:${media.season}:${media.episode}.json`;
  }

  return `/subtitles/movie/${media.mediaId}.json`;
}

function buildTranslationPath(media) {
  if (media.type === "series") {
    return `/translate/series/${media.mediaId}:${media.season}:${media.episode}.srt`;
  }

  return `/translate/movie/${media.mediaId}.srt`;
}

// =========================================================
// URL IA DE WYZIE
// =========================================================

function unwrapLocalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return null;
  }

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

    if (!from) {
      return null;
    }

    try {
      parsed = new URL(from);
    } catch {
      return null;
    }
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  /*
   * Permitimos únicamente los dominios de Wyzie.
   * Evita que el Worker se convierta en un proxy abierto.
   */
  const allowedHosts = [
    "sub.wyzie.io",
    "stremio.wyzie.io"
  ];

  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    return null;
  }

  if (!parsed.pathname.includes("/translate")) {
    return null;
  }

  return parsed.toString();
}

function isAiSubtitle(subtitle) {
  if (!subtitle || !subtitle.url) {
    return false;
  }

  const source = String(
    subtitle.source || ""
  ).toLowerCase();

  const language = String(
    subtitle.language || subtitle.lang || ""
  ).toLowerCase();

  const format = String(
    subtitle.format || ""
  ).toLowerCase();

  const url = String(subtitle.url);

  const ai =
    subtitle.ai === true ||
    source === "ai" ||
    url.includes("/translate");

  const spanish =
    !language ||
    language === "es" ||
    language.startsWith("es-") ||
    language === "spa";

  const srt =
    !format ||
    format === "srt" ||
    url.toLowerCase().includes(".srt") ||
    url.includes("/translate");

  return ai && spanish && srt;
}

function selectAiSubtitle(data) {
  if (!data || !Array.isArray(data.subtitles)) {
    return null;
  }

  for (const subtitle of data.subtitles) {
    if (!isAiSubtitle(subtitle)) {
      continue;
    }

    const targetUrl = unwrapLocalUrl(subtitle.url);

    if (!targetUrl) {
      continue;
    }

    return {
      id: subtitle.id || "ai-es",
      targetUrl,
      language:
        subtitle.language ||
        subtitle.lang ||
        "es",
      format: subtitle.format || "srt",
      source: subtitle.source || "ai",
      ai: true
    };
  }

  return null;
}

// =========================================================
// CACHE KEY
// =========================================================

function safePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function hashText(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function buildCacheKey(media, targetUrl) {
  const urlHash = await hashText(targetUrl);

  return [
    "ai-es-419",
    safePart(media.mediaId),
    safePart(media.season || "movie"),
    safePart(media.episode || "0"),
    urlHash
  ].join("/") + ".srt";
}

// =========================================================
// VALIDACIÓN SRT
// =========================================================

function looksLikeSrt(text) {
  const value = String(text || "")
    .replace(/^\uFEFF/, "")
    .trim();

  if (!value) {
    return false;
  }

  const beginning = value
    .slice(0, 500)
    .toLowerCase();

  if (
    beginning.includes("<!doctype html") ||
    beginning.includes("<html") ||
    beginning.includes("access denied") ||
    beginning.includes("cloudflare") ||
    beginning.startsWith("{") ||
    beginning.startsWith("[")
  ) {
    return false;
  }

  return /\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(
    value
  );
}

async function readValidR2(object) {
  if (!object) {
    return null;
  }

  if (
    object.size &&
    Number(object.size) > MAX_SUBTITLE_BYTES
  ) {
    return null;
  }

  try {
    const text = await object.text();

    if (!looksLikeSrt(text)) {
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

// =========================================================
// BÚSQUEDA EN EL ADDON FUNCIONAL DE WYZIE
// =========================================================

async function fetchWyzieStremioSearch(media) {
  const path = buildUpstreamPath(media);
  const upstreamUrl = `${UPSTREAM_ORIGIN}${path}`;

  console.log(
    JSON.stringify({
      event: "wyzie_stremio_search",
      mediaId: media.mediaId,
      type: media.type,
      season: media.season || null,
      episode: media.episode || null
    })
  );

  const response = await fetch(upstreamUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "Subsense-Wyzie-AI/2.0"
    }
  });

  return response;
}

// =========================================================
// DURABLE OBJECT
// =========================================================

export class SpanishAiTranslationGate {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (
      request.method !== "POST" ||
      !["/discover", "/translate"].includes(url.pathname)
    ) {
      return failureSrt("Invalid internal route");
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return failureSrt("Invalid internal payload");
    }

    const {
      media,
      mode
    } = payload || {};

    if (
      !media ||
      !media.mediaId ||
      !media.type ||
      !mode
    ) {
      return failureSrt("Incomplete internal data");
    }

    return this.state.blockConcurrencyWhile(async () => {
      if (mode === "discover") {
        return this.discover(media);
      }

      if (mode === "translate") {
        return this.translate(media);
      }

      return failureSrt("Unknown internal mode");
    });
  }

  async discover(media) {
    const now = Date.now();
    const previous = await this.state.storage.get("ai-meta");

    /*
     * Si aún tenemos una URL tk válida, no repetimos /subtitles.
     */
    if (
      previous?.targetUrl &&
      previous.expiresAt &&
      now < previous.expiresAt &&
      previous.cacheKey
    ) {
      return jsonResponse({
        ok: true,
        found: true,
        cacheKey: previous.cacheKey
      });
    }

    let upstream;

    try {
      upstream = await fetchWyzieStremioSearch(media);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "wyzie_stremio_search_network_error",
          mediaId: media.mediaId,
          message: String(error?.message || error).slice(0, 300)
        })
      );

      return jsonResponse(
        {
          ok: false,
          found: false,
          error: "upstream-network-error"
        },
        200
      );
    }

    if (!upstream.ok) {
      let body = "";

      try {
        body = await upstream.text();
      } catch {}

      console.error(
        JSON.stringify({
          event: "wyzie_stremio_search_http_error",
          status: upstream.status,
          mediaId: media.mediaId,
          body: body.slice(0, 300)
        })
      );

      return jsonResponse({
        ok: false,
        found: false,
        error: `upstream-http-${upstream.status}`
      });
    }

    let data;

    try {
      data = await upstream.json();
    } catch {
      return jsonResponse({
        ok: false,
        found: false,
        error: "invalid-upstream-json"
      });
    }

    const aiSubtitle = selectAiSubtitle(data);

    if (!aiSubtitle) {
      await this.state.storage.put("ai-meta", {
        status: "not-found",
        checkedAt: now,
        retryAfter: now + 5 * 60 * 1000
      });

      console.log(
        JSON.stringify({
          event: "wyzie_ai_not_found",
          mediaId: media.mediaId,
          type: media.type
        })
      );

      return jsonResponse({
        ok: true,
        found: false,
        error: "ai-subtitle-not-found"
      });
    }

    const cacheKey = await buildCacheKey(
      media,
      aiSubtitle.targetUrl
    );

    await this.state.storage.put("ai-meta", {
      status: "ready",
      targetUrl: aiSubtitle.targetUrl,
      cacheKey,
      sourceId: aiSubtitle.id,
      language: aiSubtitle.language,
      format: aiSubtitle.format,
      discoveredAt: now,
      expiresAt: now + AI_URL_TTL_MS
    });

    console.log(
      JSON.stringify({
        event: "wyzie_ai_url_discovered",
        mediaId: media.mediaId,
        type: media.type,
        sourceId: aiSubtitle.id,
        cacheKey
      })
    );

    return jsonResponse({
      ok: true,
      found: true,
      cacheKey
    });
  }

  async translate(media) {
    const now = Date.now();
    let meta = await this.state.storage.get("ai-meta");

    /*
     * Si no hay URL tk, la descubrimos.
     * Esto sólo ocurre cuando Nuvio pide realmente el SRT.
     */
    if (
      !meta?.targetUrl ||
      !meta?.cacheKey ||
      !meta.expiresAt ||
      now >= meta.expiresAt
    ) {
      const discovery = await this.discover(media);

      if (!discovery.ok || !discovery.found) {
        return failureSrt(
          "AI subtitle URL was not found"
        );
      }

      meta = await this.state.storage.get("ai-meta");
    }

    const cacheKey = meta.cacheKey;

    const cachedObject =
      await this.env.AI_TRANSLATIONS.get(cacheKey);

    const cachedText =
      await readValidR2(cachedObject);

    if (cachedText) {
      return subtitleResponse(cachedText, "r2-cache");
    }

    const previousState =
      await this.state.storage.get("translation-state");

    if (
      previousState?.status === "failed" &&
      previousState.retryAfter &&
      now < previousState.retryAfter
    ) {
      const reason =
        previousState.upstreamStatus
          ? `Blocked: Wyzie HTTP ${previousState.upstreamStatus}`
          : previousState.reason || "temporary-error";

      return failureSrt(
        `${reason}. Retry after ${new Date(
          previousState.retryAfter
        ).toISOString()}`,
        previousState.upstreamStatus || ""
      );
    }

    await this.state.storage.put("translation-state", {
      status: "processing",
      startedAt: now,
      mediaId: media.mediaId,
      type: media.type,
      season: media.season,
      episode: media.episode
    });

    let upstream;

    try {
      console.log(
        JSON.stringify({
          event: "wyzie_ai_translation_request",
          mediaId: media.mediaId,
          type: media.type,
          sourceId: meta.sourceId,
          cacheKey
        })
      );

      upstream = await fetch(meta.targetUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          Accept: "text/plain, application/x-subrip, */*",
          "User-Agent": "Subsense-Wyzie-AI/2.0"
        }
      });
    } catch (error) {
      const message = String(error?.message || error)
        .slice(0, 300);

      console.error(
        JSON.stringify({
          event: "wyzie_ai_translation_network_error",
          mediaId: media.mediaId,
          message
        })
      );

      await this.state.storage.put("translation-state", {
        status: "failed",
        reason: "network-error",
        retryAfter: Date.now() + ERROR_RETRY_MS,
        finishedAt: Date.now()
      });

      return failureSrt("Wyzie network error");
    }

    if (!upstream.ok) {
      let body = "";

      try {
        body = await upstream.text();
      } catch {
        body = "Unable to read upstream body";
      }

      const safeBody = String(body)
        .replace(/https?:\/\/[^\s"']+/gi, "[url-removed]")
        .replace(/key=[^&\s"']+/gi, "key=[redacted]")
        .replace(/api[_-]?key[=:][^\s&"']+/gi, "api_key=[redacted]")
        .replace(/\s+/g, " ")
        .slice(0, 500);

      console.error(
        JSON.stringify({
          event: "wyzie_ai_translation_http_error",
          status: upstream.status,
          mediaId: media.mediaId,
          type: media.type,
          sourceId: meta.sourceId,
          contentType:
            upstream.headers.get("content-type") || null,
          xCache:
            upstream.headers.get("x-cache") || null,
          xSourceLanguage:
            upstream.headers.get("x-source-language") || null,
          xTargetLanguage:
            upstream.headers.get("x-target-language") || null,
          xSourceProvider:
            upstream.headers.get("x-source-provider") || null,
          upstreamBody: safeBody
        })
      );

      await this.state.storage.put("translation-state", {
        status: "failed",
        reason: `http-${upstream.status}`,
        upstreamStatus: upstream.status,
        upstreamBody: safeBody,
        retryAfter: Date.now() + ERROR_RETRY_MS,
        finishedAt: Date.now()
      });

      return failureSrt(
        `Wyzie HTTP ${upstream.status}`,
        upstream.status
      );
    }

    const contentLength = Number(
      upstream.headers.get("content-length") || "0"
    );

    if (
      contentLength &&
      contentLength > MAX_SUBTITLE_BYTES
    ) {
      return failureSrt("Subtitle too large");
    }

    let subtitleText;

    try {
      subtitleText = await upstream.text();
    } catch {
      return failureSrt("Could not read subtitle response");
    }

    const byteLength =
      new TextEncoder()
        .encode(subtitleText)
        .byteLength;

    if (byteLength > MAX_SUBTITLE_BYTES) {
      return failureSrt("Subtitle too large");
    }

    if (!looksLikeSrt(subtitleText)) {
      console.error(
        JSON.stringify({
          event: "wyzie_ai_invalid_srt",
          mediaId: media.mediaId,
          preview: String(subtitleText)
            .slice(0, 200)
            .replace(/\s+/g, " ")
        })
      );

      await this.state.storage.put("translation-state", {
        status: "failed",
        reason: "invalid-srt",
        retryAfter: Date.now() + ERROR_RETRY_MS,
        finishedAt: Date.now()
      });

      return failureSrt("Wyzie did not return valid SRT");
    }

    await this.env.AI_TRANSLATIONS.put(
      cacheKey,
      subtitleText,
      {
        httpMetadata: {
          contentType:
            "application/x-subrip; charset=utf-8",
          contentDisposition:
            'inline; filename="espanol-latino-ai.srt"',
          cacheControl:
            `public, max-age=${CACHE_SECONDS}, immutable`
        },
        customMetadata: {
          source: "wyzie-stremio",
          target: TARGET_LANGUAGE,
          mediaId: String(media.mediaId),
          type: String(media.type),
          season: String(media.season || ""),
          episode: String(media.episode || ""),
          sourceId: String(meta.sourceId || ""),
          createdAt: new Date().toISOString()
        }
      }
    );

    await this.state.storage.put("translation-state", {
      status: "success",
      cacheKey,
      finishedAt: Date.now()
    });

    console.log(
      JSON.stringify({
        event: "wyzie_ai_translation_cached",
        mediaId: media.mediaId,
        type: media.type,
        cacheKey,
        sourceId: meta.sourceId
      })
    );

    return subtitleResponse(
      subtitleText,
      "wyzie-translated-and-cached"
    );
  }
}

// =========================================================
// RUTAS PÚBLICAS
// =========================================================

async function handleSubtitleResource(request, env, url) {
  const media = parseMediaPath(url.pathname);

  if (!media) {
    return jsonResponse(
      { subtitles: [] },
      404,
      { "Cache-Control": "no-store" }
    );
  }

  /*
   * HEAD no hace búsqueda ni llamada a Wyzie.
   */
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  const gateId =
    env.AI_TRANSLATION_GATE.idFromName(
      `${media.type}|${media.mediaId}|${media.season}|${media.episode}`
    );

  const gate =
    env.AI_TRANSLATION_GATE.get(gateId);

  const discoveryResponse = await gate.fetch(
    "https://spanish-ai-gate/discover",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mode: "discover",
        media
      })
    }
  );

  let discovery;

  try {
    discovery = await discoveryResponse.json();
  } catch {
    return jsonResponse({ subtitles: [] });
  }

  if (!discovery?.ok || !discovery?.found) {
    return jsonResponse(
      { subtitles: [] },
      200,
      {
        "Cache-Control": "public, max-age=300",
        "X-AI-Status": "not-found"
      }
    );
  }

  const subtitleUrl =
    `${url.origin}${buildTranslationPath(media)}`;

  const id =
    media.type === "series"
      ? `ai-es419-${media.mediaId}-${media.season}-${media.episode}`
      : `ai-es419-${media.mediaId}`;

  return jsonResponse(
    {
      subtitles: [
        {
          id,
          url: subtitleUrl,

          /*
           * spa mantiene compatibilidad con el protocolo.
           * display/name hacen visible la etiqueta personalizada
           * en clientes que las soporten.
           */
          lang: "spa",
          display: DISPLAY_LANGUAGE,
          name: DISPLAY_LANGUAGE
        }
      ]
    },
    200,
    {
      "Cache-Control": "public, max-age=300",
      "X-AI-Status": "ready",
      "X-AI-Target": TARGET_LANGUAGE
    }
  );
}

async function handleTranslation(request, env, url) {
  const media = parseTranslatePath(url.pathname);

  if (!media) {
    return failureSrt("Invalid translation route");
  }

  /*
   * HEAD/probe no consume crédito.
   */
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition":
          'inline; filename="espanol-latino-ai.srt"',
        "Cache-Control": "no-store",
        "X-AI-Status": "head-no-charge"
      }
    });
  }

  if (request.method !== "GET") {
    return failureSrt("Method not allowed");
  }

  if (!env.AI_TRANSLATIONS) {
    return failureSrt(
      "AI_TRANSLATIONS binding is not configured"
    );
  }

  if (!env.AI_TRANSLATION_GATE) {
    return failureSrt(
      "AI_TRANSLATION_GATE binding is not configured"
    );
  }

  const gateId =
    env.AI_TRANSLATION_GATE.idFromName(
      `${media.type}|${media.mediaId}|${media.season}|${media.episode}`
    );

  const gate =
    env.AI_TRANSLATION_GATE.get(gateId);

  const response = await gate.fetch(
    "https://spanish-ai-gate/translate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mode: "translate",
        media
      })
    }
  );

  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

// =========================================================
// PÁGINA PRINCIPAL
// =========================================================

function homePage(url) {
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wyzie IA Español Latino</title>
</head>
<body>
  <h1>Wyzie IA Español Latino</h1>
  <p>Addon activo.</p>
  <p>
    <a href="${url.origin}/manifest.json">
      Abrir manifest.json
    </a>
  </p>
  <p>
    <a href="${url.origin}/health">
      Abrir health
    </a>
  </p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

// =========================================================
// EXPORT PRINCIPAL
// =========================================================

const worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse(
        { error: "Method not allowed" },
        405,
        {
          Allow: "GET, HEAD, OPTIONS"
        }
      );
    }

    if (url.pathname === "/") {
      return homePage(url);
    }

    if (url.pathname === "/health") {
      return jsonResponse(
        {
          ok: true,
          service: "wyzie-ai-es419",
          version: MANIFEST.version,
          upstream: UPSTREAM_ORIGIN,
          target: TARGET_LANGUAGE,
          keyConfigured: Boolean(env.WYZIE_API_KEY),
          r2Configured: Boolean(env.AI_TRANSLATIONS),
          durableObjectConfigured: Boolean(
            env.AI_TRANSLATION_GATE
          )
        },
        200,
        {
          "Cache-Control": "no-store"
        }
      );
    }

    if (url.pathname === "/manifest.json") {
      return jsonResponse(MANIFEST, 200, {
        "Cache-Control":
          "no-cache, no-store, must-revalidate"
      });
    }

    if (url.pathname.startsWith("/subtitles/")) {
      return handleSubtitleResource(request, env, url);
    }

    if (url.pathname.startsWith("/translate/")) {
      return handleTranslation(request, env, url);
    }

    return jsonResponse(
      { error: "Not found" },
      404,
      {
        "Cache-Control": "no-store"
      }
    );
  }
};

export default worker_default;
