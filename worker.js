import { DurableObject } from "cloudflare:workers";

const WYZIE = "https://sub.wyzie.io";
const LATAM_TARGET = "Spanish (Latin America)";

const MANIFEST = {
  id: "io.nuvio.wyzie.subtitles",
  version: "1.3.0",
  name: "Wyzie Subs Nuvio",
  description: "Wyzie subtitles for Nuvio - Spanish + protected Latin America AI",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: []
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
};


// =========================================================
// DURABLE OBJECT
//
// Una instancia por:
// película/serie + temporada + episodio + Latinoamérica
//
// Su misión:
//
// 1. permitir máximo UN intento facturable
// 2. guardar el resultado
// 3. bloquear reintentos
// =========================================================

export class AITranslationGate extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
  }


  async fetch(request) {

    const url =
      new URL(request.url);


    if (
      request.method !== "POST" ||
      url.pathname !== "/translate"
    ) {

      return new Response(
        "Not Found",
        {
          status: 404
        }
      );
    }


    let payload;


    try {

      payload =
        await request.json();

    } catch {

      return failureSrt(
        "Invalid AI request"
      );
    }


    const {
      id,
      season = "",
      episode = "",
      target = LATAM_TARGET
    } = payload || {};


    if (!id) {

      return failureSrt(
        "Missing media id"
      );
    }


    // =====================================================
    // ¿YA SE INTENTÓ?
    // =====================================================

    const meta =
      await this.ctx.storage.get(
        "meta"
      );


    // -----------------------------------------------------
    // YA FUNCIONÓ
    // -----------------------------------------------------

    if (
      meta?.status === "success"
    ) {

      return await this.getStoredSubtitle(
        meta
      );
    }


    // -----------------------------------------------------
    // YA FALLÓ
    //
    // Nunca volver a llamar a Wyzie.
    // -----------------------------------------------------

    if (
      meta?.status === "failed"
    ) {

      return failureSrt(
        meta.upstreamStatus
          ? `Wyzie error ${meta.upstreamStatus}`
          : "AI translation failed previously",
        meta
      );
    }


    // -----------------------------------------------------
    // YA SE INICIÓ UNA LLAMADA
    //
    // Tampoco repetir.
    // -----------------------------------------------------

    if (
      meta?.status === "attempted"
    ) {

      return failureSrt(
        "AI translation already attempted",
        meta
      );
    }


    // =====================================================
    // MARCAR ANTES DE CONTACTAR WYZIE
    //
    // ESTA ES LA PROTECCIÓN MÁS IMPORTANTE.
    // =====================================================

    await this.ctx.storage.put(
      "meta",
      {
        status: "attempted",

        id,
        season,
        episode,
        target,

        startedAt:
          Date.now()
      }
    );


    // =====================================================
    // CONSTRUIR /translate
    //
    // No usamos el tk temporal recibido en /search.
    //
    // La API key solamente existe dentro del Worker.
    // =====================================================

    const params =
      new URLSearchParams();


    params.set(
      "id",
      id
    );


    params.set(
      "target",
      target
    );


    params.set(
      "key",
      this.env.WYZIE_API_KEY
    );


    if (
      season &&
      episode
    ) {

      params.set(
        "season",
        season
      );


      params.set(
        "episode",
        episode
      );
    }


    console.log(
      "AI GATE: ONE Wyzie translation attempt",
      {
        id,
        season,
        episode,
        target
      }
    );


    let upstream;


    try {

      /*
        ESTE ES EL ÚNICO FETCH FACTURABLE
        A /translate EN TODO EL WORKER.
      */

      upstream =
        await fetch(
          `${WYZIE}/translate?${params.toString()}`,
          {
            method:
              "GET",

            headers: {

              Accept:
                "text/plain,text/vtt,application/x-subrip,*/*",

              "User-Agent":
                "Mozilla/5.0"
            }
          }
        );


    } catch (error) {

      await this.ctx.storage.put(
        "meta",
        {
          status:
            "failed",

          reason:
            "network-error",

          error:
            String(
              error?.message ||
              error
            ),

          finishedAt:
            Date.now()
        }
      );


      return failureSrt(
        "Wyzie network error"
      );
    }


    // =====================================================
    // WYZIE DEVUELVE ERROR
    //
    // 501 / 500 / 404 / etc.
    //
    // Guardamos el error.
    // No volveremos a llamar a Wyzie.
    // =====================================================

    if (
      !upstream.ok
    ) {

      let errorText =
        "";


      try {

        errorText =
          await upstream.text();

      } catch {}


      const failedMeta = {

        status:
          "failed",

        upstreamStatus:
          upstream.status,

        error:
          errorText.slice(
            0,
            1000
          ),

        finishedAt:
          Date.now()
      };


      await this.ctx.storage.put(
        "meta",
        failedMeta
      );


      console.error(
        "Wyzie AI error:",
        upstream.status,
        errorText
      );


      /*
        IMPORTANTE:

        Respondemos 200 a Nuvio.

        No dejamos que vea 501,
        porque podría reintentar.
      */

      return failureSrt(
        `Wyzie error ${upstream.status}`,
        failedMeta
      );
    }


    // =====================================================
    // TERMINAR LA TRADUCCIÓN COMPLETA
    // =====================================================

    let buffer;


    try {

      buffer =
        await upstream.arrayBuffer();

    } catch (error) {

      const failedMeta = {

        status:
          "failed",

        reason:
          "body-read-error",

        error:
          String(
            error?.message ||
            error
          ),

        finishedAt:
          Date.now()
      };


      await this.ctx.storage.put(
        "meta",
        failedMeta
      );


      return failureSrt(
        "Could not read AI subtitle",
        failedMeta
      );
    }


    const bytes =
      new Uint8Array(
        buffer
      );


    // =====================================================
    // GUARDAR SRT EN CHUNKS
    // =====================================================

    const CHUNK_SIZE =
      48 * 1024;


    let chunkCount =
      0;


    for (
      let offset = 0;
      offset < bytes.length;
      offset += CHUNK_SIZE
    ) {

      const chunk =
        bytes.slice(
          offset,
          Math.min(
            offset + CHUNK_SIZE,
            bytes.length
          )
        );


      await this.ctx.storage.put(
        `chunk:${chunkCount}`,
        chunk
      );


      chunkCount++;
    }


    // =====================================================
    // SUCCESS
    // =====================================================

    const successMeta = {

      status:
        "success",

      id,
      season,
      episode,
      target,

      chunkCount,

      contentType:
        upstream.headers.get(
          "Content-Type"
        ) ||
        "text/plain; charset=utf-8",

      finishedAt:
        Date.now()
    };


    await this.ctx.storage.put(
      "meta",
      successMeta
    );


    return await this.getStoredSubtitle(
      successMeta
    );
  }


  // =======================================================
  // DEVOLVER SRT GUARDADO
  // =======================================================

  async getStoredSubtitle(meta) {

    const chunks =
      [];


    for (
      let i = 0;
      i < meta.chunkCount;
      i++
    ) {

      const chunk =
        await this.ctx.storage.get(
          `chunk:${i}`
        );


      if (chunk) {

        chunks.push(
          chunk
        );
      }
    }


    const blob =
      new Blob(
        chunks,
        {
          type:
            meta.contentType ||
            "text/plain; charset=utf-8"
        }
      );


    return new Response(
      blob,
      {
        status:
          200,

        headers: {

          "Content-Type":
            meta.contentType ||
            "text/plain; charset=utf-8",

          "Content-Disposition":
            "inline; filename=\"latino-america-ai.srt\"",

          "Cache-Control":
            "public, max-age=31536000",

          "X-AI-Gate":
            "cached-success"
        }
      }
    );
  }
}


