import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GeminiMarkdownBuffer, htmlToGeminiMarkdown } from "../src/driver/dom-markdown.js";
import {
  StreamingToolCallFilter,
  parseGeminiWebModelOutput,
} from "../src/protocol/tool-protocol.js";

/**
 * Regression tests against HTML captured from the real Gemini Web DOM, so changes in the
 * Markdown/tool-call pipeline are checked against what Gemini Web actually renders.
 */
const liveHtml = readFileSync(
  path.resolve("tests", "fixtures", "gemini-web-live-tool-call.html"),
  "utf8",
).trim();

const expectedArgs = {
  CommandLine:
    "Get-ChildItem -Path 'C:\\workspace', 'C:\\Users\\dev\\workspace', 'C:\\Users\\dev\\.gemini\\antigravity\\scratch' -ErrorAction SilentlyContinue | Select-Object FullName, Mode, LastWriteTime",
  Cwd: "C:\\Users\\dev",
  WaitMsBeforeAsync: 5000,
  toolSummary: "Check project directories",
  toolAction: "Checking project directories",
};

describe("live Gemini Web DOM fixtures", () => {
  it("parses the captured tool call with intact Windows paths and tool name", () => {
    const parsed = parseGeminiWebModelOutput(htmlToGeminiMarkdown(liveHtml));
    expect(parsed.visibleText).toBe(
      "로컬 프로젝트 디렉토리와 기본 작업 경로에 어떤 폴더들이 있는지 확인하겠습니다.",
    );
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("run_command");
    expect(parsed.toolCalls[0].args).toEqual(expectedArgs);
  });

  it("streams the captured response like the browser driver without leaking the tool call", () => {
    const buffer = new GeminiMarkdownBuffer({ holdbackChars: 12 });
    const filter = new StreamingToolCallFilter();
    const emitted: string[] = [];

    // Replay progressively longer DOM snapshots, as Gemini Web renders them while streaming
    for (let end = 40; end < liveHtml.length; end += 37) {
      const delta = buffer.pushHtmlSnapshot(liveHtml.slice(0, end));
      const visible = delta ? filter.pushDelta(delta) : "";
      if (visible) emitted.push(visible);
    }
    const final = buffer.finalize({ html: liveHtml });
    if (final.delta) {
      const visible = filter.pushDelta(final.delta);
      if (visible) emitted.push(visible);
    }
    const { remainingVisibleDelta, parsed } = filter.finalize("", final.fullText);
    if (remainingVisibleDelta) emitted.push(remainingVisibleDelta);

    const streamedText = emitted.join("");
    expect(streamedText).not.toContain("antigravity_tool_call");
    expect(streamedText).not.toContain("run_command");
    expect(streamedText.trim()).toBe(
      "로컬 프로젝트 디렉토리와 기본 작업 경로에 어떤 폴더들이 있는지 확인하겠습니다.",
    );
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("run_command");
    expect(parsed.toolCalls[0].args).toEqual(expectedArgs);
  });
});
