import { describe, expect, it } from "vitest";
import {
  osPlatformToDescriptor,
  resolvePlatformDescriptor,
} from "../src/utils/platform.js";

describe("platform resolver", () => {
  it("resolves macOS Apple Silicon (darwin-arm64) exclusively to arm64", () => {
    const macArm = resolvePlatformDescriptor("darwin", "arm64");
    expect(macArm.targetId).toBe("darwin-arm64");
    expect(macArm.osPlatform).toBe("macOS");
    expect(macArm.cpuArch).toBe("arm64");
    expect(macArm.clientHintArch).toBe("arm");
    expect(macArm.validationSeedKey).toBe("MACOS");
    expect(macArm.navigatorPlatform).toBe("MacIntel");
    expect(macArm.webglVendor).toContain("Apple");
    expect(macArm.shellName).toBe("zsh");

    // Even if darwin is queried with x64, it normalizes to Apple Silicon (darwin-arm64)
    const macFallback = resolvePlatformDescriptor("darwin", "x64");
    expect(macFallback.targetId).toBe("darwin-arm64");
    expect(macFallback.cpuArch).toBe("arm64");
  });

  it("resolves Windows ARM64 (win32-arm64) and Windows x64 (win32-x64)", () => {
    const winArm = resolvePlatformDescriptor("win32", "arm64");
    expect(winArm.targetId).toBe("win32-arm64");
    expect(winArm.osPlatform).toBe("Windows");
    expect(winArm.cpuArch).toBe("arm64");
    expect(winArm.clientHintArch).toBe("arm");
    expect(winArm.validationSeedKey).toBe("WINDOWS");
    expect(winArm.shellName).toBe("PowerShell");

    const winX64 = resolvePlatformDescriptor("win32", "x64");
    expect(winX64.targetId).toBe("win32-x64");
    expect(winX64.cpuArch).toBe("x64");
    expect(winX64.clientHintArch).toBe("x86");
    expect(winX64.validationSeedKey).toBe("WINDOWS");
  });

  it("resolves Linux x64 (linux-x64) and Linux ARM64 (linux-arm64)", () => {
    const linuxX64 = resolvePlatformDescriptor("linux", "x64");
    expect(linuxX64.targetId).toBe("linux-x64");
    expect(linuxX64.osPlatform).toBe("Linux");
    expect(linuxX64.cpuArch).toBe("x64");
    expect(linuxX64.clientHintArch).toBe("x86");
    expect(linuxX64.navigatorPlatform).toBe("Linux x86_64");
    expect(linuxX64.validationSeedKey).toBe("LINUX");
    expect(linuxX64.shellName).toBe("bash");

    const linuxArm = resolvePlatformDescriptor("linux", "arm64");
    expect(linuxArm.targetId).toBe("linux-arm64");
    expect(linuxArm.osPlatform).toBe("Linux");
    expect(linuxArm.cpuArch).toBe("arm64");
    expect(linuxArm.clientHintArch).toBe("arm");
    expect(linuxArm.navigatorPlatform).toBe("Linux aarch64");
    expect(linuxArm.validationSeedKey).toBe("LINUX");
  });

  it("maps SupportedOsPlatform names to descriptors", () => {
    expect(osPlatformToDescriptor("macOS", "arm64").targetId).toBe("darwin-arm64");
    expect(osPlatformToDescriptor("Windows", "x64").targetId).toBe("win32-x64");
    expect(osPlatformToDescriptor("Linux", "arm64").targetId).toBe("linux-arm64");
  });
});