// =========================================================
// MAIN WORKER
// =========================================================

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );


    // =====================================================
    // CORS
    // =====================================================

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status:
            204,

          headers:
            CORS
        }
      );
    }


    // =====================================================
    // HEALTH
    // =====================================================

    if (
      url.pathname ===
      "/health"
    ) {

      return json({

        ok:
          true,

        version:
          MANIFEST.version,

        apiKeyConfigured:
          Boolean(
            env.WYZIE_API_KEY
          ),

        aiGateConfigured:
          Boolean(
            env.AI_GATE
          )
      });
    }


    // =====================================================
    // MANIFEST
    // =====================================================

    if (
      url.pathname === "/" ||
      url.pathname ===
        "/manifest.json"
    ) {

      return json(
        MANIFEST
      );
    }


    // =====================================================
    // DEBUG NORMAL
    //
    // MISMA BÚSQUEDA NORMAL DE TU V1.2.1
    // =====================================================

    if (
      url.pathname ===
      "/debug"
    ) {

      if (
        !env.WYZIE_API_KEY
      ) {

        return json(
          {
            ok:
              false,

            error:
              "WYZIE_API_KEY missing"
          },
          500
        );
      }


      const id =
        url.searchParams.get(
          "id"
        );


      if (!id) {

        return json(
          {
            ok:
              false,

            error:
              "Use ?id=IMDB_OR_TMDB"
          },
          400
        );
      }


      const season =
        url.searchParams.get(
          "season"
        );


      const episode =
        url.searchParams.get(
          "episode"
        );


      const sources =
        await getSources(
          env.WYZIE_API_KEY
        );


      const params =
        new URLSearchParams();


      params.set(
        "id",
        normalizeId(
          id
        )
      );


      params.set(
        "language",
        "es"
      );


      params.set(
        "key",
        env.WYZIE_API_KEY
      );


      if (
        season &&
        episode
      ) {

        params.set(
          "season",
          season
        );


        params.set(
          "episode",
          episode
        );
      }


      if (
        sources.length
      ) {

        params.set(
          "source",
          sources.join(",")
        );
      }


      const response =
        await fetch(
          `${WYZIE}/search?${params.toString()}`
        );


      const text =
        await response.text();


      let data;


      try {

        data =
          JSON.parse(
            text
          );

      } catch {

        data =
          text;
      }


      return json({

        ok:
          response.ok,

        status:
          response.status,

        sources,

        resultCount:
          Array.isArray(
            data
          )
            ? data.length
            : null,

        data
      });
    }


    // =====================================================
    // DEBUG LATINOAMÉRICA
    // =====================================================

    if (
      url.pathname ===
      "/debug-ai"
    ) {

      if (
        !env.WYZIE_API_KEY
      ) {

        return json(
          {
            ok:
              false,

            error:
              "WYZIE_API_KEY missing"
          },
          500
        );
      }


      const id =
        url.searchParams.get(
          "id"
        );


      if (!id) {

        return json(
          {
            ok:
              false,

            error:
              "Use ?id=IMDB_OR_TMDB"
          },
          400
        );
      }


      const season =
        url.searchParams.get(
          "season"
        );


      const episode =
        url.searchParams.get(
          "episode"
        );


      const params =
        new URLSearchParams();


      params.set(
        "id",
        normalizeId(
          id
        )
      );


      params.set(
        "language",
        "es"
      );


      params.set(
        "key",
        env.WYZIE_API_KEY
      );


      if (
        season &&
        episode
      ) {

        params.set(
          "season",
          season
        );


        params.set(
          "episode",
          episode
        );
      }


      /*
        NO SOURCE.

        Así Wyzie devuelve sus idiomas IA.
      */

      const response =
        await fetch(
          `${WYZIE}/search?${params.toString()}`,
          {
            headers: {

              Accept:
                "application/json"
            }
          }
        );


      const data =
        response.ok
          ? await response.json()
          : [];


      const latam =
        Array.isArray(
          data
        )
          ? data.find(
              sub => {

                return (

                  sub?.ai === true &&

                  (

                    String(
                      sub.language ||
                      ""
                    ).toLowerCase() ===
                      "es-419" ||

                    String(
                      sub.id ||
                      ""
                    ).toLowerCase() ===
                      "ai-es-419" ||

                    String(
                      sub.display ||
                      ""
                    ).toLowerCase() ===
                      "spanish (latin america)"
                  )
                );
              }
            )

          : null;


      return json({

        ok:
          response.ok,

        status:
          response.status,

        latamFound:
          Boolean(
            latam
          ),

        latam:
          latam
            ? {

                id:
                  latam.id,

                language:
                  latam.language,

                display:
                  latam.display,

                source:
                  latam.source
              }

            : null
      });
    }


    // =====================================================
    // LATINOAMÉRICA IA PROTEGIDO
    // =====================================================

    if (
      url.pathname ===
      "/ai-sub"
    ) {

      if (
        !env.WYZIE_API_KEY ||
        !env.AI_GATE
      ) {

        return failureSrt(
          "AI protection unavailable"
        );
      }


      const id =
        url.searchParams.get(
          "id"
        );


      const season =
        url.searchParams.get(
          "season"
        ) || "";


      const episode =
        url.searchParams.get(
          "episode"
        ) || "";


      const sig =
        url.searchParams.get(
          "sig"
        );


      if (
        !id ||
        !sig
      ) {

        return failureSrt(
          "Invalid AI URL"
        );
      }


      const payload =
        buildAiPayload(
          id,
          season,
          episode
        );


      const valid =
        await verifySignature(
          env.WYZIE_API_KEY,
          payload,
          sig
        );


      if (!valid) {

        return failureSrt(
          "Invalid AI signature"
        );
      }


      // ===================================================
      // HEAD
      //
      // NO CONTACTA WYZIE.
      // NO GASTA 100.
      // ===================================================

      if (
        request.method ===
        "HEAD"
      ) {

        return new Response(
          null,
          {
            status:
              200,

            headers: {

              ...CORS,

              "Content-Type":
                "text/plain; charset=utf-8",

              "Content-Disposition":
                "inline",

              "X-AI-Gate":
                "HEAD-NO-CHARGE"
            }
          }
        );
      }


      // ===================================================
      // GET
      //
      // SELECCIÓN DEL SUBTÍTULO.
      // ===================================================

      const gateName =
        [
          "latam",
          id,
          season,
          episode
        ].join("|");


      /*
        Cloudflare manda siempre ese nombre
        a la misma instancia del Durable Object.
      */

      const stub =
        env.AI_GATE.getByName(
          gateName
        );


      const gateResponse =
        await stub.fetch(
          new Request(
            "https://ai-gate/translate",
            {
              method:
                "POST",

              headers: {

                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({

                  id,

                  season,

                  episode,

                  target:
                    LATAM_TARGET
                })
            }
          )
        );


      const headers =
        new Headers(
          gateResponse.headers
        );


      headers.set(
        "Access-Control-Allow-Origin",
        "*"
      );


      headers.set(
        "Access-Control-Allow-Methods",
        "GET, HEAD, OPTIONS"
      );


      return new Response(
        gateResponse.body,
        {
          /*
            Aunque internamente Wyzie haya dado 501,
            Nuvio recibe 200 y no inicia reintentos.
          */

          status:
            200,

          headers
        }
      );
    }


    // =====================================================
    // PROXY NORMAL
    //
    // MISMO COMPORTAMIENTO DE TU V1.2.1
    // =====================================================

    if (
      url.pathname ===
      "/proxy"
    ) {

      if (
        !env.WYZIE_API_KEY
      ) {

        return new Response(
          "Worker not configured",
          {
            status:
              500,

            headers:
              CORS
          }
        );
      }


      const target =
        url.searchParams.get(
          "url"
        );


      const sig =
        url.searchParams.get(
          "sig"
        );


      if (
        !target ||
        !sig
      ) {

        return new Response(
          "Missing URL or signature",
          {
            status:
              400,

            headers:
              CORS
          }
        );
      }


      const valid =
        await verifySignature(
          env.WYZIE_API_KEY,
          target,
          sig
        );


      if (!valid) {

        return new Response(
          "Invalid signature",
          {
            status:
              403,

            headers:
              CORS
          }
        );
      }


      let parsed;


      try {

        parsed =
          new URL(
            target
          );

      } catch {

        return new Response(
          "Invalid URL",
          {
            status:
              400,

            headers:
              CORS
          }
        );
      }


      if (
        parsed.protocol !==
        "https:"
      ) {

        return new Response(
          "HTTPS required",
          {
            status:
              403,

            headers:
              CORS
          }
        );
      }


      if (
        request.method ===
        "HEAD"
      ) {

        return new Response(
          null,
          {
            status:
              200,

            headers: {

              ...CORS,

              "Content-Type":
                "text/plain; charset=utf-8",

              "Content-Disposition":
                "inline"
            }
          }
        );
      }


      try {

        const upstream =
          await fetch(
            parsed.toString(),
            {
              redirect:
                "follow",

              headers: {

                "User-Agent":
                  "Mozilla/5.0",

                Accept:
                  "text/plain,text/vtt,application/x-subrip,*/*"
              }
            }
          );


        if (
          !upstream.ok
        ) {

          return new Response(
            `Subtitle provider error: ${upstream.status}`,
            {
              status:
                upstream.status,

              headers:
                CORS
            }
          );
        }


        const headers =
          new Headers();


        headers.set(
          "Access-Control-Allow-Origin",
          "*"
        );


        headers.set(
          "Access-Control-Allow-Methods",
          "GET, HEAD, OPTIONS"
        );


        headers.set(
          "Content-Disposition",
          "inline"
        );


        headers.set(
          "Cache-Control",
          "public, max-age=86400"
        );


        headers.set(
          "Content-Type",
          upstream.headers.get(
            "Content-Type"
          ) ||
          guessSubtitleContentType(
            parsed.pathname
          )
        );


        return new Response(
          upstream.body,
          {
            status:
              200,

            headers
          }
        );


      } catch (error) {

        console.error(
          "Proxy error:",
          error
        );


        return new Response(
          "Subtitle download failed",
          {
            status:
              502,

            headers:
              CORS
          }
        );
      }
    }


    // =====================================================
    // SUBTITLES
    // =====================================================

    if (
      url.pathname.startsWith(
        "/subtitles/"
      )
    ) {

      if (
        !env.WYZIE_API_KEY
      ) {

        return json({
          subtitles:
            []
        });
      }


      try {

        const path =
          url.pathname
            .replace(
              /\.json$/,
              ""
            )
            .split("/")
            .filter(
              Boolean
            );


        if (
          path.length < 3
        ) {

          return json({
            subtitles:
              []
          });
        }


        const type =
          safeDecode(
            path[1]
          );


        const rawId =
          safeDecode(
            path[2]
          );


        const media =
          parseVideoId(
            rawId
          );


        if (
          !media.id
        ) {

          return json({
            subtitles:
              []
          });
        }


        // =============================================
        // AVAILABLE SOURCES
        //
        // EXACTAMENTE COMO V1.2.1
        // =============================================

        const sources =
          await getSources(
            env.WYZIE_API_KEY
          );


        // =============================================
        // NORMAL SPANISH SEARCH
        //
        // EXACTAMENTE COMO V1.2.1
        // =============================================

        const params =
          new URLSearchParams();


        params.set(
          "id",
          media.id
        );


        params.set(
          "language",
          "es"
        );


        params.set(
          "key",
          env.WYZIE_API_KEY
        );


        if (
          media.season &&
          media.episode
        ) {

          params.set(
            "season",
            media.season
          );


          params.set(
            "episode",
            media.episode
          );
        }


        if (
          sources.length
        ) {

          params.set(
            "source",
            sources.join(",")
          );
        }


        const searchUrl =
          `${WYZIE}/search?` +
          params.toString();


        const response =
          await fetch(
            searchUrl,
            {
              headers: {

                Accept:
                  "application/json"
              }
            }
          );


        if (
          !response.ok
        ) {

          return new Response(
            JSON.stringify({
              subtitles:
                []
            }),
            {
              status:
                200,

              headers: {

                ...CORS,

                "Content-Type":
                  "application/json; charset=utf-8",

                "X-Wyzie-Error":
                  String(
                    response.status
                  )
              }
            }
          );
        }


        const normalResults =
          await response.json();


        if (
          !Array.isArray(
            normalResults
          )
        ) {

          return json({
            subtitles:
              []
          });
        }


        // =============================================
        // ONLY DISCOVER es-419
        //
        // NO AÑADIMOS LOS OTROS 20 IDIOMAS.
        // =============================================

        let latamAvailable =
          false;


        try {

          const aiParams =
            new URLSearchParams();


          aiParams.set(
            "id",
            media.id
          );


          aiParams.set(
            "language",
            "es"
          );


          aiParams.set(
            "key",
            env.WYZIE_API_KEY
          );


          if (
            media.season &&
            media.episode
          ) {

            aiParams.set(
              "season",
              media.season
            );


            aiParams.set(
              "episode",
              media.episode
            );
          }


          /*
            NO source.
          */

          const aiResponse =
            await fetch(
              `${WYZIE}/search?${aiParams.toString()}`,
              {
                headers: {

                  Accept:
                    "application/json"
                }
              }
            );


          if (
            aiResponse.ok
          ) {

            const aiData =
              await aiResponse.json();


            if (
              Array.isArray(
                aiData
              )
            ) {

              latamAvailable =
                aiData.some(
                  sub => {

                    return (

                      sub?.ai === true &&

                      (

                        String(
                          sub.language ||
                          ""
                        ).toLowerCase() ===
                          "es-419" ||

                        String(
                          sub.id ||
                          ""
                        ).toLowerCase() ===
                          "ai-es-419" ||

                        String(
                          sub.display ||
                          ""
                        ).toLowerCase() ===
                          "spanish (latin america)"
                      )
                    );
                  }
                );
            }
          }


        } catch (error) {

          /*
            La IA nunca puede romper
            los subtítulos normales.
          */

          console.log(
            "LatAm AI discovery failed:",
            error
          );
        }


        // =============================================
        // BUILD RESPONSE
        // =============================================

        const subtitles =
          [];


        // =============================================
        // TODOS LOS RESULTADOS NORMALES
        //
        // MISMO ORDEN Y MISMA CANTIDAD
        // QUE DEVUELVE TU BÚSQUEDA NORMAL.
        // =============================================

        for (
          let i = 0;
          i < normalResults.length;
          i++
        ) {

          const sub =
            normalResults[i];


          if (
            !sub?.url
          ) {

            continue;
          }


          /*
            En principio la búsqueda por source
            no debería traer IA.

            Si ocurriera, no la presentamos
            como subtítulo normal.
          */

          const isAi =

            sub.ai === true ||

            String(
              sub.source ||
              ""
            ).toLowerCase() ===
              "ai" ||

            String(
              sub.url ||
              ""
            ).includes(
              "/translate"
            );


          if (isAi) {

            continue;
          }


          const targetUrl =
            String(
              sub.url
            );


          const signature =
            await createSignature(
              env.WYZIE_API_KEY,
              targetUrl
            );


          const proxyUrl =
            `${url.origin}/proxy` +
            `?url=${encodeURIComponent(targetUrl)}` +
            `&sig=${encodeURIComponent(signature)}`;


          subtitles.push({

            id:
              `wyzie-${sub.id || i}`,

            url:
              proxyUrl,

            lang:
              "spa"
          });
        }


        // =============================================
        // UNA SOLA OPCIÓN:
        //
        // ESPAÑOL LATINOAMÉRICA IA
        // =============================================

        if (
          latamAvailable
        ) {

          const payload =
            buildAiPayload(
              media.id,
              media.season,
              media.episode
            );


          const signature =
            await createSignature(
              env.WYZIE_API_KEY,
              payload
            );


          const aiParams =
            new URLSearchParams();


          aiParams.set(
            "id",
            media.id
          );


          if (
            media.season
          ) {

            aiParams.set(
              "season",
              media.season
            );
          }


          if (
            media.episode
          ) {

            aiParams.set(
              "episode",
              media.episode
            );
          }


          aiParams.set(
            "sig",
            signature
          );


          subtitles.push({

            id:
              "wyzie-ai-es-419",

            url:
              `${url.origin}/ai-sub?${aiParams.toString()}`,

            lang:
              "Español Latinoamérica (IA)"
          });
        }


        return new Response(
          JSON.stringify({
            subtitles
          }),
          {
            status:
              200,

            headers: {

              ...CORS,

              "Content-Type":
                "application/json; charset=utf-8",

              "Cache-Control":
                "no-store",

              "X-Normal-Count":
                String(
                  normalResults.length
                ),

              "X-Latam-AI":
                latamAvailable
                  ? "1"
                  : "0",

              "X-Media-ID":
                media.id,

              "X-Media-Type":
                type
            }
          }
        );


      } catch (error) {

        console.error(
          "Subtitle search error:",
          error
        );


        return json({
          subtitles:
            []
        });
      }
    }


    return json(
      {
        error:
          "Not Found"
      },
      404
    );
  }
};


