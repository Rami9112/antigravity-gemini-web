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
import { prepareChromiumStealthEnvironment } from "../src/stealth/chromium-launcher.js";

describe("chrome-stealth", () => {
  it("computes Google Chrome x-browser-validation SHA-1 headers using Windows seed", () => {
    const ua = buildCleanChromeUserAgent("153.0.8010.27", "Windows");
    expect(ua).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );
    expect(ua).not.toContain("Electron");
    expect(ua).not.toContain("antigravity");

    const headers = computeChromeValidationHeaders(ua);
    expect(headers.osSeedKey).toBe("WINDOWS");
    expect(headers["x-browser-channel"]).toBe("stable");
    expect(headers["x-browser-year"]).toBe("2025");
    expect(headers["x-browser-validation"]).toMatch(/^[A-Za-z0-9+/=]{28}$/);
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

  it("builds Sec-CH-UA headers advertising Google Chrome", () => {
    const ch = buildChromeClientHintsHeaders("153.0.8010.27", "Windows");
    expect(ch["sec-ch-ua"]).toContain('"Google Chrome";v="153"');
    expect(ch["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(ch["sec-ch-ua-mobile"]).toBe("?0");
  });

  it("compiles Chromium stealth profile files and standalone MV3 stealth extension", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "agy-stealth-test-"));
    try {
      const extDir = await ensureChromeStealthExtension(tmp);
      expect(existsSync(path.join(extDir, "manifest.json"))).toBe(true);
      expect(existsSync(path.join(extDir, "background.mjs"))).toBe(true);

      const profileDir = path.join(tmp, "profile_agy");
      const compiled = await compileChromiumStealthProfile({
        profileId: "agy01",
        profileDir,
        extensionPaths: [extDir],
      });

      expect(compiled.extendedParametersFlag).toMatch(/^--extended-parameters=/);
      expect(existsSync(path.join(profileDir, md5Hex("agy01_static")))).toBe(true);
      expect(existsSync(path.join(profileDir, md5Hex("agy01_webrtc")))).toBe(true);
      expect(existsSync(path.join(profileDir, `${md5Hex("agy01_webgl")}_Windows`))).toBe(true);

      const script = buildBrowserStealthInitScript({ userAgent: compiled.userAgent });
      expect(script).toContain("Google Chrome");
      expect(script).toContain("NVIDIA GeForce RTX 3060");

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
