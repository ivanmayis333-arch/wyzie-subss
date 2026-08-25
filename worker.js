const WYZIE_ORIGIN = "https://sub.wyzie.io";
const TARGET_LANGUAGE = "Spanish";
const DISPLAY_LANGUAGE = "Español Latino (IA)";

const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const ERROR_RETRY_MS = 10 * 60 * 1000;
const CACHE_SECONDS = 30 * 24 * 60 * 60;

const MANIFEST = {
  id: "io.wyzie.ai.es419",
  version: "1.0.1",
  name: "Wyzie IA Español Latino",
  description:
    "Subtítulos traducidos por IA al español mediante Wyzie.",
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

/*
 * Los valores de headers HTTP deben ser ASCII.
 * Esta función elimina acentos y caracteres no válidos.
 */
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

  const safeReason = asciiHeaderValue(reason);

  return new Response(emptySrt, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition":
        'inline; filename="espanol-latino-ai.srt"',
      "Cache-Control": "no-store",
      "X-AI-Status": "error",
      "X-AI-Reason": safeReason,
      "X-Wyzie-Status": String(upstreamStatus || "")
    }
  });
}

// =========================================================
// RUTAS
// =========================================================

function parseSubtitlePath(pathname) {
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

function parseTranslationPath(pathname) {
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

function buildTranslationUrl(origin, media) {
  if (media.type === "series") {
    return (
      `${origin}/translate/series/` +
      `${media.mediaId}:${media.season}:${media.episode}.srt`
    );
  }

  return `${origin}/translate/movie/${media.mediaId}.srt`;
}

// =========================================================
// CACHE KEY
// =========================================================

function buildCacheKey(media) {
  return [
    "ai-es-419",
    safePart(media.mediaId),
    safePart(media.season || "movie"),
    safePart(media.episode || "0"),
    "Spanish"
  ].join("/") + ".srt";
}

function safePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

// =========================================================
// VALIDACIÓN SRT
// =========================================================

function looksLikeSrt(text) {
  const value = String(text || "")
    .replace(/^\uFEFF/, "")
    .trim();

  if (!value) return false;

  const firstPart = value.slice(0, 500).toLowerCase();

  if (
    firstPart.includes("<!doctype html") ||
    firstPart.includes("<html") ||
    firstPart.includes("access denied") ||
    firstPart.includes("cloudflare") ||
    firstPart.startsWith("{") ||
    firstPart.startsWith("[")
  ) {
    return false;
  }

  return /\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(
    value
  );
}

async function readValidR2Subtitle(object) {
  if (!object) return null;

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
// WYzIE TRANSLATION
// =========================================================

async function fetchWyzieTranslation(env, media) {
  if (!env.WYZIE_API_KEY) {
    throw new Error("WYZIE_API_KEY is not configured");
  }

  const params = new URLSearchParams();

  params.set("id", media.mediaId);
  params.set("target", TARGET_LANGUAGE);
  params.set("key", env.WYZIE_API_KEY);

  if (media.type === "series") {
    params.set("season", media.season);
    params.set("episode", media.episode);
  }

  const requestUrl =
    `${WYZIE_ORIGIN}/translate?${params.toString()}`;

  console.log(
    JSON.stringify({
      event: "wyzie_translate_request",
      mediaId: media.mediaId,
      type: media.type,
      season: media.season || null,
      episode: media.episode || null,
      target: TARGET_LANGUAGE
    })
  );

  return fetch(requestUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/plain, application/x-subrip, */*",
      "User-Agent": "Wyzie-AI-ES419-Addon/1.0"
    }
  });
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
    if (request.method !== "POST") {
      return failureSrt("Internal method not allowed");
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return failureSrt("Invalid internal payload");
    }

    const {
      cacheKey,
      mediaId,
      type,
      season = "",
      episode = ""
    } = payload || {};

    if (!cacheKey || !mediaId || !type) {
      return failureSrt("Incomplete internal data");
    }

    /*
     * Serializa solicitudes del mismo Durable Object.
     */
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();

      /*
       * Segunda comprobación de R2.
       * Es necesaria para evitar dos llamadas simultáneas.
       */
      const cachedObject =
        await this.env.AI_TRANSLATIONS.get(cacheKey);

      const cachedText =
        await readValidR2Subtitle(cachedObject);

      if (cachedText) {
        await this.state.storage.put("translation-state", {
          status: "success",
          cacheKey,
          finishedAt: now
        });

        return subtitleResponse(cachedText, "r2-after-lock");
      }

      const previousState =
        await this.state.storage.get("translation-state");

      /*
       * Si hubo un error reciente, no repetimos la llamada
       * pagada hasta que termine el periodo de espera.
       */
      if (
        previousState?.status === "failed" &&
        previousState.retryAfter &&
        now < previousState.retryAfter
      ) {
        const originalReason =
          previousState.upstreamStatus
            ? `Blocked: Wyzie HTTP ${previousState.upstreamStatus}`
            : previousState.reason || "temporary error";

        return failureSrt(
          `${originalReason}. Retry after ${new Date(
            previousState.retryAfter
          ).toISOString()}`
        );
      }

      await this.state.storage.put("translation-state", {
        status: "processing",
        startedAt: now,
        mediaId,
        type,
        season,
        episode
      });

      let upstream;

      try {
        upstream = await fetchWyzieTranslation(this.env, {
          mediaId,
          type,
          season,
          episode
        });
      } catch (error) {
        const message = String(error?.message || error);

        console.error(
          JSON.stringify({
            event: "wyzie_translate_network_error",
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
        const responseStatus = upstream.status;

        console.error(
          JSON.stringify({
            event: "wyzie_translate_http_error",
            status: responseStatus,
            mediaId,
            type,
            season: season || null,
            episode: episode || null
          })
        );

        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: `http-${responseStatus}`,
          upstreamStatus: responseStatus,
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt(
          `Wyzie HTTP ${responseStatus}`,
          responseStatus
        );
      }

      const contentLength = Number(
        upstream.headers.get("Content-Length") || "0"
      );

      if (
        contentLength &&
        contentLength > MAX_SUBTITLE_BYTES
      ) {
        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: "subtitle-too-large",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt("Subtitle too large");
      }

      let subtitleText;

      try {
        /*
         * Wyzie transmite el SRT.
         * Esperamos el texto completo para guardarlo en R2.
         */
        subtitleText = await upstream.text();
      } catch (error) {
        const message = String(error?.message || error);

        console.error(
          JSON.stringify({
            event: "wyzie_translate_body_error",
            message
          })
        );

        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: "body-read-error",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt("Could not read Wyzie response");
      }

      const subtitleBytes =
        new TextEncoder().encode(subtitleText).byteLength;

      if (subtitleBytes > MAX_SUBTITLE_BYTES) {
        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: "subtitle-too-large",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt("Subtitle too large");
      }

      if (!looksLikeSrt(subtitleText)) {
        console.error(
          JSON.stringify({
            event: "wyzie_translate_invalid_srt",
            mediaId,
            type,
            preview: String(subtitleText)
              .slice(0, 120)
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

      /*
       * Sólo se guarda una respuesta SRT válida.
       */
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
            source: "wyzie",
            target: TARGET_LANGUAGE,
            mediaId: String(mediaId),
            type: String(type),
            season: String(season || ""),
            episode: String(episode || ""),
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
          event: "wyzie_translate_cached",
          mediaId,
          type,
          season: season || null,
          episode: episode || null,
          target: TARGET_LANGUAGE
        })
      );

      return subtitleResponse(
        subtitleText,
        "wyzie-translated-and-cached"
      );
    });
  }
}

// =========================================================
// ADDON: RESPUESTA DE SUBTÍTULOS
// =========================================================

async function handleSubtitleResource(request, env, url) {
  const media = parseSubtitlePath(url.pathname);

  if (!media) {
    return jsonResponse(
      { subtitles: [] },
      404,
      { "Cache-Control": "no-store" }
    );
  }

  const translationUrl =
    buildTranslationUrl(url.origin, media);

  const subtitleId =
    media.type === "series"
      ? `ai-es419-${media.mediaId}-${media.season}-${media.episode}`
      : `ai-es419-${media.mediaId}`;

  const subtitles = [
    {
      id: subtitleId,
      url: translationUrl,
      lang: DISPLAY_LANGUAGE
    }
  ];

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    });
  }

  return jsonResponse(
    { subtitles },
    200,
    {
      "Cache-Control": "public, max-age=300",
      "X-AI-Addon": "es419",
      "X-AI-Target": TARGET_LANGUAGE
    }
  );
}

// =========================================================
// TRADUCCIÓN
// =========================================================

async function handleTranslation(request, env, url) {
  const media = parseTranslationPath(url.pathname);

  if (!media) {
    return failureSrt("Invalid translation route");
  }

  /*
   * HEAD no consume traducción.
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

  if (!env.WYZIE_API_KEY) {
    return failureSrt("WYZIE_API_KEY is not configured");
  }

  if (!env.AI_TRANSLATIONS) {
    return failureSrt("AI_TRANSLATIONS binding is not configured");
  }

  if (!env.AI_TRANSLATION_GATE) {
    return failureSrt(
      "AI_TRANSLATION_GATE binding is not configured"
    );
  }

  const cacheKey = buildCacheKey(media);

  /*
   * Primera comprobación de R2.
   */
  const cachedObject =
    await env.AI_TRANSLATIONS.get(cacheKey);

  const cachedText =
    await readValidR2Subtitle(cachedObject);

  if (cachedText) {
    return subtitleResponse(cachedText, "r2-cache");
  }

  /*
   * Un Durable Object por película/episodio.
   */
  const objectId =
    env.AI_TRANSLATION_GATE.idFromName(cacheKey);

  const gate =
    env.AI_TRANSLATION_GATE.get(objectId);

  const response = await gate.fetch(
    "https://spanish-ai-gate/process",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        cacheKey,
        mediaId: media.mediaId,
        type: media.type,
        season: media.season,
        episode: media.episode
      })
    }
  );

  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(
    CORS_HEADERS
  )) {
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
        { Allow: "GET, HEAD, OPTIONS" }
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
          keyConfigured: Boolean(env.WYZIE_API_KEY),
          r2Configured: Boolean(env.AI_TRANSLATIONS),
          durableObjectConfigured: Boolean(
            env.AI_TRANSLATION_GATE
          ),
          target: TARGET_LANGUAGE
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
      { "Cache-Control": "no-store" }
    );
  }
};

export default worker_default;