// =========================================================
// LATAM SIGNATURE PAYLOAD
// =========================================================

function buildAiPayload(
  id,
  season,
  episode
) {

  return [
    "latam-ai",
    id,
    season || "",
    episode || "",
    LATAM_TARGET
  ].join("|");
}


// =========================================================
// FAILURE SRT
//
// Siempre devolvemos HTTP 200.
//
// Así un error interno de Wyzie no provoca
// una cadena de reintentos en Nuvio.
// =========================================================

function failureSrt(
  reason =
    "AI unavailable",
  meta =
    null
) {

  const body =
    "1\n" +
    "00:00:00,000 --> 00:00:00,001\n" +
    " \n";


  return new Response(
    body,
    {
      status:
        200,

      headers: {

        ...CORS,

        "Content-Type":
          "text/plain; charset=utf-8",

        "Content-Disposition":
          "inline; filename=\"latino-america-ai.srt\"",

        "Cache-Control":
          "public, max-age=31536000",

        "X-AI-Gate":
          "blocked",

        "X-AI-Reason":
          String(
            reason
          ),

        "X-Wyzie-Status":
          meta?.upstreamStatus
            ? String(
                meta.upstreamStatus
              )
            : ""
      }
    }
  );
}


// =========================================================
// SOURCES
//
// ORIGINAL V1.2.1
// =========================================================

