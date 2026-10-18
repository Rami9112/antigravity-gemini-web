import { describe, expect, it } from "vitest";
import {
  StreamingToolCallFilter,
  compileGeminiWebTurn,
  compileGeminiWebTurnWithFallback,
  extractIncrementalContents,
  isInternalMonitorRequest,
  parseGeminiWebModelOutput,
  stripToolCallFenceLeftovers,
} from "../src/protocol/tool-protocol.js";
import type { CloudCodeGenerateContentRequest } from "../src/types.js";

describe("tool-protocol", () => {
  const sampleTools = [
    {
      functionDeclarations: [
        {
          name: "view_file",
          description: "Read contents of a local file",
          parameters: {
            type: "object",
            properties: {
              AbsolutePath: { type: "string" },
            },
            required: ["AbsolutePath"],
          },
        },
        {
          name: "run_command",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: {
              CommandLine: { type: "string" },
              Cwd: { type: "string" },
            },
            required: ["CommandLine", "Cwd"],
          },
        },
      ],
    },
  ];

  it("compiles a bootstrap turn on the first request and an incremental turn on tool response", () => {
    const turn1Payload: CloudCodeGenerateContentRequest = {
      model: "gemini-2.5-pro",
      request: {
        systemInstruction: {
          parts: [{ text: "You are Antigravity, an agentic coding assistant." }],
        },
        tools: sampleTools,
        contents: [
          {
            role: "user",
            parts: [{ text: "Please check package.json" }],
          },
        ],
      },
    };

    const compiledTurn1 = compileGeminiWebTurn(turn1Payload);
    expect(compiledTurn1.mode).toBe("bootstrap");
    expect(compiledTurn1.inlinePrompt).toContain("Antigravity Local Tool Execution Protocol");
    expect(compiledTurn1.inlinePrompt).toContain("view_file");
    expect(compiledTurn1.inlinePrompt).toContain("Please check package.json");
    expect(compiledTurn1.expectedToolNames).toEqual(["view_file", "run_command"]);

    // Turn 2: language_server.exe appends the model's functionCall and the local functionResponse
    const turn2Payload: CloudCodeGenerateContentRequest = {
      model: "gemini-2.5-pro",
      request: {
        systemInstruction: {
          parts: [{ text: "You are Antigravity, an agentic coding assistant." }],
        },
        tools: sampleTools,
        contents: [
          {
            role: "user",
            parts: [{ text: "Please check package.json" }],
          },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call_1",
                  name: "view_file",
                  args: { AbsolutePath: "c:/repo/package.json" },
                },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_1",
                  name: "view_file",
                  response: { output: '{"name": "demo"}' },
                },
              },
            ],
          },
        ],
      },
    };

    const compiledTurn2 = compileGeminiWebTurn(turn2Payload, {
      previousContents: compiledTurn1.contentsSnapshot,
    });

    expect(compiledTurn2.mode).toBe("incremental");
    expect(compiledTurn2.sessionKey).toBe(compiledTurn1.sessionKey);
    expect(compiledTurn2.inlinePrompt).toContain("<antigravity_tool_result>");
    expect(compiledTurn2.inlinePrompt).toContain('\\"name\\": \\"demo\\"');
    // Should NOT resend the first user prompt or full system instructions
    expect(compiledTurn2.inlinePrompt).not.toContain("Please check package.json");
    expect(compiledTurn2.inlinePrompt).not.toContain("Available Tools Catalog (JSON)");
  });

  it("stages an attachment file when bootstrap prompt exceeds inlineThresholdChars", () => {
    const payload: CloudCodeGenerateContentRequest = {
      model: "gemini-2.5-pro",
      request: {
        systemInstruction: {
          parts: [{ text: "A".repeat(2000) }],
        },
        tools: sampleTools,
        contents: [
          {
            role: "user",
            parts: [{ text: "Inspect the repo structure." }],
          },
        ],
      },
    };

    const compiled = compileGeminiWebTurn(payload, {
      inlineThresholdChars: 500,
    });

    expect(compiled.mode).toBe("bootstrap");
    expect(compiled.attachmentFileName).toBe("antigravity-context.md");
    expect(compiled.attachmentContent).toContain("A".repeat(2000));
    expect(compiled.inlinePrompt).toContain("Read the attached `antigravity-context.md` file first.");
    expect(compiled.inlinePrompt).toContain("Inspect the repo structure.");
  });

  it("parses single and parallel <antigravity_tool_call> blocks and strips them from visible text", () => {
    const raw = [
      "I will inspect `package.json` and `tsconfig.json` now.",
      "",
      "<antigravity_tool_call>",
      "```json",
      '[',
      '  {"id": "call_a", "name": "view_file", "args": {"AbsolutePath": "/app/package.json"}},',
      '  {"id": "call_b", "name": "view_file", "args": {"AbsolutePath": "/app/tsconfig.json"},}',
      ']',
      "```",
      "</antigravity_tool_call>",
    ].join("\n");

    const parsed = parseGeminiWebModelOutput(raw, "Checking configuration files first.");
    expect(parsed.visibleText).toBe("I will inspect `package.json` and `tsconfig.json` now.");
    expect(parsed.thoughtText).toBe("Checking configuration files first.");
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]).toMatchObject({
      id: "call_a",
      name: "view_file",
      args: { AbsolutePath: "/app/package.json" },
    });
    expect(parsed.toolCalls[1]).toMatchObject({
      id: "call_b",
      name: "view_file",
      args: { AbsolutePath: "/app/tsconfig.json" },
    });
  });

  it("streams visible text deltas while holding back <antigravity_tool_call> tags", () => {
    const filter = new StreamingToolCallFilter();
    const chunks = [
      "Let me check ",
      "the directory.<antigr",
      "avity_tool_call>",
      '{"name": "run_command", "args": {"CommandLine": "ls", "Cwd": "."}}',
      "</antigravity_tool_call>",
    ];

    const emitted: string[] = [];
    for (const chunk of chunks) {
      const out = filter.pushDelta(chunk);
      if (out) {
        emitted.push(out);
      }
    }

    const { remainingVisibleDelta, parsed } = filter.finalize();
    if (remainingVisibleDelta) {
      emitted.push(remainingVisibleDelta);
    }

    expect(emitted.join("")).toBe("Let me check the directory.");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("run_command");
    expect(parsed.toolCalls[0].args).toMatchObject({
      CommandLine: "ls",
      Cwd: ".",
      WaitMsBeforeAsync: 5000,
    });
  });

  it("detects Antigravity internal sir_flash_lite safety monitor requests", () => {
    const monitorReq: CloudCodeGenerateContentRequest = {
      model: "MODEL_TIER_FLASH_LITE",
      request: {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "You are a safety pre-filter overseeing an AI coding agent. You will see the agent's most recent reasoning...",
              },
            ],
          },
        ],
      },
    };

    expect(isInternalMonitorRequest(monitorReq)).toBe(true);
  });

  it("repairs unescaped Windows backslashes inside <antigravity_tool_call> JSON strings", () => {
    const raw =
      String.raw`프로젝트 폴더 목록을 확인합니다. <antigravity_tool_call>{"name": "run_command", "args": {"CommandLine": "Get-ChildItem -Path 'C:\', 'C:\workspace', 'C:\Users\dev', 'C:\Users\dev\.gemini\antigravity\scratch' -Directory -ErrorAction SilentlyContinue | Select-Object FullName", "Cwd": "C:\Users\dev", "WaitMsBeforeAsync": 5000, "toolSummary": "List project directories", "toolAction": "Listing project directories"}}</antigravity_tool_call>`;

    const parsed = parseGeminiWebModelOutput(raw);
    expect(parsed.visibleText).toBe("프로젝트 폴더 목록을 확인합니다.");
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("run_command");
    expect(parsed.toolCalls[0].args).toEqual({
      CommandLine:
        "Get-ChildItem -Path 'C:\\', 'C:\\workspace', 'C:\\Users\\dev', 'C:\\Users\\dev\\.gemini\\antigravity\\scratch' -Directory -ErrorAction SilentlyContinue | Select-Object FullName",
      Cwd: "C:\\Users\\dev",
      WaitMsBeforeAsync: 5000,
      toolSummary: "List project directories",
      toolAction: "Listing project directories",
    });
  });

  it("compiles as incremental (reusing the same Gemini Web session without resending system prompt) even when language_server.exe sets role='model' on functionResponse items", () => {
    const turn1: CloudCodeGenerateContentRequest = {
      model: "gemini-4-argon-high",
      request: {
        systemInstruction: {
          parts: [{ text: "You are Antigravity. Long system prompt..." }],
        },
        tools: sampleTools,
        contents: [
          {
            role: "user",
            parts: [{ text: "Check my project folder" }],
          },
        ],
      },
    };

    const compiled1 = compileGeminiWebTurn(turn1);
    expect(compiled1.mode).toBe("bootstrap");

    // language_server.exe sets role: "model" on BOTH the functionCall item AND the functionResponse item
    const turn2: CloudCodeGenerateContentRequest = {
      model: "gemini-4-argon-high",
      request: {
        systemInstruction: {
          parts: [{ text: "You are Antigravity. Long system prompt..." }],
        },
        tools: sampleTools,
        contents: [
          {
            role: "user",
            parts: [{ text: "Check my project folder" }],
          },
          {
            role: "model",
            parts: [
              { text: "Checking directories..." },
              {
                functionCall: {
                  id: "call_1",
                  name: "run_command",
                  args: { CommandLine: "dir", Cwd: "C:\\projects" },
                },
              },
            ],
          },
          {
            role: "model",
            parts: [
              {
                functionResponse: {
                  id: "call_1",
                  name: "run_command",
                  response: { output: "Directory of C:\\projects" },
                },
              },
            ],
          },
        ],
      },
    };

    const compiled2 = compileGeminiWebTurn(turn2, {
      previousContents: compiled1.contentsSnapshot,
    });

    expect(compiled2.mode).toBe("incremental");
    expect(compiled2.sessionKey).toBe(compiled1.sessionKey);
    expect(compiled2.inlinePrompt).toContain("<antigravity_tool_result>");
    expect(compiled2.inlinePrompt).toContain("Directory of C:\\\\projects");
    expect(compiled2.inlinePrompt).not.toContain("[Assistant]");
    expect(compiled2.inlinePrompt).not.toContain("Long system prompt");
    expect(compiled2.inlinePrompt).not.toContain("Available Tools Catalog");
  });

  it("removes the empty code fence left behind when the tool call was wrapped in a fenced block", () => {
    const raw = [
      "로컬 프로젝트 디렉터리 목록을 확인하겠습니다.",
      "",
      "```json",
      '<antigravity_tool_call>{"name": "view_file", "args": {"AbsolutePath": "C:/a.txt"}}</antigravity_tool_call>',
      "```",
    ].join("\n");

    const parsed = parseGeminiWebModelOutput(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.visibleText).toBe("로컬 프로젝트 디렉터리 목록을 확인하겠습니다.");
  });

  it("keeps a legitimate closing fence of a code block that precedes the tool call", () => {
    const text = "Here:\n```ts\nconst x = 1;\n```\n";
    expect(stripToolCallFenceLeftovers(text)).toBe(text);
  });

  it("never streams the fence opener that wraps a tool call", () => {
    const filter = new StreamingToolCallFilter();
    const emitted: string[] = [];
    for (const chunk of [
      "확인하겠습니다.\n\n",
      "```json\n",
      '<antigravity_tool_call>{"name": "view_file", "args": {"AbsolutePath": "C:/a.txt"}}',
      "</antigravity_tool_call>\n```",
    ]) {
      const out = filter.pushDelta(chunk);
      if (out) emitted.push(out);
    }
    const { remainingVisibleDelta, parsed } = filter.finalize();
    if (remainingVisibleDelta) emitted.push(remainingVisibleDelta);

    expect(emitted.join("")).not.toContain("```");
    expect(parsed.toolCalls).toHaveLength(1);
  });

  it("still streams normal code blocks once their content arrives", () => {
    const filter = new StreamingToolCallFilter();
    const emitted: string[] = [];
    for (const chunk of ["Example:\n```ts\n", "const x = 1;\n", "```\nDone."]) {
      const out = filter.pushDelta(chunk);
      if (out) emitted.push(out);
    }
    const { remainingVisibleDelta } = filter.finalize();
    if (remainingVisibleDelta) emitted.push(remainingVisibleDelta);
    expect(emitted.join("")).toBe("Example:\n```ts\nconst x = 1;\n```\nDone.");
  });

  describe("extractIncrementalContents", () => {
    const u1 = { role: "user", parts: [{ text: "first question" }] };
    const m1 = { role: "model", parts: [{ text: "first answer" }] };
    const u2 = { role: "user", parts: [{ text: "second question" }] };
    const m2 = { role: "model", parts: [{ text: "second answer" }] };
    const u3 = { role: "user", parts: [{ text: "third question" }] };

    it("returns only the new user message after Gemini Web's latest answer", () => {
      expect(extractIncrementalContents([u1, m1, u2], [u1, m1, u2, m2, u3])).toEqual([u3]);
    });

    it("ignores thought parts and call ids when matching earlier assistant turns", () => {
      const m1WithThought = {
        role: "model",
        parts: [{ thought: true, text: "thinking" }, { text: "first answer" }],
      };
      expect(extractIncrementalContents([u1, m1, u2], [u1, m1WithThought, u2, m2, u3])).toEqual([
        u3,
      ]);
    });

    it("forces a bootstrap when an earlier assistant turn was rewritten (revert/regenerate)", () => {
      const m1Edited = { role: "model", parts: [{ text: "different answer" }] };
      expect(extractIncrementalContents([u1, m1, u2], [u1, m1Edited, u2, m2, u3])).toBeNull();
    });

    it("forces a bootstrap when history was compacted and assistant turns disappeared", () => {
      expect(extractIncrementalContents([u1, m1, u2, m2, u3], [u1, u3])).toBeNull();
    });

    it("forces a bootstrap when the exact same request is replayed", () => {
      expect(extractIncrementalContents([u1, m1, u2], [u1, m1, u2])).toBeNull();
    });
  });

  describe("prompt budget (Gemini Web composer limit)", () => {
    const hugeOutput = `HEAD-MARKER\n${"line of tool output\n".repeat(6_000)}TAIL-MARKER`;

    it("truncates a huge tool result inline instead of overflowing the composer", () => {
      const u = { role: "user", parts: [{ text: "read the big file" }] };
      const m = {
        role: "model",
        parts: [{ functionCall: { id: "c1", name: "view_file", args: { AbsolutePath: "C:/big.txt" } } }],
      };
      const fr = {
        role: "user",
        parts: [{ functionResponse: { id: "c1", name: "view_file", response: { output: hugeOutput } } }],
      };
      const compiled = compileGeminiWebTurn(
        { model: "gemini-4-argon-high", request: { tools: sampleTools, contents: [u, m, fr] } },
        { previousContents: [u] },
      );

      expect(compiled.mode).toBe("incremental");
      expect(compiled.attachmentContent).toBeUndefined();
      expect(compiled.inlinePrompt.length).toBeLessThanOrEqual(26_000);
      expect(compiled.inlinePrompt).toContain("HEAD-MARKER");
      expect(compiled.inlinePrompt).toContain("TAIL-MARKER");
      expect(compiled.inlinePrompt).toContain("chars omitted to fit the Gemini Web input limit");
    });

    it("keeps a long bootstrap history inline by dropping the oldest items", () => {
      const contents = [{ role: "user", parts: [{ text: "ORIGINAL-TASK" }] }];
      for (let i = 0; i < 60; i += 1) {
        contents.push({ role: "model", parts: [{ text: `answer ${i} ${"x".repeat(900)}` }] });
        contents.push({ role: "user", parts: [{ text: `follow-up ${i}` }] });
      }
      const compiled = compileGeminiWebTurn({
        model: "gemini-4-argon-high",
        request: { tools: sampleTools, contents },
      });

      expect(compiled.mode).toBe("bootstrap");
      expect(compiled.attachmentContent).toBeUndefined();
      expect(compiled.inlinePrompt.length).toBeLessThanOrEqual(26_000);
      expect(compiled.inlinePrompt).toContain("ORIGINAL-TASK");
      expect(compiled.inlinePrompt).toContain("follow-up 59");
      expect(compiled.inlinePrompt).toContain("earlier conversation item(s) omitted");
    });
  });

  it("tells the model about image/binary attachments that cannot be forwarded", () => {
    const compiled = compileGeminiWebTurn({
      model: "gemini-4-argon-high",
      request: {
        tools: sampleTools,
        contents: [
          {
            role: "user",
            parts: [
              { text: "What is in this screenshot?" },
              { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    });
    expect(compiled.inlinePrompt).toContain("What is in this screenshot?");
    expect(compiled.inlinePrompt).toContain("Attachment omitted by the Antigravity bridge: image/png");
  });

  it("attaches a full bootstrap fallback to incremental turns", () => {
    const u = { role: "user", parts: [{ text: "ORIGINAL-TASK" }] };
    const m = { role: "model", parts: [{ text: "answer" }] };
    const u2 = { role: "user", parts: [{ text: "follow-up" }] };
    const payload: CloudCodeGenerateContentRequest = {
      model: "gemini-4-argon-high",
      request: {
        systemInstruction: { parts: [{ text: "SYSTEM-PROMPT" }] },
        tools: sampleTools,
        contents: [u, m, u2],
      },
    };

    const compiled = compileGeminiWebTurnWithFallback(payload, { previousContents: [u] });
    expect(compiled.mode).toBe("incremental");
    expect(compiled.inlinePrompt).not.toContain("SYSTEM-PROMPT");
    expect(compiled.bootstrapFallback?.mode).toBe("bootstrap");
    expect(compiled.bootstrapFallback?.sessionKey).toBe(compiled.sessionKey);
    expect(compiled.bootstrapFallback?.inlinePrompt).toContain("SYSTEM-PROMPT");
    expect(compiled.bootstrapFallback?.inlinePrompt).toContain("ORIGINAL-TASK");
    expect(compiled.bootstrapFallback?.inlinePrompt).toContain("follow-up");

    expect(compileGeminiWebTurnWithFallback(payload).bootstrapFallback).toBeUndefined();
  });
});
