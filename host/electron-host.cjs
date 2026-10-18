const { app, BaseWindow, WebContentsView, session } = require("electron");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");

const CDP_PORT = Number(process.env.GEMINI_WEB_CDP_PORT || "9333");
const TAB_COUNT = Number(process.env.GEMINI_WEB_TAB_COUNT || "1");
const GEMINI_HOME_URL =
  process.env.GEMINI_WEB_URL || "https://gemini.google.com/app";
const PROFILE_DIR =
  process.env.GEMINI_WEB_PROFILE_DIR ||
  path.join(os.homedir(), ".antigravity-gemini-web", "electron-profile");
const PARTITION_NAME = "persist:gemini-web";

const CHROME_FULL_VERSION =
  process.versions.chrome || "153.0.8010.27";
const CHROME_MAJOR = CHROME_FULL_VERSION.split(".")[0] || "153";

const SEED_PREFIX = ["AI", "za", "Sy"].join("");
const CHROME_SEEDS = {
  WINDOWS: `${SEED_PREFIX}A2KlwBX3mkFo30om9LUFYQhpqLoa_BNhE`,
  LINUX: `${SEED_PREFIX}BqJZh-7pA44blAaAkH6490hUFOwX0KCYM`,
  MACOS: `${SEED_PREFIX}Dr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY`,
};