async function getSources(
  key
) {

  try {

    const response =
      await fetch(
        `${WYZIE}/sources?key=` +
        encodeURIComponent(
          key
        )
      );


    if (
      !response.ok
    ) {

      return [];
    }


    const data =
      await response.json();


    if (
      Array.isArray(
        data.available
      )
    ) {

      return data.available;
    }


    if (
      Array.isArray(
        data.sources
      )
    ) {

      return data.sources;
    }


    return [];


  } catch {

    return [];
  }
}


// =========================================================
// VIDEO ID
// =========================================================

function parseVideoId(
  value
) {

  const decoded =
    safeDecode(
      value
    );


  const parts =
    decoded.split(":");


  let id =
    "";


  let season =
    "";


  let episode =
    "";


  if (
    parts[0]?.toLowerCase() ===
    "tmdb"
  ) {

    if (
      [
        "tv",
        "series",
        "movie"
      ].includes(
        String(
          parts[1]
        ).toLowerCase()
      )
    ) {

      id =
        parts[2] ||
        "";


      season =
        parts[3] ||
        "";


      episode =
        parts[4] ||
        "";

    } else {

      id =
        parts[1] ||
        "";


      season =
        parts[2] ||
        "";


      episode =
        parts[3] ||
        "";
    }
  }


  else if (
    parts[0]?.toLowerCase() ===
    "imdb"
  ) {

    id =
      parts[1] ||
      "";


    season =
      parts[2] ||
      "";


    episode =
      parts[3] ||
      "";
  }


  else {

    id =
      parts[0] ||
      "";


    season =
      parts[1] ||
      "";


    episode =
      parts[2] ||
      "";
  }


  id =
    normalizeId(
      id
    );


  const valid =

    /^tt\d+$/i.test(
      id
    ) ||

    /^\d+$/.test(
      id
    );


  if (
    !valid
  ) {

    return {

      id:
        "",

      season:
        "",

      episode:
        ""
    };
  }


  return {

    id,

    season:

      /^\d+$/.test(
        season
      )
        ? season
        : "",

    episode:

      /^\d+$/.test(
        episode
      )
        ? episode
        : ""
  };
}


