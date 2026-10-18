import TurndownService from "turndown";

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  service.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  // Strip Gemini Web UI chrome buttons/toolbars inside code blocks or response footers
  service.addRule("stripGeminiUiChrome", {
    filter(node) {
      if (node.nodeType !== 1) {
        return false;
      }
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "button" || tag === "mat-icon" || tag === "svg") {
        return true;
      }
      const cls = (el.getAttribute("class") ?? "").toLowerCase();
      if (
        cls.includes("code-block-decoration") ||
        cls.includes("header-formatted") ||
        cls.includes("buttons") ||
        cls.includes("copy-button") ||
        cls.includes("response-footer")
      ) {
        return true;
      }
      return false;
    },
    replacement() {
      return "";
    },
  });

  // Preserve custom <antigravity_tool_call> tags if rendered as DOM elements
  service.addRule("preserveAntigravityToolCallElement", {
    filter(node) {
      return (
        node.nodeType === 1 &&
        (node as HTMLElement).tagName.toLowerCase() === "antigravity_tool_call"
      );
    },
    replacement(content) {
      return `\n<antigravity_tool_call>\n${content.trim()}\n</antigravity_tool_call>\n`;
    },
  });

  return service;
}

const sharedTurndown = createTurndownService();

function restoreToolCallBlocks(markdown: string): string {
  // First normalize any escaped opening/closing tags (`\<antigravity\_tool\_call\>`)
  const normalizedTags = markdown
    .replace(
      /\\?<\s*antigravity\\?_tool\\?_call\s*\\?>/gi,
      "<antigravity_tool_call>",
    )
    .replace(
      /\\?<\s*\/\s*antigravity\\?_tool\\?_call\s*\\?>/gi,
      "</antigravity_tool_call>",
    )
    .replace(
      /\\?<\s*antigravity\\?_tool\\?_result\s*\\?>/gi,
      "<antigravity_tool_result>",
    )
    .replace(
      /\\?<\s*\/\s*antigravity\\?_tool\\?_result\s*\\?>/gi,
      "</antigravity_tool_result>",
    );

  // Unescape Turndown markdown escapes (`\_`, `\[`, `\]`, `\*`) inside <antigravity_tool_call>...</antigravity_tool_call>
  // including partial/unclosed blocks during streaming snapshots.
  return normalizedTags.replace(
    /<antigravity_tool_call>([\s\S]*?)(<\/antigravity_tool_call>|$)/gi,
    (_full, inner: string, closeTag: string) => {
      const unescapedInner = inner.replace(/\\([_[\]*`~<>])/g, "$1");
      return `<antigravity_tool_call>${unescapedInner}${closeTag}`;
    },
  );
}

export function htmlToGeminiMarkdown(html: string): string {
  if (!html || !html.trim()) {
    return "";
  }

  const rawMd = sharedTurndown.turndown(html);

  return restoreToolCallBlocks(rawMd).replace(/\r\n/g, "\n").trim();
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

/**
 * Converts a sequence of HTML or Markdown snapshots from Gemini Web's streaming DOM
 * into append-only Markdown deltas.
 * Holds back a small tail margin (`holdbackChars`) during streaming so transient
 * Markdown formatting tokens at the end of a growing DOM node do not flicker.
 */
export class GeminiMarkdownBuffer {
  private latestFullText = "";
  private emittedLength = 0;
  private readonly holdbackChars: number;

  public constructor(options: { holdbackChars?: number } = {}) {
    this.holdbackChars = options.holdbackChars ?? 16;
  }

  public getLatestFullText(): string {
    return this.latestFullText;
  }

  public pushHtmlSnapshot(html: string): string {
    const markdown = htmlToGeminiMarkdown(html);
    return this.pushMarkdownSnapshot(markdown);
  }

  public pushMarkdownSnapshot(markdown: string): string {
    this.latestFullText = markdown;
    if (!markdown) {
      return "";
    }

    const safeTargetLength = Math.max(0, markdown.length - this.holdbackChars);
    if (safeTargetLength <= this.emittedLength) {
      return "";
    }

    const delta = markdown.slice(this.emittedLength, safeTargetLength);
    this.emittedLength = safeTargetLength;
    return delta;
  }

  public finalize(finalHtmlOrMarkdown?: { html?: string; markdown?: string }): {
    delta: string;
    fullText: string;
  } {
    if (typeof finalHtmlOrMarkdown?.html === "string") {
      this.latestFullText = htmlToGeminiMarkdown(finalHtmlOrMarkdown.html);
    } else if (typeof finalHtmlOrMarkdown?.markdown === "string") {
      this.latestFullText = finalHtmlOrMarkdown.markdown.trim();
    }

    const prefixLen = commonPrefixLength(
      this.latestFullText.slice(0, this.emittedLength),
      this.latestFullText,
    );
    const startIdx = Math.min(this.emittedLength, prefixLen);
    const delta = this.latestFullText.slice(startIdx);
    this.emittedLength = this.latestFullText.length;

    return {
      delta,
      fullText: this.latestFullText,
    };
  }
}
