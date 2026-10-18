import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareIsolatedAntigravityUserDataDir,
  resolveAntigravityPaths,
  resolveStockAntigravityUserDataDir,
  rewriteLanguageServerArgs,
} from "../src/hook/antigravity-hook.js";

describe("antigravity-hook", () => {
  it("rewrites --cloud_code_endpoint flag values in language_server args", () => {
    const original = [
      "--standalone",
      "--cloud_code_endpoint",
      "https://daily-cloudcode-pa.googleapis.com",
      "--enable_sidecars",
    ];
    const updated = rewriteLanguageServerArgs(
      original,
      "http://127.0.0.1:8787",
    );

    expect(updated).toEqual([
      "--standalone",
      "--cloud_code_endpoint",
      "http://127.0.0.1:8787",
      "--enable_sidecars",
    ]);
  });

  it("rewrites --cloud_code_endpoint=<url> equals-syntax flag", () => {
    const original = [
      "--standalone",
      "--cloud_code_endpoint=https://daily-cloudcode-pa.googleapis.com",
    ];
    const updated = rewriteLanguageServerArgs(
      original,
      "http://127.0.0.1:8787",
    );

    expect(updated).toEqual([
      "--standalone",
      "--cloud_code_endpoint=http://127.0.0.1:8787",
    ]);
  });

  it("resolves Antigravity installation paths for Windows, macOS, and Linux", () => {
    const winPaths = resolveAntigravityPaths(undefined, "win32");
    expect(winPaths.antigravityExe).toContain("Antigravity.exe");
    expect(winPaths.languageServerExe).toContain("language_server.exe");

    const macPaths = resolveAntigravityPaths(undefined, "darwin");
    expect(macPaths.antigravityExe).toContain("Antigravity.app");
    expect(macPaths.antigravityExe).toContain(path.join("Contents", "MacOS", "Antigravity"));
    expect(macPaths.languageServerExe).toContain("language_server");

    const linuxPaths = resolveAntigravityPaths(undefined, "linux");
    expect(linuxPaths.antigravityExe.toLowerCase()).toContain("antigravity");
    expect(linuxPaths.languageServerExe).toContain("language_server");
  });

  it("resolves stock Antigravity user-data directories per platform", () => {
    expect(resolveStockAntigravityUserDataDir("win32")).toContain("Antigravity");
    expect(resolveStockAntigravityUserDataDir("darwin")).toContain(
      path.join("Library", "Application Support", "Antigravity"),
    );
    expect(resolveStockAntigravityUserDataDir("linux")).toContain("Antigravity");
  });

  it("creates an isolated user-data-dir for multi-instance Antigravity launches", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "agy-isolated-test-"));
    try {
      const prepared = prepareIsolatedAntigravityUserDataDir(tempDir);
      expect(prepared).toBe(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
