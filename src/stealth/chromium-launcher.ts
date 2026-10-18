import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  osPlatformToDescriptor,
  type SupportedCpuArch,
  type SupportedOsPlatform,
} from "../utils/platform.js";
import {
  compileChromiumStealthProfile,
  ensureChromeStealthExtension,
} from "./chrome-stealth.js";

/**
 * Returns candidate Chrome/Chromium binary paths for the specified OS (`win32`, `darwin`, `linux`).
 */
export function getDefaultChromiumPaths(
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicitEnv = [
    env.CHROMIUM_KERNEL_PATH ?? "",
    env.CHROME_EXECUTABLE_PATH ?? "",
  ];

  if (platform === "darwin") {
    return [
      ...explicitEnv,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.posix.join(
        homedir,
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.posix.join(
        homedir,
        "Applications/Chromium.app/Contents/MacOS/Chromium",
      ),
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ].filter(Boolean);
  }

  if (platform === "linux") {
    return [
      ...explicitEnv,
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/opt/google/chrome/chrome",
      "/opt/chromium.org/chromium/chrome",
      "/usr/local/bin/chrome",
      "/usr/local/bin/chromium",
    ].filter(Boolean);
  }

  // Windows (win32-x64 and win32-arm64)
  const progFiles = env.PROGRAMFILES ?? "C:\\Program Files";
  const progFilesX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const localAppData =
    env.LOCALAPPDATA ?? path.win32.join(homedir, "AppData", "Local");

  return [
    ...explicitEnv,
    path.win32.join(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.win32.join(
      progFilesX86,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.win32.join(
      localAppData,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.win32.join(progFiles, "Chromium", "Application", "chrome.exe"),
  ].filter(Boolean);
}

export const DEFAULT_CHROMIUM_PATHS = getDefaultChromiumPaths();

export interface LaunchChromiumStealthHostOptions {
  cdpPort?: number;
  profileId?: string;
  userDataDir?: string;
  baseStateDir?: string;
  executablePath?: string;
  chromeFullVersion?: string;
  targetUrl?: string;
  osPlatform?: SupportedOsPlatform;
  cpuArch?: SupportedCpuArch;
}

export interface PreparedChromiumStealthEnvironment {
  executablePath: string;
  isCustomKernel: boolean;
  userDataDir: string;
  extensionDir: string;
  userAgent: string;
  args: string[];
}

export function resolveChromiumExecutable(
  explicitPath?: string,
  platform: NodeJS.Platform = process.platform,
): {
  executablePath: string;
  isCustomKernel: boolean;
} {
  const defaultCandidates = getDefaultChromiumPaths(platform);
  const candidates = explicitPath
    ? [explicitPath, ...defaultCandidates]
    : defaultCandidates;

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      const base = path.basename(candidate).toLowerCase();
      const isStandardChrome =
        base.startsWith("chrome") ||
        base.startsWith("google chrome") ||
        base.startsWith("google-chrome") ||
        base.startsWith("chromium") ||
        base.startsWith("brave");
      return {
        executablePath: candidate,
        isCustomKernel: !isStandardChrome,
      };
    }
  }

  throw new Error(
    `Could not find Chrome/Chromium executable on ${platform}. Checked: ${candidates.join(", ")}`,
  );
}

/**
 * Materializes the MV3 Chrome stealth extension (`manifest.json`, `background.mjs`, `content_human_paste.js`)
 * and Chromium profile config files on disk, and returns the exact command-line arguments to launch Chrome with CDP enabled.
 */
export async function prepareChromiumStealthEnvironment(
  options: LaunchChromiumStealthHostOptions = {},
): Promise<PreparedChromiumStealthEnvironment> {
  const descriptor = osPlatformToDescriptor(options.osPlatform, options.cpuArch);
  const cdpPort = options.cdpPort ?? 9333;
  const profileId = options.profileId ?? "agy01";
  const chromeFullVersion = options.chromeFullVersion ?? "153.0.8010.27";
  const targetUrl = options.targetUrl ?? "https://gemini.google.com/app";

  const baseStateDir =
    options.baseStateDir ??
    path.join(os.homedir(), ".antigravity-gemini-web", "chromium");
  const userDataDir =
    options.userDataDir ?? path.join(baseStateDir, `profile_${profileId}`);

  await mkdir(baseStateDir, { recursive: true });

  const extensionDir = await ensureChromeStealthExtension(baseStateDir, {
    osPlatform: descriptor.osPlatform,
    cpuArch: descriptor.cpuArch,
    chromeFullVersion,
  });

  const compiled = await compileChromiumStealthProfile({
    profileId,
    profileDir: userDataDir,
    extensionPaths: [extensionDir],
    chromeFullVersion,
    osPlatform: descriptor.osPlatform,
    cpuArch: descriptor.cpuArch,
  });

  const { executablePath, isCustomKernel } = resolveChromiumExecutable(
    options.executablePath,
    descriptor.nodePlatform,
  );

  const args: string[] = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*",
    `--user-agent=${compiled.userAgent}`,
    "--lang=ko-KR",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];

  if (isCustomKernel) {
    args.push(compiled.extendedParametersFlag);
  } else {
    args.push("--disable-blink-features=AutomationControlled");
  }

  if (
    descriptor.nodePlatform === "linux" &&
    (process.env.GEMINI_WEB_NO_SANDBOX === "1" ||
      (typeof process.getuid === "function" && process.getuid() === 0))
  ) {
    args.push("--no-sandbox");
  }

  args.push(targetUrl);

  return {
    executablePath,
    isCustomKernel,
    userDataDir,
    extensionDir,
    userAgent: compiled.userAgent,
    args,
  };
}

export async function launchChromiumStealthHost(
  options: LaunchChromiumStealthHostOptions = {},
): Promise<{ child: ChildProcess; env: PreparedChromiumStealthEnvironment }> {
  const prepared = await prepareChromiumStealthEnvironment(options);
  const child = spawn(prepared.executablePath, prepared.args, {
    stdio: "ignore",
    detached: false,
  });
  return { child, env: prepared };
}
