import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  StreamingToolCallFilter,
  TOOL_CALL_CLOSE_TAG,
} from "../protocol/tool-protocol.js";
import { buildBrowserStealthInitScript } from "../stealth/chrome-stealth.js";
import type {
  CompiledGeminiWebTurn,
  GeminiWebDriver,
  GeminiWebTurnExecutionOptions,
  ParsedGeminiWebOutput,
} from "../types.js";
import { GeminiMarkdownBuffer } from "./dom-markdown.js";

export interface PlaywrightGeminiWebDriverOptions {
  cdpUrl?: string;
  geminiUrl?: string;
  pollIntervalMs?: number;
  stableWindowMs?: number;
  turnTimeoutMs?: number;
}

interface SlotState {
  page: Page;
  sessionKey: string | null;
  lastUsedAt: number;
  busy: boolean;
}

const COMPOSER_SELECTORS = [
  'rich-textarea div[contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'textarea[aria-label*="prompt" i]',
  "textarea",
];

const SEND_BUTTON_SELECTORS = [
  "button.send-button:not([disabled])",
  'button[aria-label*="Send message" i]:not([disabled])',
  'button[aria-label*="Send" i]:not([disabled])',
  'button[aria-label*="전송" i]:not([disabled])',
];

const MAX_REMEMBERED_SESSIONS = 200;

/**
 * Returns a user-facing explanation when `url` is a Google page the bridge cannot get past
 * by itself (CAPTCHA / unusual-traffic interstitial or sign-in), otherwise null.
 */
export function describeBlockedPage(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (/(^|\.)google\.[a-z.]+$/i.test(host) && parsed.pathname.startsWith("/sorry")) {
    return "Google is blocking the Gemini Web tab with an unusual-traffic (CAPTCHA) page. Open the Gemini Web host window, solve the check, then retry. (Google 비정상 트래픽 확인 페이지에 막혔습니다. 브라우저 창에서 확인을 통과한 뒤 다시 시도하세요.)";
  }
  if (host === "accounts.google.com") {
    return "The Gemini Web tab is on the Google sign-in page. Sign in inside the Gemini Web host window, then retry. (브라우저 창에서 Google 로그인을 마친 뒤 다시 시도하세요.)";
  }
  return null;
}

export class PlaywrightGeminiWebDriver implements GeminiWebDriver {
  private readonly cdpUrl: string;
  private readonly geminiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly stableWindowMs: number;
  private readonly turnTimeoutMs: number;
  private browser: Browser | null = null;
  private readonly slots: SlotState[] = [];
  private readonly instrumentedContexts = new WeakSet<object>();
  /** sessionKey -> Gemini Web chat URL (`/app/<id>`) holding that session's context. */
  private readonly sessionChatUrls = new Map<string, string>();
  /** Turns waiting (FIFO) for a free browser tab. */
  private readonly slotWaiters: Array<() => void> = [];
  /** Waiters already woken for a released tab but not yet resumed. */
  private pendingWakeups = 0;

  public constructor(options: PlaywrightGeminiWebDriverOptions = {}) {
    this.cdpUrl =
      options.cdpUrl ??
      process.env.GEMINI_WEB_CDP_URL ??
      "http://127.0.0.1:9333";
    this.geminiUrl =
      options.geminiUrl ??
      process.env.GEMINI_WEB_URL ??
      "https://gemini.google.com/app";
    this.pollIntervalMs = options.pollIntervalMs ?? 120;
    this.stableWindowMs = options.stableWindowMs ?? 950;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000;
  }

