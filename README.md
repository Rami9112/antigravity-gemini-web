# antigravity-gemini-web

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6.svg)](https://www.typescriptlang.org/)
[![Platforms](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)%20%7C%20Windows%20(x64%2FARM64)%20%7C%20Linux%20(x64%2FARM64)-informational)](#supported-platforms)

A cross-platform local **Cloud Code PA (`v1internal`) reverse proxy and CDP browser driver** that bridges **Google Antigravity IDE** (`language_server`) model inference and local tool execution loops through an authenticated **Gemini Web (`https://gemini.google.com/app`)** browser session.

> **한국어 요약**: **macOS (Apple Silicon)**, **Windows (ARM64 / x64)**, **Linux (x64 / ARM64)** 전 환경에서 Google Antigravity IDE(`language_server`)의 에이전트 추론 및 로컬 도구 실행(`run_command`, `view_file`, `write_to_file`, `replace_file_content` 등) 루프를 로컬 프록시(`127.0.0.1:8787`)와 CDP 브라우저 드라이버(`127.0.0.1:9333`)를 통해 사용자의 **Gemini Web (`gemini.google.com`)** 세션으로 실시간 연결하는 브릿지입니다.

---

## Supported Platforms

| OS | CPU Architecture | Target ID | Default Antigravity Path | Browser / Stealth Profile |
| :--- | :--- | :--- | :--- | :--- |
| **macOS** *(Apple Silicon only)* | `arm64` (M1/M2/M3/M4) | `darwin-arm64` | `/Applications/Antigravity.app/Contents/MacOS/Antigravity` | `macOS` (`Sec-CH-UA-Arch: "arm"`, Apple M-series WebGL, `MACOS` validation seed) |
| **Windows** | `arm64` (Snapdragon X, etc.) | `win32-arm64` | `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` | `Windows` (`Sec-CH-UA-Arch: "arm"`, D3D11 WebGL, `WINDOWS` validation seed) |
| **Windows** | `x64` (Intel / AMD) | `win32-x64` | `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` | `Windows` (`Sec-CH-UA-Arch: "x86"`, D3D11 WebGL, `WINDOWS` validation seed) |
| **Linux** | `x64` (amd64) | `linux-x64` | `/opt/antigravity/antigravity` or `/usr/share/antigravity/antigravity` | `Linux` (`Sec-CH-UA-Arch: "x86"`, Mesa OpenGL WebGL, `LINUX` validation seed) |
| **Linux** | `arm64` (aarch64) | `linux-arm64` | `/opt/antigravity/antigravity` or `/usr/share/antigravity/antigravity` | `Linux` (`Sec-CH-UA-Arch: "arm"`, Mesa OpenGL WebGL, `LINUX` validation seed) |

---

## Key Features

- **Selective Cloud Code PA (`v1internal`) Reverse Proxy (`src/proxy/ccpa-server.ts`)**
  - Intercepts `POST /v1internal:streamGenerateContent?alt=sse` and `POST /v1internal:generateContent` requests from Antigravity's `language_server`.
  - Transparently forwards authentication, project onboarding, model catalog, and quota requests (`/v1internal:loadCodeAssist`, `/v1internal:fetchAvailableModels`, `/v1internal:retrieveUserQuotaSummary`, etc.) to `https://daily-cloudcode-pa.googleapis.com`.
  - Fast-paths internal safety classifier requests (`sir_flash_lite`) and passes background helper calls through without occupying a browser tab.

- **Retained-Chat Multi-Turn Tool Protocol (`src/protocol/tool-protocol.ts`)**
  - **Bootstrap Turn**: Compiles `systemInstruction`, `tools.functionDeclarations`, and conversation history into an OS/shell-aware structured prompt (`zsh` on macOS, `PowerShell` on Windows, `bash` on Linux) on the first turn, with automatic file attachment fallback when exceeding the inline composer budget.
  - **Structured Tool Call Parsing**: Detects `<antigravity_tool_call>{"name": "...", "args": {...}}</antigravity_tool_call>` blocks emitted by Gemini Web, repairs unescaped path backslashes in JSON arguments, strips surrounding code fences, and streams native `candidates[0].content.parts: [{ functionCall }]` SSE chunks back to `language_server`.
  - **Incremental Delta Continuation**: Anchors on assistant turns so follow-up `functionResponse` payloads send **only the newly appended tool output** in the same retained Gemini Web chat tab—without re-uploading the system prompt or tool catalog.
  - **Automatic Session Recovery**: Remembers the Gemini Web chat URL (`/app/<id>`) per session and automatically restores the chat or falls back to a full bootstrap if a tab was recycled.

- **Multi-Slot CDP Driver & Electron Browser Host (`src/driver/gemini-web-driver.ts`, `host/electron-host.cjs`)**
  - Streams live DOM updates (`<model-response>`, `<message-content>`, `<model-thoughts>`) into append-only Markdown deltas via `GeminiMarkdownBuffer`.
  - FIFO slot wait-queue when concurrent agent/subagent turns exceed available browser slots.
  - Fail-fast detection and actionable guidance when Google presents a sign-in or unusual-traffic (`/sorry` CAPTCHA) page.

- **Cross-Platform Chrome Fingerprint & Validation Header Engine (`src/stealth/chrome-stealth.ts`)**
  - Dynamically generates OS- and CPU-accurate `User-Agent`, `Sec-CH-UA` Client Hints (`"arm"` vs `"x86"`, `"macOS"` / `"Windows"` / `"Linux"`), and official Chrome `x-browser-validation` SHA-1 headers (`x-browser-channel`, `x-browser-validation`, `x-browser-year`, `x-browser-copyright`) so Google Sign-In (`accounts.google.com`) treats the host window as standard desktop Chrome on every platform.
  - Injects main-world stealth initialization (`navigator.webdriver = false`, `navigator.platform`, `navigator.userAgentData`, `window.chrome.runtime`, OS-matched WebGL vendor/renderer spoofing, and `Alt+P` human-typing paste helper).

- **Side-by-Side Isolated Antigravity Launcher (`src/hook/antigravity-hook.ts`)**
  - Spawns an isolated Antigravity IDE instance (`--user-data-dir`) seeded from the stock user profile (`~/Library/Application Support/Antigravity` on macOS, `%APPDATA%\Antigravity` on Windows, `~/.config/Antigravity` on Linux) with `CLOUD_CODE_URL=http://127.0.0.1:8787` injected into its process environment, leaving any stock Antigravity instance untouched.

---

## Architecture

```mermaid
sequenceDiagram
    participant AGY as Antigravity IDE<br/>(language_server)
    participant Proxy as Local CCPA Proxy<br/>(127.0.0.1:8787)
    participant Upstream as Google Cloud Code PA<br/>(daily-cloudcode-pa)
    participant Driver as Playwright CDP Driver<br/>(GeminiMarkdownBuffer)
    participant Web as Gemini Web Host<br/>(gemini.google.com/app)

    AGY->>Proxy: POST /v1internal:loadCodeAssist, Quota, etc.
    Proxy->>Upstream: Transparent HTTPS passthrough
    Upstream-->>AGY: Standard CCPA response

    AGY->>Proxy: POST /v1internal:streamGenerateContent?alt=sse (Turn 1)
    Proxy->>Driver: compileGeminiWebTurn (Bootstrap)
    Driver->>Web: Inject prompt & submit in retained slot
    Web-->>Driver: Stream DOM (<model-thoughts> + <message-content>)
    Driver-->>Proxy: thought_delta / text_delta / tool_calls
    Proxy-->>AGY: SSE chunks (thought + functionCall)

    Note over AGY: Executes tool locally<br/>(run_command, view_file, etc.)

    AGY->>Proxy: POST /v1internal:streamGenerateContent?alt=sse (Turn 2 + functionResponse)
    Proxy->>Driver: compileGeminiWebTurnWithFallback (Incremental Delta)
    Driver->>Web: Send <antigravity_tool_result> in same chat tab
    Web-->>Driver: Stream next tool call or final Markdown answer
    Driver-->>Proxy: SSE chunks
    Proxy-->>AGY: Complete turn (finishReason: STOP)
```

---

## Quick Start

### Prerequisites

- **Node.js** `>= 22.0.0`
- **pnpm** `>= 9.x`
- **Google Antigravity IDE** installed on macOS (Apple Silicon), Windows (ARM64 / x64), or Linux (x64 / ARM64)

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Start the Bridge & Browser Host

```bash
pnpm start
```

Running `pnpm start` (`node dist/cli.js serve`) automatically:
1. Launches the **Gemini Web Stealth Electron Host** on `127.0.0.1:9333` (if not already running).
2. Starts the local **Cloud Code PA <-> Gemini Web Bridge** on `http://127.0.0.1:8787`.
3. Launches an **isolated Antigravity IDE instance** pointed at `http://127.0.0.1:8787`.

> **First-Time Login**: In the **Antigravity Gemini Web Host** window that opens, sign in with your Google account at `https://gemini.google.com/app`. Your session is persisted across restarts in `~/.antigravity-gemini-web/electron-profile`.

---

## CLI Reference

| Command | Description |
| :--- | :--- |
| `pnpm start` | Build and start the CCPA bridge server (`127.0.0.1:8787`), auto-launch the browser host (`127.0.0.1:9333`), and open an isolated Antigravity instance. |
| `pnpm browser` | Launch only the multi-slot Stealth Electron browser host on CDP port `9333`. |
| `pnpm browser:chrome` | Launch an external Chrome/Chromium binary with the MV3 stealth extension and profile flags on CDP port `9333`. |
| `pnpm doctor` | Check host OS/CPU platform, Antigravity installation paths, `CLOUD_CODE_URL` hook state, CDP host readiness, and bridge health. |
| `pnpm sniff` | Run the proxy in transparent capture mode, recording raw `/v1internal:*` traffic to `captures/ccpa-traffic.jsonl`. |
| `pnpm hook:status` | Print JSON status of Antigravity installation paths and `CLOUD_CODE_URL` environment configuration. |
| `pnpm hook:launch` | Spawn an isolated Antigravity instance routed through `http://127.0.0.1:8787`. |
| `pnpm hook:install` | Configure persistent user `CLOUD_CODE_URL=http://127.0.0.1:8787` (`User` env on Windows, `launchctl` on macOS, `~/.config/environment.d` on Linux). |
| `pnpm hook:uninstall` | Remove the persistent user `CLOUD_CODE_URL` setting to restore default upstream routing. |

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AGY_BRIDGE_PORT` | `8787` | Local port for the Cloud Code PA reverse proxy server. |
| `GEMINI_WEB_CDP_PORT` | `9333` | Loopback Chrome DevTools Protocol (CDP) port for the browser host. |
| `GEMINI_WEB_TAB_COUNT` | `1` | Number of Gemini Web slot views to open inside the Electron host window. |
| `GEMINI_WEB_URL` | `https://gemini.google.com/app` | Target Gemini Web application URL. |
| `GEMINI_WEB_PROFILE_DIR` | `~/.antigravity-gemini-web/electron-profile` | Persistent Chromium user data directory for the Electron host. |
| `AGY_UPSTREAM_CCPA_URL` | `https://daily-cloudcode-pa.googleapis.com` | Upstream Google Cloud Code PA endpoint for passthrough routes. |
| `AUTO_BROWSER` | `1` | Set to `0` (or pass `--no-browser`) to prevent `pnpm start` from auto-launching the browser host. |
| `AUTO_LAUNCH_AGY` | `1` | Set to `0` (or pass `--no-launch-agy`) to prevent `pnpm start` from auto-spawning Antigravity. |

---

## Project Structure

```text
antigravity-gemini-web/
├── .github/workflows/
│   └── ci.yml                     # 5-target matrix CI workflow (macOS arm64, Win x64/arm64, Linux x64/arm64)
├── host/
│   ├── electron-host.cjs          # Multi-slot Electron WebContentsView host with OS/arch-aware Chrome headers
│   └── chrome-preload.cjs         # Main-world navigator/WebGL stealth & Alt+P human paste preload
├── scripts/
│   ├── check-repo.mjs             # Offline repo integrity, manifest, secret-leak & CJS syntax checker
│   └── verify.sh                  # Unified verification pipeline (check-repo + typecheck + build + tests)
├── src/
│   ├── cli.ts                     # CLI entrypoint (serve, browser, doctor, sniff, hook)
│   ├── index.ts                   # Public library exports
│   ├── types.ts                   # Cloud Code PA & Gemini Web TypeScript interfaces
│   ├── driver/
│   │   ├── dom-markdown.ts        # HTML-to-Markdown converter & incremental delta buffer
│   │   └── gemini-web-driver.ts   # Playwright CDP driver, slot queue, and session chat recovery
│   ├── hook/
│   │   └── antigravity-hook.ts    # Cross-platform Antigravity locator & isolated instance launcher
│   ├── protocol/
│   │   └── tool-protocol.ts       # OS-aware prompt compiler, <antigravity_tool_call> parser & JSON repair
│   ├── proxy/
│   │   └── ccpa-server.ts         # Selective Cloud Code PA HTTP/SSE reverse proxy
│   ├── stealth/
│   │   ├── chrome-stealth.ts      # Multi-OS/arch x-browser-validation SHA-1 & MV3 extension builder
│   │   └── chromium-launcher.ts   # Cross-platform Chrome/Chromium stealth profile launcher
│   └── utils/
│       └── platform.ts            # Runtime resolver for darwin-arm64, win32-arm64/x64, linux-x64/arm64
└── tests/                         # Unit, repo-integrity, live DOM fixture, and full CDP E2E test suites
```

---

## Development & Verification

```bash
pnpm verify      # Run check-repo + typecheck + build + unit test suite
bash scripts/verify.sh        # Unified CI verification pipeline
bash scripts/verify.sh --full # Unified verification pipeline + full CDP E2E suite
pnpm typecheck   # Run TypeScript strict type checking
pnpm build       # Compile TypeScript to dist/
pnpm test        # Run Vitest unit + CDP E2E test suites
```

---

## License

[MIT](./LICENSE)