// =========================================================
// CRYPTO
// =========================================================

async function createSignature(
  secret,
  value
) {

  const encoder =
    new TextEncoder();


  const key =
    await crypto.subtle.importKey(
      "raw",

      encoder.encode(
        secret
      ),

      {
        name:
          "HMAC",

        hash:
          "SHA-256"
      },

      false,

      [
        "sign"
      ]
    );


  const signature =
    await crypto.subtle.sign(
      "HMAC",

      key,

      encoder.encode(
        value
      )
    );


  return bufferToBase64Url(
    signature
  );
}


async function verifySignature(
  secret,
  value,
  suppliedSignature
) {

  try {

    const expected =
      await createSignature(
        secret,
        value
      );


    const encoder =
      new TextEncoder();


    const [
      expectedHash,
      suppliedHash
    ] =
      await Promise.all(
        [

          crypto.subtle.digest(
            "SHA-256",

            encoder.encode(
              expected
            )
          ),


          crypto.subtle.digest(
            "SHA-256",

            encoder.encode(
              suppliedSignature
            )
          )
        ]
      );


    return crypto.subtle.timingSafeEqual(
      expectedHash,
      suppliedHash
    );


  } catch {

    return false;
  }
}


function bufferToBase64Url(
  buffer
) {

  const bytes =
    new Uint8Array(
      buffer
    );


  let binary =
    "";


  for (
    const byte of bytes
  ) {

    binary +=
      String.fromCharCode(
        byte
      );
  }


  return btoa(
    binary
  )
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/g,
      ""
    );
}


// =========================================================
// HELPERS
// =========================================================

function safeDecode(
  value
) {

  try {

    return decodeURIComponent(
      value
    );

  } catch {

    return value;
  }
}


function normalizeId(
  id
) {

  return String(
    id ||
    ""
  ).trim();
}


function guessSubtitleContentType(
  pathname
) {

  const path =
    String(
      pathname
    ).toLowerCase();


  if (
    path.endsWith(
      ".vtt"
    )
  ) {

    return (
      "text/vtt; charset=utf-8"
    );
  }


  if (
    path.endsWith(
      ".ass"
    ) ||

    path.endsWith(
      ".ssa"
    )
  ) {

    return (
      "text/plain; charset=utf-8"
    );
  }


  return (
    "text/plain; charset=utf-8"
  );
}


function json(
  value,
  status = 200
) {

  return new Response(
    JSON.stringify(
      value
    ),
    {
      status,

      headers: {

        ...CORS,

        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}
