#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlaywrightGeminiWebDriver } from "./driver/gemini-web-driver.js";
import {
  getAntigravityHookStatus,
  installAntigravityEnvHook,
  launchAntigravityWithBridge,
  uninstallAntigravityEnvHook,
} from "./hook/antigravity-hook.js";
import { startCcpaBridgeServer } from "./proxy/ccpa-server.js";
import { launchChromiumStealthHost } from "./stealth/chromium-launcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function resolveElectronBinary(): string {
  const require = createRequire(import.meta.url);
  const electronPath = require("electron") as string;
  return electronPath;
}

function launchElectronHost(cdpPort = 9333) {
  const electronBin = resolveElectronBinary();
  const hostScript = path.join(PROJECT_ROOT, "host", "electron-host.cjs");
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [hostScript], {
    stdio: "inherit",
    env: {
      ...cleanEnv,
      GEMINI_WEB_CDP_PORT: String(cdpPort),
    },
  });
  return child;
}

async function runDoctor(port: number, cdpPort: number): Promise<void> {
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const hookStatus = await getAntigravityHookStatus(bridgeUrl);

  let cdpHealthy = false;
  try {
    const res = await fetch(`${cdpUrl}/json/version`);
    cdpHealthy = res.ok;
  } catch {
    cdpHealthy = false;
  }

  let bridgeHealthy = false;
  try {
    const res = await fetch(`${bridgeUrl}/healthz`);
    bridgeHealthy = res.ok;
  } catch {
    bridgeHealthy = false;
  }

  console.log("=== Antigravity ↔ Gemini Web Doctor ===");
  console.log(`Antigravity Installed : ${hookStatus.installPaths.exists ? "YES" : "NO"}`);
  console.log(`  Antigravity.exe     : ${hookStatus.installPaths.antigravityExe}`);
  console.log(`  language_server.exe : ${hookStatus.installPaths.languageServerExe}`);
  console.log(`Hook Status           : ${hookStatus.isHooked ? "HOOKED" : "DEFAULT (Unmodified)"}`);
  console.log(`  Active Target URL   : ${hookStatus.activeTargetUrl}`);
  console.log(`  User CLOUD_CODE_URL : ${hookStatus.userEnvCloudCodeUrl ?? "(not set)"}`);
  console.log(`Browser CDP Host      : ${cdpHealthy ? `READY (${cdpUrl})` : `OFFLINE (${cdpUrl})`}`);
  console.log(`Local CCPA Bridge     : ${bridgeHealthy ? `RUNNING (${bridgeUrl})` : `OFFLINE (${bridgeUrl})`}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "serve";
  const port = Number(process.env.AGY_BRIDGE_PORT ?? "8787");
  const cdpPort = Number(process.env.GEMINI_WEB_CDP_PORT ?? "9333");
  const bridgeUrl = `http://127.0.0.1:${port}`;
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  if (command === "browser") {
    const useExternalChrome =
      args.includes("--chrome") ||
      args.includes("chrome") ||
      process.env.USE_CHROME_HOST === "1";

    if (useExternalChrome) {
      const { child, env } = await launchChromiumStealthHost({ cdpPort });
      console.log(
        `[cli] Launched ${env.isCustomKernel ? "Custom Chromium Kernel" : "Chrome"} on CDP ${cdpUrl}`,
      );
      console.log(`[cli]   Executable : ${env.executablePath}`);
      console.log(`[cli]   Profile    : ${env.userDataDir}`);
      console.log(`[cli]   Extension  : ${env.extensionDir}`);
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
      return;
    }

    console.log(
      `[cli] Launching Gemini Web Stealth Electron host on CDP ${cdpUrl}...`,
    );
    const child = launchElectronHost(cdpPort);
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    return;
  }

  if (command === "doctor") {
    await runDoctor(port, cdpPort);
    return;
  }

  if (command === "hook") {
    const sub = args[1] ?? "status";
    if (sub === "status") {
      const status = await getAntigravityHookStatus(bridgeUrl);
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (sub === "install") {
      await installAntigravityEnvHook(bridgeUrl);
      console.log(
        `[hook] Installed User environment variable CLOUD_CODE_URL=${bridgeUrl}. Restart Antigravity to apply.`,
      );
      return;
    }
    if (sub === "uninstall") {
      await uninstallAntigravityEnvHook();
      console.log(
        "[hook] Removed User environment variable CLOUD_CODE_URL. Restart Antigravity to restore default upstream.",
      );
      return;
    }
    if (sub === "launch") {
      const { pid } = launchAntigravityWithBridge(bridgeUrl, args.slice(2));
      console.log(
        `[hook] Launched Antigravity.exe (pid=${pid ?? "unknown"}) with CLOUD_CODE_URL=${bridgeUrl}`,
      );
      return;
    }
    throw new Error(`Unknown hook subcommand: ${sub}`);
  }

  if (command === "sniff") {
    const captureFilePath = path.join(
      PROJECT_ROOT,
      "captures",
      "ccpa-traffic.jsonl",
    );
    const handle = await startCcpaBridgeServer({
      port,
      mode: "sniff",
      captureFilePath,
    });
    console.log(
      `[sniff] Cloud Code PA transparent capture proxy listening on ${handle.url}`,
    );
    console.log(`[sniff] Recording JSONL traffic to ${captureFilePath}`);
    return;
  }

  if (command === "serve" || command === "all" || command === "up") {
    const disableAutoBrowser =
      args.includes("--no-browser") || process.env.AUTO_BROWSER === "0";
    const useExternalChrome =
      args.includes("--chrome") ||
      args.includes("chrome") ||
      process.env.USE_CHROME_HOST === "1";

    let cdpOnline = false;
    try {
      const res = await fetch(`${cdpUrl}/json/version`);
      cdpOnline = res.ok;
    } catch {
      cdpOnline = false;
    }

    let browserChild: ReturnType<typeof launchElectronHost> | undefined;
    if (!cdpOnline && !disableAutoBrowser) {
      if (useExternalChrome) {
        const launched = await launchChromiumStealthHost({ cdpPort });
        browserChild = launched.child;
        console.log(
          `[serve] Auto-launched ${launched.env.isCustomKernel ? "Custom Chromium Kernel" : "Chrome"} on CDP ${cdpUrl}`,
        );
      } else {
        console.log(
          `[serve] Auto-launching Gemini Web Stealth Electron host on CDP ${cdpUrl}...`,
        );
        browserChild = launchElectronHost(cdpPort);
      }

      // Wait up to 15s for CDP endpoint to come online
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${cdpUrl}/json/version`);
          if (res.ok) {
            cdpOnline = true;
            break;
          }
        } catch {
          // Wait for Electron CDP to start listening
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    } else if (cdpOnline) {
      console.log(`[serve] Reusing existing Gemini Web CDP host at ${cdpUrl}`);
    }

    if (args.includes("--global-hook")) {
      const status = await getAntigravityHookStatus(bridgeUrl);
      if (!status.isHooked) {
        await installAntigravityEnvHook(bridgeUrl);
        console.log(
          `[serve] Installed global CLOUD_CODE_URL=${bridgeUrl} hook.`,
        );
      }
    } else {
      const status = await getAntigravityHookStatus(bridgeUrl);
      if (status.userEnvCloudCodeUrl) {
        await uninstallAntigravityEnvHook();
        console.log(
          "[serve] Cleared global User CLOUD_CODE_URL so stock Antigravity stays on default upstream.",
        );
      }
    }

    const driver = new PlaywrightGeminiWebDriver({ cdpUrl });
    const captureFilePath = path.join(
      PROJECT_ROOT,
      "captures",
      "bridged-turns.jsonl",
    );

    const handle = await startCcpaBridgeServer({
      port,
      mode: "bridge",
      driver,
      captureFilePath,
    });

    console.log(
      `[serve] Antigravity ↔ Gemini Web Bridge listening on ${handle.url}`,
    );
    console.log(`[serve] Connected to Gemini Web CDP host at ${cdpUrl}`);

    const shouldLaunchAgy =
      args.includes("--launch-agy") ||
      (!args.includes("--no-launch-agy") && process.env.AUTO_LAUNCH_AGY !== "0");
    if (shouldLaunchAgy) {
      const { pid, userDataDir } = launchAntigravityWithBridge(bridgeUrl);
      console.log(
        `[serve] Launched isolated Antigravity.exe (pid=${pid ?? "unknown"}) -> CLOUD_CODE_URL=${bridgeUrl}`,
      );
      console.log(
        `[serve]   Isolated Profile : ${userDataDir} (Stock Antigravity unaffected)`,
      );
    }

    const cleanup = () => {
      if (browserChild && !browserChild.killed) {
        browserChild.kill();
      }
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    return;
  }

  throw new Error(
    `Unknown command "${command}". Supported: serve, all, sniff, browser, doctor, hook [status|install|uninstall|launch]`,
  );
}

main().catch((err) => {
  console.error(`[fatal] ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
