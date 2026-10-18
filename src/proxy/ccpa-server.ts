import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import {
  buildCloudCodeSseChunk,
  buildSyntheticMonitorResponse,
  compileGeminiWebTurnWithFallback,
  deriveConversationSessionKey,
  isBackgroundHelperRequest,
  isInternalMonitorRequest,
  unwrapCloudCodeRequest,
} from "../protocol/tool-protocol.js";
import type {
  CloudCodeGenerateContentRequest,
  CloudCodeGenerateContentResponse,
  GeminiContent,
  GeminiPart,
  GeminiWebDriver,
} from "../types.js";

export interface CcpaBridgeServerOptions {
  host?: string;
  port?: number;
  upstreamBaseUrl?: string;
  mode?: "bridge" | "sniff";
  captureFilePath?: string;
  driver?: GeminiWebDriver;
  passthroughNonStreamingGenerate?: boolean;
  inlineThresholdChars?: number;
  onLog?: (message: string) => void;
}

export interface CcpaBridgeServerHandle {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function startCcpaBridgeServer(
  options: CcpaBridgeServerOptions = {},
): Promise<CcpaBridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  const upstreamBaseUrl = (
    options.upstreamBaseUrl ??
    process.env.AGY_UPSTREAM_CCPA_URL ??
    "https://daily-cloudcode-pa.googleapis.com"
  ).replace(/\/+$/, "");
  const mode = options.mode ?? "bridge";
  const log = options.onLog ?? ((msg: string) => console.log(`[ccpa-bridge] ${msg}`));

  // Retained session history map: sessionKey -> last contentsSnapshot
  const sessionHistory = new Map<string, GeminiContent[]>();

  async function recordCaptureEntry(entry: Record<string, unknown>): Promise<void> {
    if (!options.captureFilePath) {
      return;
    }
    try {
      await mkdir(path.dirname(options.captureFilePath), { recursive: true });
      await appendFile(
        options.captureFilePath,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
        "utf8",
      );
    } catch (err) {
      log(`capture write warning: ${(err as Error).message}`);
    }
  }

