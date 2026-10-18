import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compileChromiumStealthProfile,
  ensureChromeStealthExtension,
} from "./chrome-stealth.js";

export const DEFAULT_CHROMIUM_PATHS = [
  process.env.CHROMIUM_KERNEL_PATH ?? "",
  process.env.CHROME_EXECUTABLE_PATH ?? "",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

export interface LaunchChromiumStealthHostOptions {
  cdpPort?: number;
  profileId?: string;
  userDataDir?: string;
  baseStateDir?: string;
  executablePath?: string;
  chromeFullVersion?: string;
  targetUrl?: string;
}

export interface PreparedChromiumStealthEnvironment {
  executablePath: string;
  isCustomKernel: boolean;
  userDataDir: string;
  extensionDir: string;
  userAgent: string;
  args: string[];
}

export function resolveChromiumExecutable(explicitPath?: string): {
  executablePath: string;
  isCustomKernel: boolean;
} {
  const candidates = explicitPath
    ? [explicitPath, ...DEFAULT_CHROMIUM_PATHS]
    : DEFAULT_CHROMIUM_PATHS;

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      const base = path.basename(candidate).toLowerCase();
      const isCustomKernel = !base.startsWith("chrome");
      return {
        executablePath: candidate,
        isCustomKernel,
      };
    }
  }

  throw new Error(
    `Could not find Chrome/Chromium executable. Checked: ${candidates.join(", ")}`,
  );
}

/**
 * Materializes the MV3 Chrome stealth extension (`manifest.json`, `background.mjs`, `content_human_paste.js`)
 * and Chromium profile config files on disk, and returns the exact command-line arguments to launch Chrome with CDP enabled.
 */
export async function prepareChromiumStealthEnvironment(
  options: LaunchChromiumStealthHostOptions = {},
): Promise<PreparedChromiumStealthEnvironment> {
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

  const extensionDir = await ensureChromeStealthExtension(baseStateDir);

  const compiled = await compileChromiumStealthProfile({
    profileId,
    profileDir: userDataDir,
    extensionPaths: [extensionDir],
    chromeFullVersion,
  });

  const { executablePath, isCustomKernel } = resolveChromiumExecutable(
    options.executablePath,
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
