import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  startCcpaBridgeServer,
  type CcpaBridgeServerHandle,
} from "../src/proxy/ccpa-server.js";
import type {
  CloudCodeGenerateContentResponse,
  CompiledGeminiWebTurn,
  GeminiWebDriver,
} from "../src/types.js";

function parseSseFrames(rawSse: string): CloudCodeGenerateContentResponse[] {
  return rawSse
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.slice("data:".length).trim()));
}

describe("ccpa-server", () => {
  const handles: CcpaBridgeServerHandle[] = [];
  const auxServers: http.Server[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.pop()!;
      await h.close();
    }
    while (auxServers.length > 0) {
      const s = auxServers.pop()!;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("bridges a multi-turn tool call loop over SSE and reuses session state for incremental turns", async () => {
    const recordedTurns: CompiledGeminiWebTurn[] = [];

    const mockDriver: GeminiWebDriver = {
      async executeTurn(turn, options) {
        recordedTurns.push(turn);
        if (recordedTurns.length === 1) {
          options?.onEvent?.({
            type: "thought_delta",
            delta: "Need to inspect README.md first.",
          });
          options?.onEvent?.({
            type: "text_delta",
            delta: "Reading README.md...",
          });
          return {
            visibleText: "Reading README.md...",
            thoughtText: "Need to inspect README.md first.",
            toolCalls: [
              {
                id: "call_readme_1",
                name: "view_file",
                args: { AbsolutePath: "c:/repo/README.md" },
                rawBlock: '<antigravity_tool_call>{"name":"view_file"}</antigravity_tool_call>',
              },
            ],
          };
        }

        options?.onEvent?.({
          type: "text_delta",
          delta: "The README title is # Demo Project.",
        });
        return {
          visibleText: "The README title is # Demo Project.",
          thoughtText: "",
          toolCalls: [],
        };
      },
    };

    const bridge = await startCcpaBridgeServer({
      port: 0,
      driver: mockDriver,
      onLog: () => undefined,
    });
    handles.push(bridge);

    const tools = [
      {
        functionDeclarations: [
          {
            name: "view_file",
            description: "View file",
            parameters: { type: "object", properties: { AbsolutePath: { type: "string" } } },
          },
        ],
      },
    ];

    // Turn 1: initial user request
    const res1 = await fetch(
      `${bridge.url}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          request: {
            systemInstruction: { parts: [{ text: "You are Antigravity." }] },
            tools,
            contents: [
              {
                role: "user",
                parts: [{ text: "What is the README title?" }],
              },
            ],
          },
        }),
      },
    );

    expect(res1.status).toBe(200);
    const frames1 = parseSseFrames(await res1.text());
    expect(frames1.length).toBeGreaterThanOrEqual(3);

    const lastFrame1 = frames1[frames1.length - 1];
    const parts1 = lastFrame1.response?.candidates?.[0]?.content?.parts ?? [];
    expect(parts1).toContainEqual({
      functionCall: {
        id: "call_readme_1",
        name: "view_file",
        args: { AbsolutePath: "c:/repo/README.md" },
      },
    });
    expect(recordedTurns[0].mode).toBe("bootstrap");

    // Turn 2: language_server sends back functionResponse
    const res2 = await fetch(
      `${bridge.url}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          request: {
            systemInstruction: { parts: [{ text: "You are Antigravity." }] },
            tools,
            contents: [
              {
                role: "user",
                parts: [{ text: "What is the README title?" }],
              },
              {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "call_readme_1",
                      name: "view_file",
                      args: { AbsolutePath: "c:/repo/README.md" },
                    },
                  },
                ],
              },
              {
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      id: "call_readme_1",
                      name: "view_file",
                      response: { content: "# Demo Project\n" },
                    },
                  },
                ],
              },
            ],
          },
        }),
      },
    );

    expect(res2.status).toBe(200);
    const frames2 = parseSseFrames(await res2.text());
    const combinedText2 = frames2
      .flatMap((f) => f.response?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    expect(combinedText2).toContain("The README title is # Demo Project.");
    expect(recordedTurns[1].mode).toBe("incremental");
    expect(recordedTurns[1].inlinePrompt).toContain("<antigravity_tool_result>");
  });

  it("fast-paths internal safety monitor requests without invoking the browser driver", async () => {
    let driverCalled = false;
    const mockDriver: GeminiWebDriver = {
      async executeTurn() {
        driverCalled = true;
        throw new Error("Should not be called");
      },
    };

    const bridge = await startCcpaBridgeServer({
      port: 0,
      driver: mockDriver,
      onLog: () => undefined,
    });
    handles.push(bridge);

    const res = await fetch(
      `${bridge.url}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "MODEL_TIER_FLASH_LITE",
          request: {
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: "You are a safety pre-filter overseeing an AI coding agent.",
                  },
                ],
              },
            ],
          },
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(driverCalled).toBe(false);
    const frames = parseSseFrames(await res.text());
    const text = frames[0]?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ severity: 0 });
  });

  it("reverse-proxies non-generation /v1internal routes to upstream Cloud Code PA", async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === "/v1internal:loadCodeAssist") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cloudaicompanionProject: "test-proj-123" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    auxServers.push(upstream);

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const bridge = await startCcpaBridgeServer({
      port: 0,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      onLog: () => undefined,
    });
    handles.push(bridge);

    const res = await fetch(`${bridge.url}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cloudaicompanionProject: "test-proj-123" });
  });
});