  async function proxyToUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
  ): Promise<void> {
    const reqUrl = req.url ?? "/";
    const targetUrl = `${upstreamBaseUrl}${reqUrl.startsWith("/") ? reqUrl : `/${reqUrl}`}`;

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        continue;
      }
      forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: req.method ?? "POST",
        headers: forwardHeaders,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : new Uint8Array(rawBody),
      });

      const responseHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((val, key) => {
        if (
          !HOP_BY_HOP_HEADERS.has(key.toLowerCase()) &&
          key.toLowerCase() !== "content-encoding"
        ) {
          responseHeaders[key] = val;
        }
      });

      res.writeHead(upstreamRes.status, responseHeaders);

      if (!upstreamRes.body) {
        res.end();
        return;
      }

      const capturedChunks: Buffer[] = [];
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (options.captureFilePath) {
          capturedChunks.push(buf);
        }
        res.write(buf);
      }
      res.end();

      if (options.captureFilePath) {
        await recordCaptureEntry({
          type: "passthrough",
          method: req.method,
          url: reqUrl,
          status: upstreamRes.status,
          requestBody: rawBody.toString("utf8").slice(0, 50_000),
          responseBody: Buffer.concat(capturedChunks).toString("utf8").slice(0, 50_000),
        });
      }
    } catch (err) {
      // Fallback for quota endpoints when offline or unauthenticated
      if (reqUrl.includes("retrieveUserQuota")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ buckets: [] }));
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: 502,
            message: `Upstream Cloud Code PA proxy error: ${(err as Error).message}`,
          },
        }),
      );
    }
  }

  async function handleStreamGenerateContent(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
  ): Promise<void> {
    if (mode === "sniff") {
      await proxyToUpstream(req, res, rawBody);
      return;
    }

    let payload: CloudCodeGenerateContentRequest;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as CloudCodeGenerateContentRequest;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: "Invalid JSON body" } }));
      return;
    }

    const traceId = `0x${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const responseId = `agyweb_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    // Fast-path internal safety monitor (`sir_flash_lite`)
    if (isInternalMonitorRequest(payload)) {
      log(`fast-pathing internal safety monitor request (model=${payload.model ?? "unknown"})`);
      const monitorResp = buildSyntheticMonitorResponse(traceId);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(monitorResp)}\n\n`);
      res.end();
      return;
    }

    // Pass tool-less flash-lite background helper calls (e.g. title generation) to upstream CCPA
    if (isBackgroundHelperRequest(payload)) {
      log(`forwarding background helper request to upstream CCPA (model=${payload.model ?? "unknown"})`);
      await proxyToUpstream(req, res, rawBody);
      return;
    }

    if (!options.driver) {
      await proxyToUpstream(req, res, rawBody);
      return;
    }

    const { inner, model } = unwrapCloudCodeRequest(payload);
    const sessionKey = deriveConversationSessionKey(inner);
    const previousContents = sessionHistory.get(sessionKey);

    const compiledTurn = compileGeminiWebTurnWithFallback(payload, {
      previousContents,
      sessionKeyOverride: sessionKey,
      inlineThresholdChars: options.inlineThresholdChars,
    });

    log(
      `bridging streamGenerateContent -> Gemini Web (mode=${compiledTurn.mode}, session=${sessionKey.slice(0, 8)}, model=${model}, tools=${compiledTurn.expectedToolNames.length})`,
    );

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    let emittedAnyTextDelta = false;

    try {
      const output = await options.driver.executeTurn(compiledTurn, {
        model,
        signal: abortController.signal,
        onEvent(event) {
          if (res.writableEnded) {
            return;
          }
          if (event.type === "thought_delta" && event.delta) {
            res.write(
              buildCloudCodeSseChunk(
                [{ thought: true, text: event.delta }],
                { traceId, responseId },
              ),
            );
          } else if (event.type === "text_delta" && event.delta) {
            emittedAnyTextDelta = true;
            res.write(
              buildCloudCodeSseChunk([{ text: event.delta }], {
                traceId,
                responseId,
              }),
            );
          }
        },
      });

      sessionHistory.set(sessionKey, compiledTurn.contentsSnapshot);

      const finalParts: GeminiPart[] = [];
      if (!emittedAnyTextDelta && output.visibleText) {
        finalParts.push({ text: output.visibleText });
      }

      if (output.toolCalls.length > 0) {
        for (const tc of output.toolCalls) {
          finalParts.push({
            functionCall: {
              id: tc.id,
              name: tc.name,
              args: tc.args,
            },
          });
        }
      }

      if (finalParts.length === 0) {
        if (!emittedAnyTextDelta) {
          finalParts.push({
            text:
              output.thoughtText ||
              "(Gemini Web 응답이 비어 있습니다. 다시 시도해 주세요.)",
          });
        } else {
          finalParts.push({ text: "" });
        }
      }

      res.write(
        buildCloudCodeSseChunk(finalParts, {
          finishReason: "STOP",
          traceId,
          responseId,
          includeUsage: true,
        }),
      );
      res.end();

      await recordCaptureEntry({
        type: "bridged_stream",
        mode: compiledTurn.mode,
        executedMode: output.executedMode ?? compiledTurn.mode,
        sessionKey,
        model,
        toolCalls: output.toolCalls.map((t) => ({ name: t.name, args: t.args })),
        visibleTextPreview: output.visibleText.slice(0, 500),
      });
    } catch (err) {
      log(`streamGenerateContent error: ${(err as Error).message}`);
      if (!res.writableEnded) {
        res.write(
          buildCloudCodeSseChunk(
            [{ text: `\n\n[Gemini Web Bridge Error: ${(err as Error).message}]` }],
            {
              finishReason: "STOP",
              traceId,
              responseId,
              includeUsage: true,
            },
          ),
        );
        res.end();
      }
    }
  }

  async function handleGenerateContent(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
  ): Promise<void> {
    if (mode === "sniff") {
      await proxyToUpstream(req, res, rawBody);
      return;
    }

    let payload: CloudCodeGenerateContentRequest;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as CloudCodeGenerateContentRequest;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: "Invalid JSON body" } }));
      return;
    }

    if (isInternalMonitorRequest(payload)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildSyntheticMonitorResponse()));
      return;
    }

    if (options.passthroughNonStreamingGenerate || !options.driver) {
      await proxyToUpstream(req, res, rawBody);
      return;
    }

    const { inner, model } = unwrapCloudCodeRequest(payload);
    const sessionKey = deriveConversationSessionKey(inner);
    const compiledTurn = compileGeminiWebTurnWithFallback(payload, {
      previousContents: sessionHistory.get(sessionKey),
      sessionKeyOverride: sessionKey,
      inlineThresholdChars: options.inlineThresholdChars,
    });

    try {
      const output = await options.driver.executeTurn(compiledTurn, { model });
      sessionHistory.set(sessionKey, compiledTurn.contentsSnapshot);

      const parts: GeminiPart[] = [];
      if (output.thoughtText) {
        parts.push({ thought: true, text: output.thoughtText });
      }
      if (output.visibleText) {
        parts.push({ text: output.visibleText });
      }
      for (const tc of output.toolCalls) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.name,
            args: tc.args,
          },
        });
      }
      if (parts.length === 0) {
        parts.push({ text: "" });
      }

      const responsePayload: CloudCodeGenerateContentResponse = {
        response: {
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts,
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 128,
            candidatesTokenCount: 64,
            totalTokenCount: 192,
          },
        },
        traceId: `0x${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsePayload));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: 500, message: (err as Error).message },
        }),
      );
    }
  }

  const server = http.createServer(async (req, res) => {
    const reqUrl = req.url ?? "/";

    if (req.method === "GET" && reqUrl === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          mode,
          activeSessions: sessionHistory.size,
          upstreamBaseUrl,
        }),
      );
      return;
    }

    const rawBody = await readRequestBody(req);

    if (req.method === "POST" && reqUrl.includes(":streamGenerateContent")) {
      await handleStreamGenerateContent(req, res, rawBody);
      return;
    }

    if (req.method === "POST" && reqUrl.includes(":generateContent")) {
      await handleGenerateContent(req, res, rawBody);
      return;
    }

    await proxyToUpstream(req, res, rawBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort =
    typeof addr === "object" && addr !== null ? addr.port : requestedPort;

  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
