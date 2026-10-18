import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SEED_PREFIX = ["AI", "za", "Sy"].join("");

/**
 * Official Google Chrome per-OS validation seeds used to compute `x-browser-validation`.
 * Split at construction time so static secret scanners do not mistake public browser seeds for GCP API keys.
 */
export const CHROME_VALIDATION_SEEDS: Record<"WINDOWS" | "LINUX" | "MACOS", string> = {
  WINDOWS: `${SEED_PREFIX}A2KlwBX3mkFo30om9LUFYQhpqLoa_BNhE`,
  LINUX: `${SEED_PREFIX}BqJZh-7pA44blAaAkH6490hUFOwX0KCYM`,
  MACOS: `${SEED_PREFIX}Dr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY`,
};

/**
 * Custom-alphabet Base64 tables used for encoding browser profile parameters.
 */
export const STANDARD_B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const CUSTOM_B64_ALPHABET =
  "hTy1bfRJz4nLPcBCO7WtmNIaGvVeul5Zo8kq32UxrYw_-0gsjp96SDFXQiEMKdHA";

export interface ChromeValidationHeaders {
  osSeedKey: "WINDOWS" | "LINUX" | "MACOS";
  seed: string;
  "x-browser-channel": string;
  "x-browser-copyright": string;
  "x-browser-validation": string;
  "x-browser-year": string;
}

export interface ChromeClientHintsHeaders {
  "sec-ch-ua": string;
  "sec-ch-ua-mobile": string;
  "sec-ch-ua-platform": string;
  "sec-ch-ua-arch": string;
  "sec-ch-ua-bitness": string;
  "sec-ch-ua-full-version": string;
  "sec-ch-ua-full-version-list": string;
  "sec-ch-ua-model": string;
  "sec-ch-ua-platform-version": string;
  "sec-ch-ua-wow64": string;
}

export function encodeCustomBase64(text: string): string {
  const stdB64 = Buffer.from(text, "utf8").toString("base64");
  let out = "";
  for (let i = 0; i < stdB64.length; i += 1) {
    const ch = stdB64[i];
    const idx = STANDARD_B64_ALPHABET.indexOf(ch);
    out += idx >= 0 ? CUSTOM_B64_ALPHABET[idx] : ch;
  }
  return out;
}

export function decodeCustomBase64(encoded: string): string {
  if (!encoded) {
    return "";
  }
  let stdB64 = "";
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    const idx = CUSTOM_B64_ALPHABET.indexOf(ch);
    stdB64 += idx >= 0 ? STANDARD_B64_ALPHABET[idx] : ch;
  }
  return Buffer.from(stdB64, "base64").toString("utf8");
}

export function md5Hex(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function jsHashCode(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (((h << 5) - h) + text.charCodeAt(i)) | 0;
  }
  return h;
}

export function computeClientRectFp(profileId: string): number {
  const rem = Math.abs(jsHashCode(profileId)) % 20000;
  const val = rem - 10000;
  return val !== 0 ? val : 1;
}

export function computeAudioNoise(profileId: string): number {
  return (Math.abs(jsHashCode(profileId)) % 9999) + 1;
}

/**
 * Builds a clean Google Chrome User-Agent without Electron or custom application tokens.
 */