  public async connect(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      await this.refreshSlots();
      return;
    }
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    await this.refreshSlots();
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      this.slots.length = 0;
    }
  }

  private async refreshSlots(): Promise<void> {
    if (!this.browser) {
      return;
    }
    const existingPages = new Set(this.slots.map((s) => s.page));
    for (const context of this.browser.contexts()) {
      if (!this.instrumentedContexts.has(context)) {
        this.instrumentedContexts.add(context);
        await context
          .addInitScript(buildBrowserStealthInitScript())
          .catch(() => undefined);
      }
      for (const page of context.pages()) {
        const url = page.url();
        if (url.startsWith("data:text/html")) {
          continue;
        }
        if (!existingPages.has(page)) {
          this.slots.push({
            page,
            sessionKey: null,
            lastUsedAt: 0,
            busy: false,
          });
          existingPages.add(page);
        }
      }
    }

    if (this.slots.length === 0) {
      const defaultContext =
        this.browser.contexts()[0] ?? (await this.browser.newContext());
      if (!this.instrumentedContexts.has(defaultContext)) {
        this.instrumentedContexts.add(defaultContext);
        await defaultContext
          .addInitScript(buildBrowserStealthInitScript())
          .catch(() => undefined);
      }
      const page = await defaultContext.newPage();
      await page.goto(this.geminiUrl, { waitUntil: "domcontentloaded" });
      this.slots.push({
        page,
        sessionKey: null,
        lastUsedAt: 0,
        busy: false,
      });
    }
  }

  private tryClaimSlot(sessionKey: string): SlotState | null {
    // 1. Prefer the idle slot already bound to this session (its chat is likely still open)
    const existing = this.slots.find(
      (s) => s.sessionKey === sessionKey && !s.busy && !s.page.isClosed(),
    );
    if (existing) {
      existing.busy = true;
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // 2. Pick an unbound idle slot, or the least-recently-used idle slot
    const idleSlots = this.slots.filter((s) => !s.busy && !s.page.isClosed());
    if (idleSlots.length === 0) {
      return null;
    }

    idleSlots.sort((a, b) => {
      const aHealthy = a.page.url().startsWith("https://gemini.google.com") ? 0 : 1;
      const bHealthy = b.page.url().startsWith("https://gemini.google.com") ? 0 : 1;
      if (aHealthy !== bHealthy) return aHealthy - bHealthy;
      if (a.sessionKey === null && b.sessionKey !== null) return -1;
      if (a.sessionKey !== null && b.sessionKey === null) return 1;
      return a.lastUsedAt - b.lastUsedAt;
    });

    const chosen = idleSlots[0];
    chosen.busy = true;
    chosen.lastUsedAt = Date.now();
    return chosen;
  }

  /**
   * Claims a browser tab for a turn. When every tab is busy (e.g. a subagent and the main
   * agent run at the same time) the turn waits in a FIFO queue instead of failing.
   */
  private async acquireSlot(sessionKey: string, signal?: AbortSignal): Promise<SlotState> {
    await this.connect();
    while (true) {
      if (signal?.aborted) {
        throw new Error("Gemini Web turn aborted by client while waiting for a free tab.");
      }
      // Only claim directly when nobody is queued or being woken ahead of us (FIFO)
      if (this.slotWaiters.length === 0 && this.pendingWakeups === 0) {
        const slot = this.tryClaimSlot(sessionKey);
        if (slot) {
          return slot;
        }
      }

      let woken = false;
      await new Promise<void>((resolve) => {
        const waiter = () => {
          woken = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = this.slotWaiters.indexOf(waiter);
          if (idx !== -1) this.slotWaiters.splice(idx, 1);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.slotWaiters.push(waiter);
      });

      if (woken) {
        this.pendingWakeups -= 1;
      }
      if (signal?.aborted) {
        if (woken) {
          this.wakeNextWaiterIfSlotFree();
        }
        continue;
      }
      // Woken up because a tab was released for us: claim it synchronously.
      const slot = this.tryClaimSlot(sessionKey);
      if (slot) {
        this.wakeNextWaiterIfSlotFree();
        return slot;
      }
    }
  }

  private wakeNextWaiter(): void {
    const next = this.slotWaiters.shift();
    if (next) {
      this.pendingWakeups += 1;
      next();
    }
  }

  private wakeNextWaiterIfSlotFree(): void {
    if (this.slots.some((s) => !s.busy && !s.page.isClosed())) {
      this.wakeNextWaiter();
    }
  }

  private releaseSlot(slot: SlotState): void {
    slot.busy = false;
    slot.lastUsedAt = Date.now();
    this.wakeNextWaiter();
  }

  private rememberSessionChat(sessionKey: string, page: Page): void {
    let pathname = "";
    try {
      pathname = new URL(page.url()).pathname;
    } catch {
      return;
    }
    if (!/\/app\/[A-Za-z0-9_-]+/.test(pathname)) {
      return;
    }
    this.sessionChatUrls.delete(sessionKey);
    this.sessionChatUrls.set(sessionKey, page.url());
    while (this.sessionChatUrls.size > MAX_REMEMBERED_SESSIONS) {
      const oldest = this.sessionChatUrls.keys().next().value;
      if (oldest === undefined) break;
      this.sessionChatUrls.delete(oldest);
    }
  }

  /**
   * Makes sure the slot's page shows the Gemini Web chat that belongs to `sessionKey`.
   * Returns false when that chat cannot be found (the caller then falls back to a bootstrap).
   */
  private async restoreSessionChat(slot: SlotState, sessionKey: string): Promise<boolean> {
    const page = slot.page;
    const chatUrl = this.sessionChatUrls.get(sessionKey);
    const stripQuery = (url: string) => url.split(/[?#]/)[0];
    const onSameChat = chatUrl ? stripQuery(page.url()) === stripQuery(chatUrl) : true;

    if (
      slot.sessionKey === sessionKey &&
      onSameChat &&
      (await this.getModelResponseCount(page)) > 0
    ) {
      return true;
    }
    if (!chatUrl) {
      return false;
    }

    await page.goto(chatUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await this.getModelResponseCount(page)) > 0) {
        return true;
      }
      await page.waitForTimeout(250);
    }
    return false;
  }

  public async executeTurn(
    turn: CompiledGeminiWebTurn,
    options: GeminiWebTurnExecutionOptions = {},
  ): Promise<ParsedGeminiWebOutput> {
    const slot = await this.acquireSlot(turn.sessionKey, options.signal);

    let tempDir: string | null = null;
    try {
      const page = slot.page;
      this.ensurePageNotBlocked(page);
      await this.ensureAuthenticatedOnPage(page);

      let effectiveTurn = turn;
      if (turn.mode === "incremental") {
        const restored = await this.restoreSessionChat(slot, turn.sessionKey);
        if (!restored) {
          // The chat holding this session's context is gone (slot reused by another
          // session, bridge restarted, chat deleted): resend everything in a fresh chat.
          effectiveTurn = turn.bootstrapFallback ?? { ...turn, mode: "bootstrap" };
        }
      }
      slot.sessionKey = turn.sessionKey;

      if (effectiveTurn.mode === "bootstrap") {
        await this.startFreshConversation(page);
      }

      await this.ensureGeminiWebModelSelected(
        page,
        options.model ?? "gemini-4-argon-high",
      );

      const previousResponseCount = await this.getModelResponseCount(page);

      let promptToSend = effectiveTurn.inlinePrompt;
      if (effectiveTurn.attachmentContent && effectiveTurn.attachmentFileName) {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-gemini-web-"));
        const attachmentPath = path.join(tempDir, effectiveTurn.attachmentFileName);
        await writeFile(attachmentPath, effectiveTurn.attachmentContent, "utf8");
        const uploaded = await this.tryAttachFile(page, attachmentPath);
        if (!uploaded) {
          // Fallback: inline the attachment content directly into the composer
          promptToSend = `${effectiveTurn.attachmentContent}\n\n====================\n\n${effectiveTurn.inlinePrompt}`;
        }
      }

      await this.injectAndSubmitPrompt(page, promptToSend);

      const output = await this.streamAndCollectResponse(
        page,
        previousResponseCount,
        options,
      );
      this.rememberSessionChat(turn.sessionKey, page);
      return { ...output, executedMode: effectiveTurn.mode };
    } finally {
      this.releaseSlot(slot);
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private async ensureAuthenticatedOnPage(page: Page): Promise<void> {
    const hasGuestSignInButton = await page
      .evaluate(() => {
        const els = Array.from(document.querySelectorAll("button, a"));
        return els.some((el) => {
          const text = ((el as HTMLElement).innerText || "").trim();
          return (
            (text === "로그인" || /^sign in$/i.test(text)) &&
            (el as HTMLElement).offsetParent !== null
          );
        });
      })
      .catch(() => false);

    if (hasGuestSignInButton) {
      await page.goto(this.geminiUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
    }
  }

  /**
   * Fails fast when the tab is stuck on a Google interstitial that the bridge cannot get
   * past on its own. The page is left untouched so the user can solve it in the host window.
   */
  private ensurePageNotBlocked(page: Page): void {
    const reason = describeBlockedPage(page.url());
    if (reason) {
      throw new Error(reason);
    }
  }

  private async ensureGeminiWebModelSelected(
    page: Page,
    requestedModel: string,
  ): Promise<void> {
    const lower = requestedModel.toLowerCase();
    let targetModelKeyword = "Argon";
    let targetThinkingRegex: RegExp | null = /최고가|High/i;

    if (lower.includes("flash-lite")) {
      targetModelKeyword = "Flash-Lite";
      targetThinkingRegex = null;
    } else if (lower.includes("flash")) {
      targetModelKeyword = "Flash";
      if (lower.includes("low")) {
        targetThinkingRegex = /최저가|Low/i;
      } else if (lower.includes("medium")) {
        targetThinkingRegex = /보통|Medium/i;
      } else {
        targetThinkingRegex = /최고가|High/i;
      }
    } else if (lower.includes("3.1-pro") || lower.includes("2.5-pro")) {
      targetModelKeyword = "Pro";
      targetThinkingRegex = /최고가|High/i;
    }

    try {
      const modeBtn = page
        .locator('[data-test-id="bard-mode-menu-button"]')
        .first();
      if ((await modeBtn.count().catch(() => 0)) === 0) {
        return;
      }

      const currentLabel = (await modeBtn.innerText().catch(() => "")).trim();
      const needsModelSwitch =
        targetModelKeyword === "Flash"
          ? !currentLabel.includes("Flash") || currentLabel.includes("Flash-Lite")
          : !currentLabel.includes(targetModelKeyword);

      if (needsModelSwitch) {
        await modeBtn.click({ timeout: 2500 });
        await page.waitForTimeout(300);
        await page.evaluate((kw) => {
          const items = Array.from(
            document.querySelectorAll("gem-menu-item, [role='menuitem'], [role='menuitemradio']"),
          );
          const match = items.find((el) => {
            const txt = ((el as HTMLElement).innerText || "").trim();
            if (el.getAttribute("aria-disabled") === "true") return false;
            if (kw === "Flash") {
              return txt.includes("Flash") && !txt.includes("Flash-Lite");
            }
            return txt.includes(kw);
          }) as HTMLElement | undefined;
          if (match) {
            match.click();
          }
        }, targetModelKeyword);
        await page.waitForTimeout(250);
      }

      if (targetThinkingRegex) {
        const updatedLabel = (await modeBtn.innerText().catch(() => "")).trim();
        if (!targetThinkingRegex.test(updatedLabel)) {
          await modeBtn.click({ timeout: 2500 });
          await page.waitForTimeout(300);
          await page.evaluate((patternSource) => {
            const re = new RegExp(patternSource, "i");
            const items = Array.from(
              document.querySelectorAll("gem-menu-item, [role='menuitem'], [role='menuitemradio']"),
            );
            const match = items.find((el) => {
              const txt = ((el as HTMLElement).innerText || "").trim();
              return (
                el.getAttribute("aria-disabled") !== "true" && re.test(txt)
              );
            }) as HTMLElement | undefined;
            if (match) {
              match.click();
            }
          }, targetThinkingRegex.source);
          await page.waitForTimeout(250);
        }
      }

      await page.keyboard.press("Escape").catch(() => undefined);
    } catch {
      // Non-fatal: continue if mode selector UI is absent (e.g. in unit/E2E mock page)
    }
  }

  private async startFreshConversation(page: Page): Promise<void> {
    const currentUrl = page.url();
    const targetOrigin = new URL(this.geminiUrl).origin;
    const existingResponses = await this.getModelResponseCount(page);

    if (!currentUrl.startsWith(targetOrigin)) {
      await page.goto(this.geminiUrl, { waitUntil: "domcontentloaded" });
    } else if (existingResponses > 0 || /\/app\/[a-zA-Z0-9_-]+/.test(currentUrl)) {
      // Try clicking the New Chat button in Gemini Web sidebar/header first for speed
      const newChatClicked = await page
        .evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll(
              'a[aria-label*="New chat" i], button[aria-label*="New chat" i], a[aria-label*="새 채팅" i], button[aria-label*="새 채팅" i], [data-test-id="new-chat-button"]',
            ),
          );
          const visible = candidates.find(
            (el) =>
              (el as HTMLElement).offsetParent !== null &&
              el.getAttribute("aria-disabled") !== "true" &&
              !(el as HTMLButtonElement).disabled,
          ) as HTMLElement | undefined;
          if (visible) {
            visible.click();
            return true;
          }
          return false;
        })
        .catch(() => false);

      if (newChatClicked) {
        await page.waitForTimeout(450);
      }

      if ((await this.getModelResponseCount(page)) > 0) {
        await page.goto(this.geminiUrl, { waitUntil: "domcontentloaded" });
      }
    }

    await this.waitForComposer(page);
  }

  private async waitForComposer(page: Page): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const selector of COMPOSER_SELECTORS) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count > 0) {
          return selector;
        }
      }
      await page.waitForTimeout(200);
    }
    throw new Error(
      "Gemini Web composer not found. Make sure you are signed in to https://gemini.google.com/app in the Electron host window.",
    );
  }

  private async tryAttachFile(page: Page, filePath: string): Promise<boolean> {
    try {
      const fileInputs = page.locator('input[type="file"]');
      if ((await fileInputs.count()) > 0) {
        await fileInputs.first().setInputFiles(filePath);
        await page.waitForTimeout(400);
        return true;
      }
    } catch {
      // Fallback to inline injection
    }
    return false;
  }

  private async injectAndSubmitPrompt(
    page: Page,
    promptText: string,
  ): Promise<void> {
    const composerSelector = await this.waitForComposer(page);
    const locator = page.locator(composerSelector).first();
    await locator.click({ timeout: 5_000 });

    await page.evaluate(
      ({ selector, text }) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) {
          throw new Error(`Composer element not found for ${selector}`);
        }
        el.focus();
        if (
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLInputElement
        ) {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }

        // Contenteditable (Quill / rich-textarea in Gemini Web)
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const inserted = document.execCommand("insertText", false, text);
        if (!inserted) {
          el.textContent = text;
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: text,
            }),
          );
        }
      },
      { selector: composerSelector, text: promptText },
    );

    await page.waitForTimeout(120);

    // Click Send button if visible & enabled, otherwise press Enter
    let sent = false;
    for (const sendSelector of SEND_BUTTON_SELECTORS) {
      const btn = page.locator(sendSelector).first();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        sent = true;
        break;
      }
    }

    if (!sent) {
      await locator.press("Enter");
    }
  }

  private async getModelResponseCount(page: Page): Promise<number> {
    return page
      .evaluate(() => {
        return document.querySelectorAll("model-response").length;
      })
      .catch(() => 0);
  }

  private async streamAndCollectResponse(
    page: Page,
    previousResponseCount: number,
    options: GeminiWebTurnExecutionOptions,
  ): Promise<ParsedGeminiWebOutput> {
    const markdownBuffer = new GeminiMarkdownBuffer({ holdbackChars: 12 });
    const toolFilter = new StreamingToolCallFilter();
    let emittedThoughtLength = 0;
    let latestThoughtText = "";
    let lastHtml = "";
    let lastChangeTime = Date.now();
    let responseStarted = false;
    const startTime = Date.now();

    while (Date.now() - startTime < this.turnTimeoutMs) {
      if (options.signal?.aborted) {
        await this.tryStopGeneration(page);
        throw new Error("Gemini Web turn aborted by client.");
      }
      this.ensurePageNotBlocked(page);

      const snapshot = await page.evaluate((prevCount) => {
        const modelResponses = Array.from(
          document.querySelectorAll("model-response"),
        );
        const targetRoot =
          modelResponses.length > prevCount
            ? modelResponses[modelResponses.length - 1]
            : null;

        if (!targetRoot) {
          return null;
        }

        const thoughtEl = targetRoot.querySelector(
          "model-thoughts, .model-thoughts, .thoughts-content, [data-test-id*='thought']",
        ) as HTMLElement | null;
        const thoughtText = thoughtEl ? (thoughtEl.innerText || "").trim() : "";

        // Select only message-content / .markdown (or fallback to targetRoot only in mock/test DOMs
        // that do not use <message-content> or <structured-content-container>)
        const hasStructuredContainer = Boolean(
          targetRoot.querySelector("structured-content-container, message-content, model-thoughts"),
        );
        const contentEl = hasStructuredContainer
          ? ((targetRoot.querySelector("message-content .markdown") as HTMLElement | null) ??
             (targetRoot.querySelector("message-content") as HTMLElement | null))
          : ((targetRoot.querySelector(".markdown, .model-response-text") as HTMLElement | null) ??
             (targetRoot as HTMLElement));

        let html = "";
        if (contentEl) {
          const clone = contentEl.cloneNode(true) as HTMLElement;
          for (const t of Array.from(
            clone.querySelectorAll(
              "model-thoughts, .model-thoughts, .thoughts-content, [data-test-id*='thought' i], [class*='thought' i]",
            ),
          )) {
            t.remove();
          }
          html = clone.innerHTML;
        }

        const stopBtn = document.querySelector(
          'button[aria-label*="Stop" i], button[aria-label*="중지" i], button.stop-button, button.send-button.stop, [data-test-id*="stop" i], mat-icon[data-mat-icon-name="stop"], mat-icon[fonticon="stop"]',
        ) as HTMLElement | null;
        const isStopVisible = Boolean(
          stopBtn &&
            (stopBtn.offsetParent !== null ||
              stopBtn.getClientRects().length > 0),
        );
        const ariaBusy =
          targetRoot.getAttribute("aria-busy") === "true" ||
          (contentEl ? contentEl.getAttribute("aria-busy") === "true" : false) ||
          Boolean(
            targetRoot.querySelector(
              '[aria-busy="true"], mat-progress-bar, mat-spinner, .loading-indicator',
            ),
          );

        return {
          html,
          thoughtText,
          isGenerating: isStopVisible || ariaBusy,
        };
      }, previousResponseCount);

      if (snapshot) {
        if (snapshot.thoughtText.length > emittedThoughtLength) {
          const thoughtDelta = snapshot.thoughtText.slice(emittedThoughtLength);
          emittedThoughtLength = snapshot.thoughtText.length;
          latestThoughtText = snapshot.thoughtText;
          lastChangeTime = Date.now();
          options.onEvent?.({ type: "thought_delta", delta: thoughtDelta });
        }

        if (snapshot.html !== lastHtml) {
          lastHtml = snapshot.html;
          const rawMdDelta = markdownBuffer.pushHtmlSnapshot(snapshot.html);
          if (markdownBuffer.getLatestFullText().trim().length > 0) {
            responseStarted = true;
            lastChangeTime = Date.now();
          }

          if (rawMdDelta) {
            const visibleDelta = toolFilter.pushDelta(rawMdDelta);
            if (visibleDelta) {
              options.onEvent?.({ type: "text_delta", delta: visibleDelta });
            }
          }
        }

        // Early stop if a complete `</antigravity_tool_call>` tag is already present in the DOM
        const currentMdLower = markdownBuffer.getLatestFullText().toLowerCase();
        if (
          currentMdLower.includes(TOOL_CALL_CLOSE_TAG) ||
          snapshot.html.toLowerCase().includes(TOOL_CALL_CLOSE_TAG) ||
          snapshot.html
            .toLowerCase()
            .includes("&lt;/antigravity_tool_call&gt;")
        ) {
          if (snapshot.isGenerating) {
            await this.tryStopGeneration(page);
          }
          break;
        }

        const idleMs = Date.now() - lastChangeTime;
        if (
          responseStarted &&
          !snapshot.isGenerating &&
          idleMs >= this.stableWindowMs
        ) {
          break;
        }
      }

      await page.waitForTimeout(this.pollIntervalMs);
    }

    const finalMd = markdownBuffer.finalize({ html: lastHtml });
    if (finalMd.delta) {
      const tailDelta = toolFilter.pushDelta(finalMd.delta);
      if (tailDelta) {
        options.onEvent?.({ type: "text_delta", delta: tailDelta });
      }
    }

    const finalized = toolFilter.finalize(
      latestThoughtText,
      finalMd.fullText,
    );
    if (finalized.remainingVisibleDelta) {
      options.onEvent?.({
        type: "text_delta",
        delta: finalized.remainingVisibleDelta,
      });
    }

    if (finalized.parsed.toolCalls.length > 0) {
      options.onEvent?.({
        type: "tool_calls",
        toolCalls: finalized.parsed.toolCalls,
      });
    }

    options.onEvent?.({
      type: "completed",
      visibleText: finalized.parsed.visibleText,
      thoughtText: finalized.parsed.thoughtText,
      toolCalls: finalized.parsed.toolCalls,
    });

    return finalized.parsed;
  }

  private async tryStopGeneration(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const stopBtn = document.querySelector(
          'button[aria-label*="Stop" i], button[aria-label*="중지" i], button.stop-button',
        ) as HTMLElement | null;
        if (stopBtn && stopBtn.offsetParent !== null) {
          stopBtn.click();
        }
      })
      .catch(() => undefined);
  }
}
