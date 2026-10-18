import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function buildInstallPathsForCandidate(
  baseDir: string,
  platform: NodeJS.Platform,
): AntigravityInstallPaths {
  if (platform === "darwin") {
    const isAppBundle = baseDir.endsWith(".app");
    const antigravityExe = isAppBundle
      ? path.join(baseDir, "Contents", "MacOS", "Antigravity")
      : path.join(baseDir, "Antigravity");
    const primaryLs = isAppBundle
      ? path.join(baseDir, "Contents", "Resources", "bin", "language_server")
      : path.join(baseDir, "resources", "bin", "language_server");
    const altLs = isAppBundle
      ? path.join(
          baseDir,
          "Contents",
          "Resources",
          "app",
          "resources",
          "bin",
          "language_server",
        )
      : primaryLs;
    const languageServerExe =
      existsSync(altLs) && !existsSync(primaryLs) ? altLs : primaryLs;
    return {
      antigravityExe,
      languageServerExe,
      exists: existsSync(antigravityExe) && existsSync(languageServerExe),
    };
  }

  if (platform === "linux") {
    const antigravityExe = path.join(baseDir, "antigravity");
    const languageServerExe = path.join(
      baseDir,
      "resources",
      "bin",
      "language_server",
    );
    return {
      antigravityExe,
      languageServerExe,
      exists: existsSync(antigravityExe) && existsSync(languageServerExe),
    };
  }

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

export function resolveAntigravityPaths(
  customBaseDir?: string,
  platform: NodeJS.Platform = process.platform,
): AntigravityInstallPaths {
  if (customBaseDir) {
    return buildInstallPathsForCandidate(customBaseDir, platform);
  }

  if (platform === "darwin") {
    const candidates = [
      "/Applications/Antigravity.app",
      path.join(os.homedir(), "Applications", "Antigravity.app"),
    ];
    for (const candidate of candidates) {
      const resolved = buildInstallPathsForCandidate(candidate, platform);
      if (resolved.exists) {
        return resolved;
      }
    }
    return buildInstallPathsForCandidate(candidates[0], platform);
  }

  if (platform === "linux") {
    const candidates = [
      "/opt/antigravity",
      "/opt/Antigravity",
      "/usr/share/antigravity",
      "/usr/lib/antigravity",
      path.join(os.homedir(), ".local", "share", "antigravity"),
    ];
    for (const candidate of candidates) {
      const resolved = buildInstallPathsForCandidate(candidate, platform);
      if (resolved.exists) {
        return resolved;
      }
    }
    return buildInstallPathsForCandidate(candidates[0], platform);
  }

  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const candidates = [
    path.join(localAppData, "Programs", "antigravity"),
    path.join(programFiles, "Antigravity"),
  ];
  for (const candidate of candidates) {
    const resolved = buildInstallPathsForCandidate(candidate, platform);
    if (resolved.exists) {
      return resolved;
    }
  }
  return buildInstallPathsForCandidate(candidates[0], platform);
}

/**
 * Rewrites `--cloud_code_endpoint` in a `language_server` CLI argument array
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

function getLinuxEnvFilePath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(
    configHome,
    "environment.d",
    "antigravity-gemini-web.conf",
  );
}

export async function getUserEnvCloudCodeUrl(): Promise<string | null> {
  if (process.platform === "win32") {
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

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "launchctl",
        ["getenv", "CLOUD_CODE_URL"],
        { timeout: 5_000 },
      );
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return process.env.CLOUD_CODE_URL ?? null;
    }
  }

  if (process.platform === "linux") {
    const envFile = getLinuxEnvFilePath();
    if (existsSync(envFile)) {
      try {
        const content = readFileSync(envFile, "utf8");
        const match = /^CLOUD_CODE_URL=(.+)$/m.exec(content);
        if (match?.[1]) {
          return match[1].trim();
        }
      } catch {
        // Ignore read error
      }
    }
    return process.env.CLOUD_CODE_URL ?? null;
  }

  return process.env.CLOUD_CODE_URL ?? null;
}

export const getWindowsUserEnvCloudCodeUrl = getUserEnvCloudCodeUrl;

export async function getAntigravityHookStatus(
  expectedBridgeUrl = "http://127.0.0.1:8787",
): Promise<AntigravityHookStatus> {
  const installPaths = resolveAntigravityPaths();
  const processCloudCodeUrl = process.env.CLOUD_CODE_URL ?? null;
  const userEnvCloudCodeUrl = await getUserEnvCloudCodeUrl();
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
    return;
  }

  if (process.platform === "darwin") {
    try {
      await execFileAsync("launchctl", ["setenv", "CLOUD_CODE_URL", bridgeUrl], {
        timeout: 5_000,
      });
    } catch {
      // Ignore if launchctl is unavailable in headless environments
    }
    return;
  }

  if (process.platform === "linux") {
    const envFile = getLinuxEnvFilePath();
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, `CLOUD_CODE_URL=${bridgeUrl}\n`, "utf8");
    try {
      await execFileAsync(
        "systemctl",
        ["--user", "set-environment", `CLOUD_CODE_URL=${bridgeUrl}`],
        { timeout: 5_000 },
      );
    } catch {
      // Ignore if systemd user session is unavailable
    }
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
    return;
  }

  if (process.platform === "darwin") {
    try {
      await execFileAsync("launchctl", ["unsetenv", "CLOUD_CODE_URL"], {
        timeout: 5_000,
      });
    } catch {
      // Ignore if launchctl is unavailable
    }
    return;
  }

  if (process.platform === "linux") {
    const envFile = getLinuxEnvFilePath();
    if (existsSync(envFile)) {
      rmSync(envFile, { force: true });
    }
    try {
      await execFileAsync(
        "systemctl",
        ["--user", "unset-environment", "CLOUD_CODE_URL"],
        { timeout: 5_000 },
      );
    } catch {
      // Ignore if systemd user session is unavailable
    }
  }
}

export function resolveStockAntigravityUserDataDir(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Antigravity",
    );
  }
  if (platform === "linux") {
    const configHome =
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    return path.join(configHome, "Antigravity");
  }
  const roamingAppData =
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roamingAppData, "Antigravity");
}

export function prepareIsolatedAntigravityUserDataDir(
  customDir?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const targetDir =
    customDir ??
    path.join(os.homedir(), ".antigravity-gemini-web", "agy-bridge-profile");
  mkdirSync(targetDir, { recursive: true });

  const stockUserDataDir = resolveStockAntigravityUserDataDir(platform);

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
 * Spawns an isolated multi-instance Antigravity binary with its own `--user-data-dir`
 * and `CLOUD_CODE_URL` injected into its process environment so `language_server`
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
