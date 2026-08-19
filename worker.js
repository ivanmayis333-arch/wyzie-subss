const UPSTREAM_ORIGIN = "https://stremio.wyzie.io";

const MANIFEST = {
  id: "io.wyzie.nuvio.bridge",
  version: "1.0.0",
  name: "Wyzie Subs - Nuvio Bridge",
  description: "HTTPS bridge between Nuvio and the hosted Wyzie Stremio subtitle add-on.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"]
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*"
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
  if (!env.WYZIE_API_KEY) {
    throw new Error("WYZIE_API_KEY is not configured");
  }

  // Keep the same shape used by the hosted Wyzie Stremio add-on.
  const config = {
    apiKey: env.WYZIE_API_KEY
  };

  if (typeof env.WYZIE_LANGUAGES === "string") {
    config.languages = env.WYZIE_LANGUAGES;
  }

  if (String(env.WYZIE_HI || "").toLowerCase() === "true") {
    config.hi = true;
  }

  return encodeURIComponent(JSON.stringify(config));
}

function isValidSubtitlePath(pathname) {
  // Expected Stremio resource forms:
  // /subtitles/movie/tt1234567.json
  // /subtitles/series/tt1234567:1:2.json
  return /^\/subtitles\/(movie|series)\/tt[0-9]+(?::[0-9]+:[0-9]+)?\.json$/.test(pathname);
}

async function proxyWyzieSubtitle(request, env, url) {
  const encodedConfig = buildWyzieConfig(env);
  const upstreamUrl =
    `${UPSTREAM_ORIGIN}/${encodedConfig}${url.pathname}${url.search}`;

  let upstream;

  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      // A short edge cache reduces repeated calls for the same title.
      cf: {
        cacheEverything: true,
        cacheTtl: 300
      }
    });
  } catch (error) {
    return jsonResponse(
      {
        subtitles: [],
        bridgeError: "Could not reach Wyzie upstream"
      },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  const headers = new Headers(upstream.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");

  // Never pass cookies through the bridge.
  headers.delete("Set-Cookie");

  if (upstream.ok) {
    headers.set("Cache-Control", "public, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

async function upstreamDiagnostic(env) {
  try {
    const encodedConfig = buildWyzieConfig(env);
    const upstreamUrl = `${UPSTREAM_ORIGIN}/${encodedConfig}/manifest.json`;

    const response = await fetch(upstreamUrl, {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true }
    });

    let manifest = null;
    try {
      manifest = await response.json();
    } catch {
      // Keep diagnostics sanitized even if upstream returned invalid JSON.
    }

    return jsonResponse({
      ok: response.ok,
      upstreamStatus: response.status,
      upstreamId: manifest?.id ?? null,
      upstreamVersion: manifest?.version ?? null,
      resources: manifest?.resources ?? null,
      types: manifest?.types ?? null,
      keyConfigured: Boolean(env.WYZIE_API_KEY),
      languages: env.WYZIE_LANGUAGES ?? ""
    }, response.ok ? 200 : 502, {
      "Cache-Control": "no-store"
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      keyConfigured: Boolean(env.WYZIE_API_KEY),
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500, {
      "Cache-Control": "no-store"
    });
  }
}

function homePage(url) {
  const manifestUrl = `${url.origin}/manifest.json`;

  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wyzie Subs - Nuvio Bridge</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.55}
    code{background:#f2f2f2;padding:3px 6px;border-radius:6px;word-break:break-all}
    .ok{font-weight:700}
  </style>
</head>
<body>
  <h1>Wyzie Subs - Nuvio Bridge</h1>
  <p class="ok">Worker activo.</p>
  <p>Instala este manifest en Nuvio:</p>
  <p><code>${manifestUrl}</code></p>
  <p>Diagnóstico: <code>${url.origin}/debug/upstream</code></p>
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
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, {
        "Allow": "GET, OPTIONS"
      });
    }

    if (url.pathname === "/") {
      return homePage(url);
    }

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "wyzie-nuvio-bridge",
        keyConfigured: Boolean(env.WYZIE_API_KEY),
        languages: env.WYZIE_LANGUAGES ?? ""
      }, 200, {
        "Cache-Control": "no-store"
      });
    }

    if (url.pathname === "/manifest.json") {
      return jsonResponse(MANIFEST, 200, {
        "Cache-Control": "public, max-age=3600"
      });
    }

    if (url.pathname === "/debug/upstream") {
      return upstreamDiagnostic(env);
    }

    if (url.pathname.startsWith("/subtitles/")) {
      if (!isValidSubtitlePath(url.pathname)) {
        return jsonResponse({ subtitles: [] }, 404, {
          "Cache-Control": "no-store"
        });
      }

      try {
        return await proxyWyzieSubtitle(request, env, url);
      } catch (error) {
        return jsonResponse({
          subtitles: [],
          bridgeError: error instanceof Error ? error.message : "Bridge error"
        }, 500, {
          "Cache-Control": "no-store"
        });
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};
