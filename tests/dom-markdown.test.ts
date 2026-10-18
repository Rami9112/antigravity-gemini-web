import { describe, expect, it } from "vitest";
import {
  GeminiMarkdownBuffer,
  htmlToGeminiMarkdown,
} from "../src/driver/dom-markdown.js";

describe("GeminiMarkdownBuffer and htmlToGeminiMarkdown", () => {
  it("converts Gemini Web code blocks and strips copy/decoration headers", () => {
    const html = `
      <div class="markdown">
        <p>Here is the script:</p>
        <code-block>
          <div class="code-block-decoration header-formatted">
            <span>typescript</span>
            <button class="copy-button">Copy</button>
          </div>
          <pre><code class="language-typescript">const x = 42;\nconsole.log(x);</code></pre>
        </code-block>
      </div>
    `;

    const md = htmlToGeminiMarkdown(html);
    expect(md).toContain("Here is the script:");
    expect(md).toContain("```typescript\nconst x = 42;\nconsole.log(x);\n```");
    expect(md).not.toContain("Copy");
  });

  it("preserves <antigravity_tool_call> tags without backslash escaping", () => {
    const html = `
      <p>Checking file now.</p>
      <p>&lt;antigravity_tool_call&gt;{"name":"view_file","args":{"AbsolutePath":"README.md"}}&lt;/antigravity_tool_call&gt;</p>
    `;

    const md = htmlToGeminiMarkdown(html);
    expect(md).toContain("<antigravity_tool_call>");
    expect(md).toContain("</antigravity_tool_call>");
    expect(md).not.toContain("\\<antigravity_tool_call\\>");
  });

  it("emits append-only deltas across progressive HTML snapshots", () => {
    const buffer = new GeminiMarkdownBuffer({ holdbackChars: 4 });
    const deltas: string[] = [];

    const d1 = buffer.pushHtmlSnapshot("<p>Hello world, this is a streaming test</p>");
    if (d1) deltas.push(d1);

    const d2 = buffer.pushHtmlSnapshot(
      "<p>Hello world, this is a streaming test from Gemini Web!</p>",
    );
    if (d2) deltas.push(d2);

    const final = buffer.finalize({
      html: "<p>Hello world, this is a streaming test from Gemini Web!</p>",
    });
    if (final.delta) deltas.push(final.delta);

    expect(deltas.join("")).toBe(
      "Hello world, this is a streaming test from Gemini Web!",
    );
  });

  it("unescapes underscores in unclosed streaming <antigravity_tool_call> snapshots so tool names are never corrupted", () => {
    const buffer = new GeminiMarkdownBuffer({ holdbackChars: 12 });
    const partialHtml = `<p>로컬 프로젝트 디렉토리와 기본 작업 경로에 어떤 폴더들이 있는지 확인하겠습니다.</p><p>&lt;antigravity_tool_call&gt;\n{"name": "run_command", "args": {"CommandLine": "Get-ChildItem -Path 'C:\\workspace'", "Cwd": "C:\\Users\\dev",`;
    const completeHtml = `${partialHtml} "WaitMsBeforeAsync": 5000, "toolSummary": "Check project directories", "toolAction": "Checking project directories"}}\n&lt;/antigravity_tool_call&gt;</p>`;

    const d1 = buffer.pushHtmlSnapshot(partialHtml);
    expect(d1).not.toContain("run\\_command");

    const final = buffer.finalize({ html: completeHtml });
    expect(final.fullText).toContain('"name": "run_command"');
    expect(final.fullText).toContain('"toolAction": "Checking project directories"');
    expect(final.fullText).not.toContain("run\\_command");
  });
});
