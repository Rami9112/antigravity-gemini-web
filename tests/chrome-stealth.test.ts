import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBrowserStealthInitScript,
  buildChromeClientHintsHeaders,
  buildCleanChromeUserAgent,
  compileChromiumStealthProfile,
  computeChromeValidationHeaders,
  decodeCustomBase64,
  encodeCustomBase64,
  ensureChromeStealthExtension,
  md5Hex,
} from "../src/stealth/chrome-stealth.js";
import {
  getDefaultChromiumPaths,
  prepareChromiumStealthEnvironment,
} from "../src/stealth/chromium-launcher.js";

describe("chrome-stealth", () => {
  it("computes Google Chrome x-browser-validation SHA-1 headers across Windows, macOS, and Linux", () => {
    const winUa = buildCleanChromeUserAgent("153.0.8010.27", "Windows", "arm64");
    expect(winUa).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
    expect(winUa).not.toContain("Electron");
    expect(computeChromeValidationHeaders(winUa).osSeedKey).toBe("WINDOWS");

    const macUa = buildCleanChromeUserAgent("153.0.8010.27", "macOS", "arm64");
    expect(macUa).toContain("Macintosh; Intel Mac OS X 10_15_7");
    expect(computeChromeValidationHeaders(macUa).osSeedKey).toBe("MACOS");

    const linuxArmUa = buildCleanChromeUserAgent("153.0.8010.27", "Linux", "arm64");
    expect(linuxArmUa).toContain("X11; Linux aarch64");
    expect(computeChromeValidationHeaders(linuxArmUa).osSeedKey).toBe("LINUX");

    const linuxX64Ua = buildCleanChromeUserAgent("153.0.8010.27", "Linux", "x64");
    expect(linuxX64Ua).toContain("X11; Linux x86_64");
    expect(computeChromeValidationHeaders(linuxX64Ua).osSeedKey).toBe("LINUX");
  });

  it("encodes and decodes custom-alphabet Base64 for Chromium stealth profiles", () => {
    const payload = JSON.stringify({
      Platform: "Win32",
      AutomationControlled: false,
      HardwareConcurrency: 8,
    });
    const encoded = encodeCustomBase64(payload);
    expect(encoded).not.toBe(Buffer.from(payload, "utf8").toString("base64"));
    expect(decodeCustomBase64(encoded)).toBe(payload);
  });

  it("builds Sec-CH-UA headers matching each OS and CPU architecture (arm64 vs x64)", () => {
    const winArm = buildChromeClientHintsHeaders("153.0.8010.27", "Windows", "arm64");
    expect(winArm["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(winArm["sec-ch-ua-arch"]).toBe('"arm"');

    const winX64 = buildChromeClientHintsHeaders("153.0.8010.27", "Windows", "x64");
    expect(winX64["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(winX64["sec-ch-ua-arch"]).toBe('"x86"');

    const macArm = buildChromeClientHintsHeaders("153.0.8010.27", "macOS", "arm64");
    expect(macArm["sec-ch-ua-platform"]).toBe('"macOS"');
    expect(macArm["sec-ch-ua-arch"]).toBe('"arm"');

    const linuxX64 = buildChromeClientHintsHeaders("153.0.8010.27", "Linux", "x64");
    expect(linuxX64["sec-ch-ua-platform"]).toBe('"Linux"');
    expect(linuxX64["sec-ch-ua-arch"]).toBe('"x86"');

    const linuxArm = buildChromeClientHintsHeaders("153.0.8010.27", "Linux", "arm64");
    expect(linuxArm["sec-ch-ua-platform"]).toBe('"Linux"');
    expect(linuxArm["sec-ch-ua-arch"]).toBe('"arm"');
  });

  it("returns OS-appropriate default Chrome binary paths for darwin, linux, and win32", () => {
    expect(getDefaultChromiumPaths("darwin", "/Users/dev", {})).toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(getDefaultChromiumPaths("linux", "/home/dev", {})).toContain(
      "/usr/bin/google-chrome",
    );
    expect(
      getDefaultChromiumPaths("win32", "C:\\Users\\dev", {
        PROGRAMFILES: "C:\\Program Files",
      }),
    ).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("compiles Chromium stealth profile files and standalone MV3 stealth extension", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agy-stealth-test-"));
    try {
      const extDir = await ensureChromeStealthExtension(tmp, {
        osPlatform: "Windows",
        cpuArch: "x64",
      });
      expect(existsSync(path.join(extDir, "manifest.json"))).toBe(true);
      expect(existsSync(path.join(extDir, "background.mjs"))).toBe(true);

      const profileDir = path.join(tmp, "profile_agy");
      const compiled = await compileChromiumStealthProfile({
        profileId: "agy01",
        profileDir,
        extensionPaths: [extDir],
        osPlatform: "Windows",
        cpuArch: "x64",
      });

      expect(compiled.extendedParametersFlag).toMatch(/^--extended-parameters=/);
      expect(existsSync(path.join(profileDir, md5Hex("agy01_static")))).toBe(true);
      expect(existsSync(path.join(profileDir, md5Hex("agy01_webrtc")))).toBe(true);
      expect(existsSync(path.join(profileDir, `${md5Hex("agy01_webgl")}_Windows`))).toBe(true);

      const macScript = buildBrowserStealthInitScript({
        osPlatform: "macOS",
        cpuArch: "arm64",
      });
      expect(macScript).toContain("MacIntel");
      expect(macScript).toContain("Apple M3");

      const prepared = await prepareChromiumStealthEnvironment({
        cdpPort: 9444,
        baseStateDir: tmp,
        profileId: "agy02",
        executablePath: process.execPath,
      });
      expect(prepared.args).toContain("--remote-debugging-port=9444");
      expect(prepared.userAgent).not.toContain("Electron");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
