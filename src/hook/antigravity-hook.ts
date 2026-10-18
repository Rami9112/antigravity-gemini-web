import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AntigravityInstallPaths {
  antigravityExe: string;
  languageServerExe: string;
  exists: boolean;
}

export interface AntigravityHookStatus {
  installPaths: AntigravityInstallPaths;
  processCloudCodeUrl: string | null;
  userEnvCloudCodeUrl: string | null;
  activeTargetUrl: string;
  isHooked: boolean;
}

export function resolveAntigravityPaths(
  customBaseDir?: string,
): AntigravityInstallPaths {
  const localAppData =
    process.env.LOCALAPPDATA ??
    path.join(os.homedir(), "AppData", "Local");
  const baseDir =
    customBaseDir ??
    path.join(localAppData, "Programs", "antigravity");

  const antigravityExe = path.join(baseDir, "Antigravity.exe");
  const languageServerExe = path.join(
    baseDir,
    "resources",
    "bin",
    "language_server.exe",
  );

  return {
    antigravityExe,
    languageServerExe,
    exists: existsSync(antigravityExe) && existsSync(languageServerExe),
  };
}

/**
 * Rewrites `--cloud_code_endpoint` in a `language_server.exe` CLI argument array
 * to point to the local bridge URL.
 */
export function rewriteLanguageServerArgs(
  args: readonly string[],
  bridgeUrl: string,
): string[] {
  const result = [...args];
  for (let i = 0; i < result.length; i += 1) {
    if (result[i] === "--cloud_code_endpoint" && i + 1 < result.length) {
      result[i + 1] = bridgeUrl;
      return result;
    }
    if (result[i].startsWith("--cloud_code_endpoint=")) {
      result[i] = `--cloud_code_endpoint=${bridgeUrl}`;
      return result;
    }
  }
  result.push("--cloud_code_endpoint", bridgeUrl);
  return result;
}

export async function getWindowsUserEnvCloudCodeUrl(): Promise<string | null> {
  if (process.platform !== "win32") {
    return process.env.CLOUD_CODE_URL ?? null;
  }
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('CLOUD_CODE_URL', 'User')",
      ],
      { timeout: 5_000 },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function getAntigravityHookStatus(
  expectedBridgeUrl = "http://127.0.0.1:8787",
): Promise<AntigravityHookStatus> {
  const installPaths = resolveAntigravityPaths();
  const processCloudCodeUrl = process.env.CLOUD_CODE_URL ?? null;
  const userEnvCloudCodeUrl = await getWindowsUserEnvCloudCodeUrl();
  const activeTargetUrl =
    userEnvCloudCodeUrl ??
    processCloudCodeUrl ??
    "https://daily-cloudcode-pa.googleapis.com";

  return {
    installPaths,
    processCloudCodeUrl,
    userEnvCloudCodeUrl,
    activeTargetUrl,
    isHooked:
      userEnvCloudCodeUrl === expectedBridgeUrl ||
      processCloudCodeUrl === expectedBridgeUrl,
  };
}

export async function installAntigravityEnvHook(
  bridgeUrl = "http://127.0.0.1:8787",
): Promise<void> {
  process.env.CLOUD_CODE_URL = bridgeUrl;
  if (process.platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `[Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', '${bridgeUrl.replace(/'/g, "''")}', 'User')`,
      ],
      { timeout: 5_000 },
    );
  }
}

export async function uninstallAntigravityEnvHook(): Promise<void> {
  delete process.env.CLOUD_CODE_URL;
  if (process.platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "[Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', $null, 'User')",
      ],
      { timeout: 5_000 },
    );
  }
}

export function prepareIsolatedAntigravityUserDataDir(
  customDir?: string,
): string {
  const targetDir =
    customDir ??
    path.join(os.homedir(), ".antigravity-gemini-web", "agy-bridge-profile");
  mkdirSync(targetDir, { recursive: true });

  const roamingAppData =
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const stockUserDataDir = path.join(roamingAppData, "Antigravity");

  // Seed onboarding & preferences from stock Antigravity profile if not already present
  for (const fileName of ["app_storage.json", "Preferences", "Local State"]) {
    const src = path.join(stockUserDataDir, fileName);
    const dest = path.join(targetDir, fileName);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        copyFileSync(src, dest);
      } catch {
        // Ignore if locked or unavailable
      }
    }
  }

  return targetDir;
}

/**
 * Spawns an isolated multi-instance `Antigravity.exe` with its own `--user-data-dir`
 * and `CLOUD_CODE_URL` injected into its process environment so `language_server.exe`
 * routes `/v1internal:*` traffic through the local bridge while a stock Antigravity
 * instance continues running side-by-side on the default upstream.
 */
export function launchAntigravityWithBridge(
  bridgeUrl = "http://127.0.0.1:8787",
  extraArgs: string[] = [],
): { pid: number | undefined; userDataDir: string } {
  const paths = resolveAntigravityPaths();
  if (!paths.exists) {
    throw new Error(
      `Antigravity executable not found at ${paths.antigravityExe}`,
    );
  }

  const userDataDir = prepareIsolatedAntigravityUserDataDir();
  const hasUserDataArg = extraArgs.some((arg) =>
    arg.startsWith("--user-data-dir"),
  );
  const finalArgs = hasUserDataArg
    ? [...extraArgs]
    : [`--user-data-dir=${userDataDir}`, ...extraArgs];

  const child = spawn(paths.antigravityExe, finalArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CLOUD_CODE_URL: bridgeUrl,
    },
  });
  child.unref();
  return { pid: child.pid, userDataDir };
}
