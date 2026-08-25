const WYZIE_ORIGIN = "https://sub.wyzie.io";
const TARGET_LANGUAGE = "Spanish";
const DISPLAY_LANGUAGE = "Español Latino (IA)";

const MANIFEST = {
  id: "io.wyzie.ai.es419",
  version: "1.0.0",
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
    "Content-Type, Content-Length, X-AI-Status"
};

const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const ERROR_RETRY_MS = 10 * 60 * 1000;
const R2_CACHE_SECONDS = 30 * 24 * 60 * 60;

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

function subtitleResponse(body, statusSource = "unknown") {
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition":
        'inline; filename="espanol-latino-ai.srt"',
      "Cache-Control":
        `public, max-age=${R2_CACHE_SECONDS}, immutable`,
      "X-AI-Status": statusSource,
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function failureSrt(reason, status = 200) {
  /*
   * Se devuelve un SRT vacío para evitar que Nuvio
   * entre en bucles de reintento por códigos 4xx/5xx.
   *
   * Nunca se guarda ni se cachea este contenido.
   */
  const emptySrt =
    "1\n" +
    "00:00:00,000 --> 00:00:00,001\n" +
    "\n";

  return new Response(emptySrt, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition":
        'inline; filename="espanol-latino-ai.srt"',
      "Cache-Control": "no-store",
      "X-AI-Status": "error",
      "X-AI-Reason": String(reason).slice(0, 180)
    }
  });
}

// =========================================================
// VALIDACIÓN DE RUTAS
// =========================================================

function parseSubtitleResourcePath(pathname) {
  const movieMatch =
    /^\/subtitles\/movie\/(tt\d+)\.json$/i.exec(pathname);

  if (movieMatch) {
    return {
      type: "movie",
      mediaId: movieMatch[1],
      season: "",
      episode: ""
    };
  }

  const seriesMatch =
    /^\/subtitles\/series\/(tt\d+):(\d+):(\d+)\.json$/i.exec(
      pathname
    );

  if (seriesMatch) {
    return {
      type: "series",
      mediaId: seriesMatch[1],
      season: seriesMatch[2],
      episode: seriesMatch[3]
    };
  }

  return null;
}

function parseTranslationPath(pathname) {
  const movieMatch =
    /^\/translate\/movie\/(tt\d+)\.srt$/i.exec(pathname);

  if (movieMatch) {
    return {
      type: "movie",
      mediaId: movieMatch[1],
      season: "",
      episode: ""
    };
  }

  const seriesMatch =
    /^\/translate\/series\/(tt\d+):(\d+):(\d+)\.srt$/i.exec(
      pathname
    );

  if (seriesMatch) {
    return {
      type: "series",
      mediaId: seriesMatch[1],
      season: seriesMatch[2],
      episode: seriesMatch[3]
    };
  }

  return null;
}

function buildTranslationPath(media) {
  if (media.type === "series") {
    return `/translate/series/${media.mediaId}:${media.season}:${media.episode}.srt`;
  }

  return `/translate/movie/${media.mediaId}.srt`;
}

// =========================================================
// CACHÉ
// =========================================================

function buildCacheKey(media) {
  return [
    "ai-es-419",
    safePathPart(media.mediaId),
    safePathPart(media.season || "movie"),
    safePathPart(media.episode || "0"),
    "Spanish"
  ].join("/") + ".srt";
}

function safePathPart(value) {
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

  /*
   * Comprueba que exista al menos un bloque
   * con formato temporal SRT.
   */
  return /\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(
    value
  );
}

async function isValidR2Subtitle(object) {
  if (!object) return false;

  if (
    object.size &&
    Number(object.size) > MAX_SUBTITLE_BYTES
  ) {
    return false;
  }

  try {
    const text = await object.text();
    return looksLikeSrt(text);
  } catch {
    return false;
  }
}

// =========================================================
// LLAMADA DIRECTA A WYZIE
// =========================================================