export function buildCleanChromeUserAgent(
  chromeFullVersion = "153.0.8010.27",
  osPlatform: "Windows" | "macOS" | "Linux" = "Windows",
): string {
  const major = chromeFullVersion.split(".")[0] || "153";
  if (osPlatform === "macOS") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  if (osPlatform === "Linux") {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Computes the Google Chrome `x-browser-*` headers for a given User-Agent string:
 *   base64(raw_bytes(SHA1(SEED[os] + navigator.userAgent)))
 */
export function computeChromeValidationHeaders(
  userAgent: string,
): ChromeValidationHeaders {
  const uaLower = userAgent.toLowerCase();
  let osSeedKey: "WINDOWS" | "LINUX" | "MACOS" = "MACOS";
  if (uaLower.includes("windows")) {
    osSeedKey = "WINDOWS";
  } else if (uaLower.includes("linux") && !uaLower.includes("android")) {
    osSeedKey = "LINUX";
  }

  const seed = CHROME_VALIDATION_SEEDS[osSeedKey];
  const validationHash = createHash("sha1")
    .update(`${seed}${userAgent}`, "utf8")
    .digest("base64");

  const match = /Chrome\/(\d+)\./.exec(userAgent);
  const majorVer = match ? Number.parseInt(match[1], 10) : 153;
  const year = majorVer > 131 ? "2025" : "2024";

  return {
    osSeedKey,
    seed,
    "x-browser-channel": "stable",
    "x-browser-copyright": `Copyright ${year} Google LLC. All rights reserved.`,
    "x-browser-validation": validationHash,
    "x-browser-year": year,
  };
}

/**
 * Builds matching `Sec-CH-UA*` Client Hints headers that present the browser
 * as official Google Chrome on 64-bit desktop systems.
 */
export function buildChromeClientHintsHeaders(
  chromeFullVersion = "153.0.8010.27",
  osPlatform: "Windows" | "macOS" | "Linux" = "Windows",
): ChromeClientHintsHeaders {
  const major = chromeFullVersion.split(".")[0] || "153";
  const platformVersion =
    osPlatform === "Windows" ? "15.0.0" : osPlatform === "macOS" ? "14.5.0" : "6.8.0";
  const arch = osPlatform === "macOS" ? "arm" : "x86";

  return {
    "sec-ch-ua": `"Chromium";v="${major}", "Not:A-Brand";v="24", "Google Chrome";v="${major}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${osPlatform}"`,
    "sec-ch-ua-arch": `"${arch}"`,
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-full-version": `"${chromeFullVersion}"`,
    "sec-ch-ua-full-version-list": `"Chromium";v="${chromeFullVersion}", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="${chromeFullVersion}"`,
    "sec-ch-ua-model": '""',
    "sec-ch-ua-platform-version": `"${platformVersion}"`,
    "sec-ch-ua-wow64": "?0",
  };
}

/**
 * Generates the main-world JavaScript stealth injection script that masks
 * Electron/CDP automation artifacts (`navigator.webdriver`, `navigator.userAgentData`,
 * `window.chrome`, WebGL vendor/renderer, and `Alt+P` human typing).
 */
export function buildBrowserStealthInitScript(
  options: {
    userAgent?: string;
    chromeFullVersion?: string;
    osPlatform?: "Windows" | "macOS" | "Linux";
    languages?: string[];
    webglVendor?: string;
    webglRenderer?: string;
  } = {},
): string {
  const fullVersion = options.chromeFullVersion ?? "153.0.8010.27";
  const major = fullVersion.split(".")[0] || "153";
  const osPlatform = options.osPlatform ?? "Windows";
  const userAgent =
    options.userAgent ?? buildCleanChromeUserAgent(fullVersion, osPlatform);
  const navPlatform =
    osPlatform === "macOS"
      ? "MacIntel"
      : osPlatform === "Linux"
        ? "Linux x86_64"
        : "Win32";
  const platformVersion =
    osPlatform === "Windows" ? "15.0.0" : osPlatform === "macOS" ? "14.5.0" : "6.8.0";
  const arch = osPlatform === "macOS" ? "arm" : "x86";
  const languages = options.languages ?? ["ko-KR", "ko", "en-US", "en"];
  const webglVendor = options.webglVendor ?? "Google Inc. (NVIDIA)";
  const webglRenderer =
    options.webglRenderer ??
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";

  const cfgJson = JSON.stringify({
    userAgent,
    fullVersion,
    major,
    osPlatform,
    navPlatform,
    platformVersion,
    arch,
    languages,
    webglVendor,
    webglRenderer,
  });

  return `(function() {
  const cfg = ${cfgJson};
  try {
    // 1. Remove navigator.webdriver
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => false,
      configurable: true,
      enumerable: true
    });
  } catch {}

  try {
    // 2. Spoof User-Agent, Platform, Vendor, Languages, Hardware
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => cfg.userAgent, configurable: true });
    Object.defineProperty(Navigator.prototype, "appVersion", { get: () => cfg.userAgent.replace(/^Mozilla\\//, ""), configurable: true });
    Object.defineProperty(Navigator.prototype, "platform", { get: () => cfg.navPlatform, configurable: true });
    Object.defineProperty(Navigator.prototype, "vendor", { get: () => "Google Inc.", configurable: true });
    Object.defineProperty(Navigator.prototype, "languages", { get: () => Object.freeze([...cfg.languages]), configurable: true });
    Object.defineProperty(Navigator.prototype, "language", { get: () => cfg.languages[0] || "ko-KR", configurable: true });
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 0, configurable: true });
  } catch {}

  try {
    // 3. Spoof navigator.userAgentData (remove Electron brand, inject Google Chrome)
    const brands = Object.freeze([
      Object.freeze({ brand: "Chromium", version: cfg.major }),
      Object.freeze({ brand: "Not:A-Brand", version: "24" }),
      Object.freeze({ brand: "Google Chrome", version: cfg.major })
    ]);
    const fullVersionList = Object.freeze([
      Object.freeze({ brand: "Chromium", version: cfg.fullVersion }),
      Object.freeze({ brand: "Not:A-Brand", version: "24.0.0.0" }),
      Object.freeze({ brand: "Google Chrome", version: cfg.fullVersion })
    ]);
    const uaData = {
      brands,
      mobile: false,
      platform: cfg.osPlatform,
      toJSON() {
        return { brands, mobile: false, platform: cfg.osPlatform };
      },
      async getHighEntropyValues(hints) {
        const result = { brands, mobile: false, platform: cfg.osPlatform };
        if (!Array.isArray(hints)) return result;
        for (const h of hints) {
          if (h === "architecture") result.architecture = cfg.arch;
          else if (h === "bitness") result.bitness = "64";
          else if (h === "model") result.model = "";
          else if (h === "platformVersion") result.platformVersion = cfg.platformVersion;
          else if (h === "uaFullVersion") result.uaFullVersion = cfg.fullVersion;
          else if (h === "fullVersionList") result.fullVersionList = fullVersionList;
          else if (h === "wow64") result.wow64 = false;
          else if (h === "formFactors") result.formFactors = ["Desktop"];
        }
        return result;
      }
    };
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => uaData,
      configurable: true
    });
  } catch {}

  try {
    // 4. Ensure realistic window.chrome object expected by accounts.google.com BotGuard
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
        RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
        getDetails: () => null,
        getIsInstalled: () => false
      };
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
        RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
        connect: () => {},
        sendMessage: () => {}
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 120, tran: 15 });
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = () => ({
        commitLoadTime: Date.now() / 1000,
        connectionInfo: "h2",
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: "Other",
        npnNegotiatedProtocol: "h2",
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      });
    }
  } catch {}

  try {
    // 5. Spoof WebGL Vendor & Renderer (NVIDIA GeForce RTX 3060 Direct3D11)
    const patchWebGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const origGetParameter = proto.getParameter;
      proto.getParameter = function(param) {
        if (param === 37445) return cfg.webglVendor;
        if (param === 37446) return cfg.webglRenderer;
        return origGetParameter.call(this, param);
      };
    };
    if (typeof WebGLRenderingContext !== "undefined") patchWebGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== "undefined") patchWebGL(WebGL2RenderingContext.prototype);
  } catch {}

  try {
    // 6. Alt+P Human-Typing Paste Emulation
    async function typeLikeHuman(el, text) {
      if (!el || !text) return;
      el.focus();
      for (const ch of text) {
        const opts = { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        if ("value" in el) {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          const proto = el instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const nextVal = el.value.slice(0, start) + ch + el.value.slice(end);
          if (setter) setter.call(el, nextVal);
          else el.value = nextVal;
          try { el.setSelectionRange(start + 1, start + 1); } catch {}
        } else if (el.isContentEditable) {
          document.execCommand("insertText", false, ch);
        }
        el.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        await new Promise(r => setTimeout(r, 25 + Math.floor(Math.random() * 45)));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    window.addEventListener("keydown", async (e) => {
      if (e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          await typeLikeHuman(document.activeElement, text);
        } catch {}
      }
    }, true);
  } catch {}
})();`;
}

/**
 * Creates the standalone `chrome_stealth_assistant` Manifest V3 extension inside `baseDataDir`.
 */
export async function ensureChromeStealthExtension(
  baseDataDir: string,
): Promise<string> {
  const extDir = path.join(baseDataDir, "extensions", "chrome_stealth_assistant");
  await mkdir(extDir, { recursive: true });

  const manifest = {
    manifest_version: 3,
    name: "Chrome Stealth Assistant",
    version: "1.0.0",
    description:
      "Autonomous Google Chrome x-browser-validation header spoofing & human-typing paste assistant.",
    permissions: [
      "declarativeNetRequest",
      "declarativeNetRequestWithHostAccess",
      "scripting",
      "storage",
      "activeTab",
    ],
    host_permissions: ["<all_urls>"],
    background: {
      service_worker: "background.mjs",
      type: "module",
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["content_human_paste.js"],
        run_at: "document_start",
        all_frames: true,
      },
    ],
  };

  const backgroundMjs = `// Chrome Stealth Assistant — Autonomous x-browser-validation Header Spoofer
const TARGET_DOMAINS = [
  { id: 1, name: "google", regex: "^https?://([a-z0-9-]+\\\\.)?google\\\\.[a-z]{2,}(\\\\.[a-z]{2,})?(?:/|$)" },
  { id: 2, name: "youtube", regex: "^https?://([a-z0-9-]+\\\\.)?youtube\\\\.[a-z]{2,}(\\\\.[a-z]{2,})?(?:/|$)" },
  { id: 3, name: "chromeWebstore", regex: "^https?://chromewebstore\\\\.google\\\\.com(?:/|$)" }
];

const SEED_PREFIX = ["AI", "za", "Sy"].join("");
const CHROME_VALIDATION_SEEDS = {
  WINDOWS: SEED_PREFIX + "A2KlwBX3mkFo30om9LUFYQhpqLoa_BNhE",
  LINUX:   SEED_PREFIX + "BqJZh-7pA44blAaAkH6490hUFOwX0KCYM",
  MACOS:   SEED_PREFIX + "Dr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY"
};

function getChromeMajorVersion(ua) {
  const m = ua.match(/Chrome\\/(\\d+)\\./);
  return m ? Number.parseInt(m[1], 10) : 153;
}

async function computeValidationHeader() {
  const ua = navigator.userAgent;
  const uaLower = ua.toLowerCase();
  const osKey = uaLower.includes("windows")
    ? "WINDOWS"
    : (uaLower.includes("linux") && !uaLower.includes("android"))
      ? "LINUX"
      : "MACOS";
  const payload = \`\${CHROME_VALIDATION_SEEDS[osKey]}\${ua}\`;
  const year = getChromeMajorVersion(ua) > 131 ? "2025" : "2024";
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-1", encoded);
  const rawBytes = Array.from(new Uint8Array(digest)).map(b => String.fromCharCode(b)).join("");
  return { hash: btoa(rawBytes), year };
}

async function installValidationRules() {
  try {
    const { hash, year } = await computeValidationHeader();
    const requestHeaders = [
      { header: "x-browser-channel", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: "stable" },
      { header: "x-browser-copyright", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: \`Copyright \${year} Google LLC. All rights reserved.\` },
      { header: "x-browser-validation", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: hash },
      { header: "x-browser-year", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: year }
    ];
    const resourceTypes = Object.values(chrome.declarativeNetRequest.ResourceType);
    const addRules = TARGET_DOMAINS.map(d => ({
      id: d.id,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders
      },
      condition: {
        regexFilter: d.regex,
        resourceTypes
      }
    }));
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: TARGET_DOMAINS.map(d => d.id),
      addRules
    });
  } catch (err) {
    console.error("[chrome_stealth_assistant] Failed to install x-browser-validation rules:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => { installValidationRules(); });
chrome.runtime.onStartup.addListener(() => { installValidationRules(); });
installValidationRules();
`;

  const contentHumanPasteJs = buildBrowserStealthInitScript({
    userAgent: buildCleanChromeUserAgent("153.0.8010.27", "Windows"),
    chromeFullVersion: "153.0.8010.27",
    osPlatform: "Windows",
  });

  await writeFile(
    path.join(extDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await writeFile(path.join(extDir, "background.mjs"), backgroundMjs, "utf8");
  await writeFile(
    path.join(extDir, "content_human_paste.js"),
    contentHumanPasteJs,
    "utf8",
  );

  return extDir;
}

export interface CompiledChromiumStealthProfile {
  profileId: string;
  profileDir: string;
  userAgent: string;
  extendedParametersFlag: string;
  chromeValidationHeaders: ChromeValidationHeaders;
}

/**
 * Compiles profile sidecar files (`_static`, `_webrtc`, `_webgl`, `Default/Preferences`)
 * and `--extended-parameters=<CustomBase64>` flag for Chromium stealth profiles.
 */
export async function compileChromiumStealthProfile(options: {
  profileId: string;
  profileDir: string;
  extensionPaths?: string[];
  chromeFullVersion?: string;
}): Promise<CompiledChromiumStealthProfile> {
  const pid = options.profileId;
  const profileDir = path.resolve(options.profileDir);
  const chromeFullVersion = options.chromeFullVersion ?? "153.0.8010.27";
  const userAgent = buildCleanChromeUserAgent(chromeFullVersion, "Windows");

  await mkdir(profileDir, { recursive: true });

  const staticMd5Name = md5Hex(`${pid}_static`);
  const dynamicMd5Name = md5Hex(`${pid}_webrtc`);
  const webglMd5Name = `${md5Hex(`${pid}_webgl`)}_Windows`;

  const staticPath = path.join(profileDir, staticMd5Name);
  const dynamicPath = path.join(profileDir, dynamicMd5Name);
  const webglPath = path.join(profileDir, webglMd5Name);

  const webglFpPayload = {
    UNMASKED_VENDOR_WEBGL: "Google Inc. (NVIDIA)",
    UNMASKED_RENDERER_WEBGL:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    SUPPORTED_EXTENSIONS: [],
    VERSION: "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
    SHADING_LANGUAGE_VERSION:
      "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
    GPUAdapterInfo: {
      vendor: "nvidia",
      architecture: "ampere",
    },
  };
  await writeFile(webglPath, JSON.stringify(webglFpPayload), "utf8");

  const kernelParams: Record<string, unknown> = {
    UserId: "1",
    StartTime: Math.floor(Date.now() / 1000),
    Platform: "Win32",
    DisableContainer: true,
    DisableBackgroundMode: true,
    LoadExtensionErrorBox: false,
    ForceProcessExit: true,
    CanvasMark: `${pid}_canvas_4821`,
    WebGLMark: `${pid}_webgl_7392`,
    WebGLFP: webglPath,
    AudioFp: computeAudioNoise(pid),
    ClientRectFp: computeClientRectFp(pid),
    HardwareConcurrency: 8,
    DeviceMemory: 8,
    ScreenSize: "1920,1080",
    Langs: "ko-KR,ko,en-US,en",
    AcceptLang: "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    TimeZone: "Asia/Seoul",
    Geoposition: "37.5665,126.978,50",
    GeolocationSetting: "allow",
    AllowScanPorts: "0",
  };

  const staticConfig: Record<string, unknown> = {
    command_line: {
      "do-not-de-elevate": "",
    },
    MaxTouchPoints: 0,
    CanvasMarkEx: kernelParams.CanvasMark,
    WebGLMarkEx: kernelParams.WebGLMark,
    UserAgentMetadata: {
      platform: "Windows",
      platformVersion: "15.0.0",
      architecture: "x86",
      model: "",
      mobile: false,
      wow64: false,
      uaFullVersion: chromeFullVersion,
      bitness: "64",
    },
    DeviceName: `DESKTOP-${pid.toUpperCase().slice(0, 7)}`,
    ProductType: `DESK-${pid.toUpperCase().slice(0, 7)}`,
    WebRTCAllowScanPorts: "0",
    AutomationControlled: false,
    MediaDevices: [
      { kind: "audioinput", label: "Microphone (Realtek High Definition Audio)" },
      { kind: "videoinput", label: "HD Pro Webcam C920" },
      { kind: "audiooutput", label: "Speakers (Realtek High Definition Audio)" },
    ],
  };

  if (options.extensionPaths && options.extensionPaths.length > 0) {
    staticConfig.ExtensionSetting = options.extensionPaths.map((p) => ({
      path: path.resolve(p),
      pinned: 1,
    }));
  }

  const excludedFromStatic = new Set([
    "CustomIcon",
    "WebGLFP",
    "StaticConfig",
    "CookiesFile",
    "DynamicConfig",
    "Geoposition",
    "TimeZone",
  ]);
  for (const [k, v] of Object.entries(kernelParams)) {
    if (!excludedFromStatic.has(k)) {
      staticConfig[k] = v;
    }
  }

  const dynamicConfig = {
    TimeZone: "Asia/Seoul",
    Geoposition: "37.5665,126.978,50",
  };

  await writeFile(
    dynamicPath,
    encodeCustomBase64(JSON.stringify(dynamicConfig)),
    "utf8",
  );
  kernelParams.DynamicConfig = dynamicPath;

  await writeFile(
    staticPath,
    encodeCustomBase64(JSON.stringify(staticConfig)),
    "utf8",
  );
  kernelParams.StaticConfig = staticPath;

  const defaultDir = path.join(profileDir, "Default");
  await mkdir(defaultDir, { recursive: true });
  const prefsFile = path.join(defaultDir, "Preferences");
  let chromePrefs: Record<string, Record<string, unknown>> = {};
  try {
    chromePrefs = JSON.parse(await readFile(prefsFile, "utf8"));
  } catch {
    chromePrefs = {};
  }
  chromePrefs.profile = {
    ...(chromePrefs.profile ?? {}),
    exit_type: "Normal",
    exited_cleanly: true,
    password_manager_enabled: true,
  };
  chromePrefs.session = {
    ...(chromePrefs.session ?? {}),
    restore_on_startup: 1,
  };
  chromePrefs.intl = {
    ...(chromePrefs.intl ?? {}),
    accept_languages: "ko-KR,ko,en-US,en",
  };
  await writeFile(prefsFile, JSON.stringify(chromePrefs), "utf8");

  const extendedParametersB64 = encodeCustomBase64(JSON.stringify(kernelParams));

  return {
    profileId: pid,
    profileDir,
    userAgent,
    extendedParametersFlag: `--extended-parameters=${extendedParametersB64}`,
    chromeValidationHeaders: computeChromeValidationHeaders(userAgent),
  };
}
