export type SupportedOsPlatform = "Windows" | "macOS" | "Linux";
export type SupportedCpuArch = "arm64" | "x64";
export type SupportedTargetId =
  | "darwin-arm64"
  | "win32-arm64"
  | "win32-x64"
  | "linux-x64"
  | "linux-arm64";

export interface PlatformDescriptor {
  targetId: SupportedTargetId;
  nodePlatform: "win32" | "darwin" | "linux";
  osPlatform: SupportedOsPlatform;
  cpuArch: SupportedCpuArch;
  /** Value for Sec-CH-UA-Arch ("arm" or "x86") */
  clientHintArch: "arm" | "x86";
  /** Value for Sec-CH-UA-Platform-Version */
  clientHintPlatformVersion: string;
  /** Value for navigator.platform */
  navigatorPlatform: string;
  /** Key for CHROME_VALIDATION_SEEDS */
  validationSeedKey: "WINDOWS" | "MACOS" | "LINUX";
  /** Sidecar suffix used for WebGL config files */
  webglSidecarSuffix: "Windows" | "macOS" | "Linux";
  /** Default WebGL vendor string matching the OS */
  webglVendor: string;
  /** Default WebGL renderer string matching the OS */
  webglRenderer: string;
  /** Default shell name for tool execution prompt */
  shellName: string;
  /** Example directory listing command for tool protocol prompt */
  exampleListCommand: string;
  /** Example workspace path for tool protocol prompt */
  exampleWorkspacePath: string;
}

/**
 * Resolves a normalized cross-platform descriptor for:
 * - macOS Apple Silicon (`darwin-arm64`)
 * - Windows ARM64 (`win32-arm64`)
 * - Windows x64 (`win32-x64`)
 * - Linux x64 (`linux-x64`)
 * - Linux ARM64 (`linux-arm64`)
 */
export function resolvePlatformDescriptor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformDescriptor {
  const normalizedArch: SupportedCpuArch = arch === "arm64" ? "arm64" : "x64";

  if (platform === "darwin") {
    // macOS exclusively targets Apple Silicon (arm64)
    return {
      targetId: "darwin-arm64",
      nodePlatform: "darwin",
      osPlatform: "macOS",
      cpuArch: "arm64",
      clientHintArch: "arm",
      clientHintPlatformVersion: "14.5.0",
      navigatorPlatform: "MacIntel",
      validationSeedKey: "MACOS",
      webglSidecarSuffix: "macOS",
      webglVendor: "Google Inc. (Apple)",
      webglRenderer: "ANGLE (Apple, Apple M3, OpenGL 4.1)",
      shellName: "zsh",
      exampleListCommand: "ls -la",
      exampleWorkspacePath: "/Users/dev/workspace/my-project",
    };
  }

  if (platform === "linux") {
    const isArm = normalizedArch === "arm64";
    return {
      targetId: isArm ? "linux-arm64" : "linux-x64",
      nodePlatform: "linux",
      osPlatform: "Linux",
      cpuArch: normalizedArch,
      clientHintArch: isArm ? "arm" : "x86",
      clientHintPlatformVersion: "6.8.0",
      navigatorPlatform: isArm ? "Linux aarch64" : "Linux x86_64",
      validationSeedKey: "LINUX",
      webglSidecarSuffix: "Linux",
      webglVendor: "Google Inc. (Mesa)",
      webglRenderer:
        "ANGLE (Mesa, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)",
      shellName: "bash",
      exampleListCommand: "ls -la",
      exampleWorkspacePath: "/home/dev/workspace/my-project",
    };
  }

  // Default: Windows (win32-arm64 or win32-x64)
  const isArm = normalizedArch === "arm64";
  return {
    targetId: isArm ? "win32-arm64" : "win32-x64",
    nodePlatform: "win32",
    osPlatform: "Windows",
    cpuArch: normalizedArch,
    clientHintArch: isArm ? "arm" : "x86",
    clientHintPlatformVersion: "15.0.0",
    navigatorPlatform: "Win32",
    validationSeedKey: "WINDOWS",
    webglSidecarSuffix: "Windows",
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    shellName: "PowerShell",
    exampleListCommand: "Get-ChildItem -Force",
    exampleWorkspacePath: "C:\\\\workspace\\\\my-project",
  };
}

export function osPlatformToDescriptor(
  osPlatform?: SupportedOsPlatform,
  arch: SupportedCpuArch = process.arch === "arm64" ? "arm64" : "x64",
): PlatformDescriptor {
  if (!osPlatform) {
    return resolvePlatformDescriptor(process.platform, arch);
  }
  if (osPlatform === "macOS") {
    return resolvePlatformDescriptor("darwin", "arm64");
  }
  if (osPlatform === "Linux") {
    return resolvePlatformDescriptor("linux", arch);
  }
  return resolvePlatformDescriptor("win32", arch);
}