async function fetchWyzieTranslation(env, media) {
  if (!env.WYZIE_API_KEY) {
    throw new Error("WYZIE_API_KEY no está configurada");
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

  const response = await fetch(requestUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/plain, application/x-subrip, */*",
      "User-Agent": "Wyzie-AI-ES419-Addon/1.0"
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
    if (request.method !== "POST") {
      return failureSrt("Método interno no permitido");
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return failureSrt("Payload interno inválido");
    }

    const {
      cacheKey,
      mediaId,
      type,
      season = "",
      episode = ""
    } = payload || {};

    if (!cacheKey || !mediaId || !type) {
      return failureSrt("Datos internos incompletos");
    }

    /*
     * Todas las solicitudes del mismo contenido pasan
     * de forma ordenada por este bloque.
     */
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();

      /*
       * Segunda comprobación obligatoria de R2.
       *
       * La primera comprobación se hace en el Worker principal.
       * Esta segunda protege contra dos solicitudes simultáneas.
       */
      const cached = await this.env.AI_TRANSLATIONS.get(
        cacheKey
      );

      if (cached && await isValidR2Subtitle(cached)) {
        const body = await cached.text();

        return subtitleResponse(body, "r2-after-lock");
      }

      /*
       * Si hubo un error reciente, no llamamos repetidamente
       * a Wyzie durante el periodo de enfriamiento.
       */
      const previousState =
        await this.state.storage.get("translation-state");

      if (
        previousState?.status === "failed" &&
        previousState.retryAfter &&
        now < previousState.retryAfter
      ) {
        return failureSrt(
          `Bloqueo temporal hasta ${new Date(
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
        console.error(
          JSON.stringify({
            event: "wyzie_translate_network_error",
            message: String(error?.message || error)
          })
        );

        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: "network-error",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt("Error de red al consultar Wyzie");
      }

      if (!upstream.ok) {
        console.error(
          JSON.stringify({
            event: "wyzie_translate_http_error",
            status: upstream.status,
            mediaId,
            type,
            season: season || null,
            episode: episode || null
          })
        );

        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: `http-${upstream.status}`,
          upstreamStatus: upstream.status,
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt(
          `Wyzie respondió HTTP ${upstream.status}`
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
          reason: "too-large",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt("Subtítulo demasiado grande");
      }

      let subtitleText;

      try {
        /*
         * Esperamos el SRT completo antes de guardarlo en R2.
         * Así las siguientes solicitudes reciben un archivo completo.
         */
        subtitleText = await upstream.text();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "wyzie_translate_body_error",
            message: String(error?.message || error)
          })
        );

        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: "body-read-error",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt(
          "No se pudo leer la respuesta de Wyzie"
        );
      }

      const size = new TextEncoder()
        .encode(subtitleText)
        .byteLength;

      if (size > MAX_SUBTITLE_BYTES) {
        await this.state.storage.put("translation-state", {
          status: "failed",
          reason: "too-large",
          retryAfter: Date.now() + ERROR_RETRY_MS,
          finishedAt: Date.now()
        });

        return failureSrt("Subtítulo demasiado grande");
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

        return failureSrt(
          "Wyzie no devolvió un SRT válido"
        );
      }

      /*
       * Sólo se guarda una traducción válida.
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
              `public, max-age=${R2_CACHE_SECONDS}, immutable`
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
// ENDPOINT DE SUBTÍTULOS DEL ADDON
// =========================================================

async function handleSubtitleResource(request, env, url) {
  const media = parseSubtitleResourcePath(url.pathname);

  if (!media) {
    return jsonResponse(
      { subtitles: [] },
      404,
      { "Cache-Control": "no-store" }
    );
  }

  const translationPath = buildTranslationPath(media);
  const translationUrl = `${url.origin}${translationPath}`;

  /*
   * Para la respuesta JSON no se llama a Wyzie.
   * Solamente se devuelve el enlace a /translate.
   */
  const subtitles = [
    {
      id:
        media.type === "series"
          ? `ai-es419-${media.mediaId}-${media.season}-${media.episode}`
          : `ai-es419-${media.mediaId}`,
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
// ENDPOINT DE TRADUCCIÓN
// =========================================================

async function handleTranslation(request, env, url) {
  const media = parseTranslationPath(url.pathname);

  if (!media) {
    return failureSrt("Ruta de traducción inválida");
  }

  /*
   * HEAD no genera traducciones y no llama a Wyzie.
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
    return failureSrt("Método no permitido");
  }

  if (!env.AI_TRANSLATIONS) {
    return failureSrt("Binding AI_TRANSLATIONS no configurado");
  }

  if (!env.AI_TRANSLATION_GATE) {
    return failureSrt(
      "Binding AI_TRANSLATION_GATE no configurado"
    );
  }

  if (!env.WYZIE_API_KEY) {
    return failureSrt("WYZIE_API_KEY no configurada");
  }

  const cacheKey = buildCacheKey(media);

  /*
   * Primera comprobación de R2.
   */
  const cached = await env.AI_TRANSLATIONS.get(cacheKey);

  if (cached && await isValidR2Subtitle(cached)) {
    const body = await cached.text();

    return subtitleResponse(body, "r2-cache");
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

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

// =========================================================
// HOME / HEALTH / MANIFEST
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
  <p>Manifest:
    <a href="${url.origin}/manifest.json">
      ${url.origin}/manifest.json
    </a>
  </p>
  <p>Health:
    <a href="${url.origin}/health">
      ${url.origin}/health
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

export default {
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
        { "Cache-Control": "no-store" }
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