function resolveHostPlatformProfile() {
  const plat = process.platform;
  const isArm = process.arch === "arm64";
  if (plat === "darwin") {
    return {
      osPlatform: "macOS",
      clientHintArch: "arm",
      platformVersion: "14.5.0",
      seed: CHROME_SEEDS.MACOS,
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    };
  }
  if (plat === "linux") {
    const linuxToken = isArm ? "X11; Linux aarch64" : "X11; Linux x86_64";
    return {
      osPlatform: "Linux",
      clientHintArch: isArm ? "arm" : "x86",
      platformVersion: "6.8.0",
      seed: CHROME_SEEDS.LINUX,
      userAgent: `Mozilla/5.0 (${linuxToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    };
  }
  return {
    osPlatform: "Windows",
    clientHintArch: isArm ? "arm" : "x86",
    platformVersion: "15.0.0",
    seed: CHROME_SEEDS.WINDOWS,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  };
}

const HOST_PROFILE = resolveHostPlatformProfile();
const CLEAN_USER_AGENT = HOST_PROFILE.userAgent;
const X_BROWSER_VALIDATION = crypto
  .createHash("sha1")
  .update(`${HOST_PROFILE.seed}${CLEAN_USER_AGENT}`, "utf8")
  .digest("base64");
const X_BROWSER_YEAR = Number(CHROME_MAJOR) > 131 ? "2025" : "2024";

app.setPath("userData", PROFILE_DIR);
app.userAgentFallback = CLEAN_USER_AGENT;
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch(
  "disable-blink-features",
  "AutomationControlled",
);
app.commandLine.appendSwitch("lang", "ko-KR");
if (
  process.platform === "linux" &&
  (process.env.GEMINI_WEB_NO_SANDBOX === "1" ||
    (typeof process.getuid === "function" && process.getuid() === 0))
) {
  app.commandLine.appendSwitch("no-sandbox");
}

const HEADER_HEIGHT = 44;

function buildHeaderDataUrl(tabCount) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; user-select: none; }
  body {
    margin: 0;
    height: ${HEADER_HEIGHT}px;
    background: #131314;
    color: #e3e3e3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 8px;
    border-bottom: 1px solid #282a2c;
  }
  .brand {
    font-weight: 600;
    font-size: 13px;
    color: #a8c7fa;
    margin-right: 6px;
  }
  .badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 6px;
    background: #143622;
    color: #6dd58c;
    border: 1px solid #245c3a;
    margin-right: 6px;
  }
  .tab {
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
    background: #1e1f20;
    color: #c4c7c5;
    border: 1px solid #333537;
    transition: all 0.15s ease;
  }
  .tab.active {
    background: #004a77;
    color: #c2e7ff;
    border-color: #7fcfff;
    font-weight: 600;
  }
  .action-btn {
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 11px;
    cursor: pointer;
    background: #282a2c;
    color: #e3e3e3;
    border: 1px solid #444746;
  }
  .action-btn:hover {
    background: #37393b;
  }
  .status {
    margin-left: auto;
    font-size: 11px;
    color: #8e918f;
    display: flex;
    align-items: center;
    gap: 10px;
  }
</style>
</head>
<body>
  <div class="brand">Antigravity ↔ Gemini Web</div>
  <div class="badge">Chrome Stealth (${HOST_PROFILE.osPlatform}/${process.arch})</div>
  ${Array.from(
    { length: tabCount },
    (_, i) =>
      `<button class="tab ${i === 0 ? "active" : ""}" onclick="selectTab(${i})" id="tab-${i}">Slot ${i + 1}</button>`,
  ).join("")}
  <div class="status">
    <span>Alt+P: Human Paste</span>
    <button class="action-btn" onclick="resetAuth()">Reset Auth &amp; Reload</button>
    <span>CDP 127.0.0.1:${CDP_PORT}</span>
  </div>
  <script>
    function selectTab(idx) {
      document.querySelectorAll('.tab').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
      });
      console.log('__AGY_SELECT_TAB__:' + idx);
    }
    function resetAuth() {
      console.log('__AGY_RESET_AUTH__');
    }
  </script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

app.whenReady().then(async () => {
  const geminiSession = session.fromPartition(PARTITION_NAME);
  geminiSession.setUserAgent(CLEAN_USER_AGENT, "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");

  geminiSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };

    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      if (
        lower === "user-agent" ||
        lower.startsWith("sec-ch-ua") ||
        lower.startsWith("x-browser-")
      ) {
        delete headers[k];
      }
    }

    headers["User-Agent"] = CLEAN_USER_AGENT;
    headers["sec-ch-ua"] =
      `"Chromium";v="${CHROME_MAJOR}", "Not:A-Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`;
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = `"${HOST_PROFILE.osPlatform}"`;
    headers["sec-ch-ua-arch"] = `"${HOST_PROFILE.clientHintArch}"`;
    headers["sec-ch-ua-bitness"] = '"64"';
    headers["sec-ch-ua-full-version"] = `"${CHROME_FULL_VERSION}"`;
    headers["sec-ch-ua-full-version-list"] =
      `"Chromium";v="${CHROME_FULL_VERSION}", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="${CHROME_FULL_VERSION}"`;
    headers["sec-ch-ua-model"] = '""';
    headers["sec-ch-ua-platform-version"] = `"${HOST_PROFILE.platformVersion}"`;
    headers["sec-ch-ua-wow64"] = "?0";

    if (/^https?:\/\/([a-z0-9-]+\.)?(google|youtube|gstatic|googleapis)\./i.test(details.url)) {
      headers["x-browser-channel"] = "stable";
      headers["x-browser-copyright"] =
        `Copyright ${X_BROWSER_YEAR} Google LLC. All rights reserved.`;
      headers["x-browser-validation"] = X_BROWSER_VALIDATION;
      headers["x-browser-year"] = X_BROWSER_YEAR;
    }

    callback({ requestHeaders: headers });
  });

  const win = new BaseWindow({
    width: 1280,
    height: 900,
    show: process.env.GEMINI_WEB_HEADLESS !== "1",
    title: "Antigravity Gemini Web Host",
    backgroundColor: "#131314",
  });

  const headerView = new WebContentsView();
  win.contentView.addChildView(headerView);
  headerView.webContents.loadURL(buildHeaderDataUrl(TAB_COUNT));

  const preloadPath = path.join(__dirname, "chrome-preload.cjs");
  const slotViews = [];
  let activeSlot = 0;

  async function clearRejectedSignInAndReload() {
    await geminiSession.clearStorageData({
      origin: "https://accounts.google.com",
      storages: ["cookies", "localstorage", "serviceworkers", "cachestorage"],
    }).catch(() => undefined);
    for (let i = 0; i < slotViews.length; i += 1) {
      slotViews[i].webContents.loadURL(GEMINI_HOME_URL);
    }
  }

  for (let i = 0; i < TAB_COUNT; i += 1) {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION_NAME,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    view.webContents.setUserAgent(CLEAN_USER_AGENT);

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://accounts.google.com") || url.startsWith("https://gemini.google.com")) {
        view.webContents.loadURL(url);
      }
      return { action: "deny" };
    });

    let wasOnGoogleAuth = false;
    view.webContents.on("did-navigate", async (_event, url) => {
      if (typeof url !== "string") {
        return;
      }
      if (url.includes("/signin/rejected")) {
        await geminiSession.clearStorageData({
          origin: "https://accounts.google.com",
          storages: ["cookies", "localstorage"],
        }).catch(() => undefined);
        view.webContents.loadURL("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp");
        return;
      }
      if (url.startsWith("https://accounts.google.com")) {
        wasOnGoogleAuth = true;
        return;
      }
      if (wasOnGoogleAuth && url.startsWith("https://gemini.google.com")) {
        wasOnGoogleAuth = false;
        for (let j = 0; j < slotViews.length; j += 1) {
          if (j !== i) {
            slotViews[j].webContents.reload();
          }
        }
      }
    });

    win.contentView.addChildView(view);
    view.webContents.loadURL(GEMINI_HOME_URL);
    slotViews.push(view);
  }

  function layoutViews() {
    const bounds = win.getContentBounds();
    headerView.setBounds({
      x: 0,
      y: 0,
      width: bounds.width,
      height: HEADER_HEIGHT,
    });
    const contentHeight = Math.max(100, bounds.height - HEADER_HEIGHT);
    slotViews.forEach((view, idx) => {
      view.setBounds({
        x: 0,
        y: HEADER_HEIGHT,
        width: bounds.width,
        height: contentHeight,
      });
      view.setVisible(idx === activeSlot);
    });
  }

  headerView.webContents.on("console-message", (_event, _level, message) => {
    if (typeof message === "string" && message.startsWith("__AGY_SELECT_TAB__:")) {
      const idx = Number(message.split(":")[1]);
      if (!Number.isNaN(idx) && idx >= 0 && idx < slotViews.length) {
        activeSlot = idx;
        layoutViews();
      }
    } else if (message === "__AGY_RESET_AUTH__") {
      clearRejectedSignInAndReload();
    }
  });

  win.on("resize", layoutViews);
  layoutViews();

  console.log(
    JSON.stringify({
      status: "ready",
      platform: `${process.platform}-${process.arch}`,
      cdpUrl: `http://127.0.0.1:${CDP_PORT}`,
      tabCount: TAB_COUNT,
      profileDir: PROFILE_DIR,
      userAgent: CLEAN_USER_AGENT,
      xBrowserValidation: X_BROWSER_VALIDATION,
    }),
  );
});

app.on("window-all-closed", () => {
  app.quit();
});
