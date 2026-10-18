const { webFrame } = require("electron");

const CHROME_FULL_VERSION =
  process.versions.chrome || "153.0.8010.27";
const CHROME_MAJOR = CHROME_FULL_VERSION.split(".")[0] || "153";

function resolvePreloadPlatformConfig() {
  const plat = process.platform;
  const isArm = process.arch === "arm64";
  if (plat === "darwin") {
    return {
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
      osPlatform: "macOS",
      navPlatform: "MacIntel",
      platformVersion: "14.5.0",
      arch: "arm",
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: "ANGLE (Apple, Apple M3, OpenGL 4.1)",
    };
  }
  if (plat === "linux") {
    const linuxToken = isArm ? "X11; Linux aarch64" : "X11; Linux x86_64";
    return {
      userAgent: `Mozilla/5.0 (${linuxToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
      osPlatform: "Linux",
      navPlatform: isArm ? "Linux aarch64" : "Linux x86_64",
      platformVersion: "6.8.0",
      arch: isArm ? "arm" : "x86",
      webglVendor: "Google Inc. (Mesa)",
      webglRenderer:
        "ANGLE (Mesa, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)",
    };
  }
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    osPlatform: "Windows",
    navPlatform: "Win32",
    platformVersion: "15.0.0",
    arch: isArm ? "arm" : "x86",
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  };
}

const HOST_CFG = resolvePreloadPlatformConfig();

const MAIN_WORLD_STEALTH_SCRIPT = `(function() {
  const cfg = {
    userAgent: ${JSON.stringify(HOST_CFG.userAgent)},
    fullVersion: ${JSON.stringify(CHROME_FULL_VERSION)},
    major: ${JSON.stringify(CHROME_MAJOR)},
    osPlatform: ${JSON.stringify(HOST_CFG.osPlatform)},
    navPlatform: ${JSON.stringify(HOST_CFG.navPlatform)},
    platformVersion: ${JSON.stringify(HOST_CFG.platformVersion)},
    arch: ${JSON.stringify(HOST_CFG.arch)},
    languages: ["ko-KR", "ko", "en-US", "en"],
    webglVendor: ${JSON.stringify(HOST_CFG.webglVendor)},
    webglRenderer: ${JSON.stringify(HOST_CFG.webglRenderer)}
  };

  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => false,
      configurable: true,
      enumerable: true
    });
  } catch {}

  try {
    Object.defineProperty(Navigator.prototype, "userAgent", { get: () => cfg.userAgent, configurable: true });
    Object.defineProperty(Navigator.prototype, "appVersion", { get: () => cfg.userAgent.replace(/^Mozilla\\//, ""), configurable: true });
    Object.defineProperty(Navigator.prototype, "platform", { get: () => cfg.navPlatform, configurable: true });
    Object.defineProperty(Navigator.prototype, "vendor", { get: () => "Google Inc.", configurable: true });
    Object.defineProperty(Navigator.prototype, "languages", { get: () => Object.freeze([...cfg.languages]), configurable: true });
    Object.defineProperty(Navigator.prototype, "language", { get: () => cfg.languages[0], configurable: true });
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 8, configurable: true });
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 0, configurable: true });
  } catch {}

  try {
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
    if (!window.chrome) window.chrome = {};
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

try {
  webFrame.executeJavaScript(MAIN_WORLD_STEALTH_SCRIPT);
} catch {
  // Ignore if frame not ready
}
