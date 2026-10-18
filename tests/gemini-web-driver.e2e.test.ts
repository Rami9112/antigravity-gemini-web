import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlaywrightGeminiWebDriver } from "../src/driver/gemini-web-driver.js";
import {
  startCcpaBridgeServer,
  type CcpaBridgeServerHandle,
} from "../src/proxy/ccpa-server.js";
import type { CloudCodeGenerateContentResponse } from "../src/types.js";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

function parseSseFrames(rawSse: string): CloudCodeGenerateContentResponse[] {
  return rawSse
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => JSON.parse(block.slice("data:".length).trim()));
}

describe("PlaywrightGeminiWebDriver E2E over CDP", () => {
  const servers: http.Server[] = [];
  const bridges: CcpaBridgeServerHandle[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    while (bridges.length > 0) {
      await bridges.pop()!.close();
    }
    while (servers.length > 0) {
      const s = servers.pop()!;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    while (children.length > 0) {
      const c = children.pop()!;
      c.kill();
    }
  });

  it("executes a full 2-turn bootstrap + incremental tool loop through a real CDP browser DOM", async () => {
    const submittedPrompts: string[] = [];
    const observedUserAgents: string[] = [];
    let observedClientFingerprint = null as {
      webdriver?: boolean;
      userAgent?: string;
      brands?: unknown[];
      hasChromeRuntime?: boolean;
    } | null;

    // 1. Start mock Gemini Web UI server with Angular-like custom elements
    const mockWeb = http.createServer((req, res) => {
      if (req.headers["user-agent"]) {
        observedUserAgents.push(String(req.headers["user-agent"]));
      }
      if (req.method === "POST" && req.url === "/_fp") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          observedClientFingerprint = JSON.parse(body);
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }
      if (req.method === "POST" && req.url === "/_record") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          submittedPrompts.push(body);
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
<body>
  <div id="chat-history"></div>
  <button class="stop-button" aria-label="Stop response" style="display:none">Stop</button>
  <rich-textarea>
    <div contenteditable="true" role="textbox" id="composer"></div>
  </rich-textarea>
  <button class="send-button" aria-label="Send message" id="send-btn">Send</button>
  <script>
    let turnIndex = 0;
    const composer = document.getElementById('composer');
    const sendBtn = document.getElementById('send-btn');
    const history = document.getElementById('chat-history');
    const stopBtn = document.querySelector('.stop-button');

    fetch('/_fp', {
      method: 'POST',
      body: JSON.stringify({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        brands: navigator.userAgentData ? navigator.userAgentData.brands : [],
        hasChromeRuntime: Boolean(window.chrome && window.chrome.runtime)
      })
    });

    sendBtn.addEventListener('click', async () => {
      const text = composer.innerText || composer.textContent || '';
      composer.textContent = '';
      await fetch('/_record', { method: 'POST', body: text });

      turnIndex += 1;
      stopBtn.style.display = 'inline-block';

      const resp = document.createElement('model-response');
      resp.setAttribute('aria-busy', 'true');
      const thoughts = document.createElement('model-thoughts');
      const msgContent = document.createElement('message-content');
      const md = document.createElement('div');
      md.className = 'markdown';
      msgContent.appendChild(md);
      resp.appendChild(thoughts);
      resp.appendChild(msgContent);
      history.appendChild(resp);

      if (turnIndex === 1) {
        thoughts.innerText = 'Analyzing request and selecting view_file...';
        setTimeout(() => {
          md.innerHTML = '<p>I will read package.json now.</p>';
        }, 40);
        setTimeout(() => {
          md.innerHTML = '<p>I will read package.json now.</p><p>&lt;antigravity_tool_call&gt;{"id":"call_e2e_1","name":"view_file","args":{"AbsolutePath":"package.json"}}&lt;/antigravity_tool_call&gt;</p>';
          resp.setAttribute('aria-busy', 'false');
          stopBtn.style.display = 'none';
        }, 100);
      } else {
        thoughts.innerText = 'Synthesizing final answer from tool output...';
        setTimeout(() => {
          md.innerHTML = '<p>The package name is <code>antigravity-gemini-web</code>.</p>';
          resp.setAttribute('aria-busy', 'false');
          stopBtn.style.display = 'none';
        }, 80);
      }
    });
  </script>
</body>
</html>`);
    });
    servers.push(mockWeb);

    await new Promise<void>((resolve) =>
      mockWeb.listen(0, "127.0.0.1", () => resolve()),
    );
    const mockWebPort = (mockWeb.address() as net.AddressInfo).port;
    const mockGeminiUrl = `http://127.0.0.1:${mockWebPort}/app`;

    // 2. Spawn actual host/electron-host.cjs with CDP port enabled
    const cdpPort = await getFreePort();
    const require = createRequire(import.meta.url);
    const electronBin = require("electron") as string;
    const tempProfile = path.join(
      os.tmpdir(),
      `agy-e2e-electron-${Date.now()}`,
    );
    const hostScript = path.resolve("host", "electron-host.cjs");
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;

    const electronProc = spawn(electronBin, [hostScript], {
      stdio: "ignore",
      env: {
        ...cleanEnv,
        GEMINI_WEB_CDP_PORT: String(cdpPort),
        GEMINI_WEB_TAB_COUNT: "1",
        GEMINI_WEB_URL: mockGeminiUrl,
        GEMINI_WEB_PROFILE_DIR: tempProfile,
        GEMINI_WEB_HEADLESS: "1",
      },
    });
    children.push(electronProc);

    // Wait for CDP endpoint to come online
    const deadline = Date.now() + 15_000;
    let cdpReady = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (res.ok) {
          cdpReady = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(cdpReady).toBe(true);

    // 3. Wire PlaywrightGeminiWebDriver to startCcpaBridgeServer
    const driver = new PlaywrightGeminiWebDriver({
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      geminiUrl: mockGeminiUrl,
      pollIntervalMs: 30,
      stableWindowMs: 120,
    });

    const bridge = await startCcpaBridgeServer({
      port: 0,
      driver,
      onLog: () => undefined,
    });
    bridges.push(bridge);

    const tools = [
      {
        functionDeclarations: [
          {
            name: "view_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { AbsolutePath: { type: "string" } },
            },
          },
        ],
      },
    ];

    // Turn 1: Bootstrap request
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
              { role: "user", parts: [{ text: "Check package.json name" }] },
            ],
          },
        }),
      },
    );

    expect(res1.status).toBe(200);
    const frames1 = parseSseFrames(await res1.text());
    const allParts1 = frames1.flatMap(
      (f) => f.response?.candidates?.[0]?.content?.parts ?? [],
    );

    expect(allParts1.some((p) => p.thought && p.text?.includes("Analyzing request"))).toBe(
      true,
    );
    expect(allParts1).toContainEqual({
      functionCall: {
        id: "call_e2e_1",
        name: "view_file",
        args: { AbsolutePath: "package.json" },
      },
    });

    // Turn 2: Follow-up functionResponse in the same retained tab
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
              { role: "user", parts: [{ text: "Check package.json name" }] },
              {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "call_e2e_1",
                      name: "view_file",
                      args: { AbsolutePath: "package.json" },
                    },
                  },
                ],
              },
              {
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      id: "call_e2e_1",
                      name: "view_file",
                      response: { name: "antigravity-gemini-web" },
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
    const text2 = frames2
      .flatMap((f) => f.response?.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");

    expect(text2).toContain("The package name is `antigravity-gemini-web`.");
    expect(submittedPrompts).toHaveLength(2);
    expect(submittedPrompts[0]).toContain("Antigravity Local Tool Execution Protocol");
    expect(submittedPrompts[1]).toContain("<antigravity_tool_result>");
    expect(submittedPrompts[1]).not.toContain("Available Tools Catalog (JSON)");

    // Turn 3: two other Antigravity conversations hit the only tab at the same time.
    // The second one must wait in the queue instead of failing with "slots busy".
    const sendOther = (text: string) =>
      fetch(`${bridge.url}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          request: {
            systemInstruction: { parts: [{ text: "You are Antigravity." }] },
            tools,
            contents: [{ role: "user", parts: [{ text }] }],
          },
        }),
      });
    const [res3a, res3b] = await Promise.all([
      sendOther("Unrelated other conversation"),
      sendOther("Concurrent third conversation"),
    ]);
    for (const res of [res3a, res3b]) {
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("Gemini Web Bridge Error");
    }

    // Turn 4: back to the first conversation. Its chat is no longer open in the tab,
    // so the bridge must resend the full context instead of only the new message.
    const res4 = await fetch(`${bridge.url}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        request: {
          systemInstruction: { parts: [{ text: "You are Antigravity." }] },
          tools,
          contents: [
            { role: "user", parts: [{ text: "Check package.json name" }] },
            {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call_e2e_1",
                    name: "view_file",
                    args: { AbsolutePath: "package.json" },
                  },
                },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    id: "call_e2e_1",
                    name: "view_file",
                    response: { name: "antigravity-gemini-web" },
                  },
                },
              ],
            },
            {
              role: "model",
              parts: [{ text: "The package name is `antigravity-gemini-web`." }],
            },
            { role: "user", parts: [{ text: "Thanks, one more question" }] },
          ],
        },
      }),
    });
    expect(res4.status).toBe(200);
    await res4.text();

    expect(submittedPrompts).toHaveLength(5);
    const concurrentPrompts = submittedPrompts.slice(2, 4).join("\n");
    expect(concurrentPrompts).toContain("Unrelated other conversation");
    expect(concurrentPrompts).toContain("Concurrent third conversation");
    expect(submittedPrompts[4]).toContain("Antigravity Local Tool Execution Protocol");
    expect(submittedPrompts[4]).toContain("Check package.json name");
    expect(submittedPrompts[4]).toContain("Thanks, one more question");

    expect(observedUserAgents.length).toBeGreaterThan(0);
    for (const ua of observedUserAgents) {
      expect(ua).not.toContain("Electron");
      expect(ua).not.toContain("antigravity-gemini-web");
      expect(ua).toContain("Chrome/");
    }

    expect(observedClientFingerprint).not.toBeNull();
    expect(observedClientFingerprint?.webdriver).toBe(false);
    expect(String(observedClientFingerprint?.userAgent)).not.toContain("Electron");
    expect(String(observedClientFingerprint?.userAgent)).not.toContain("antigravity");
    expect(observedClientFingerprint?.hasChromeRuntime).toBe(true);
    expect(
      JSON.stringify(observedClientFingerprint?.brands),
    ).toContain("Google Chrome");

    await driver.close();
  }, 45_000);
});
