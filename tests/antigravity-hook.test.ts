import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareIsolatedAntigravityUserDataDir,
  resolveAntigravityPaths,
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

  it("resolves Antigravity installation paths", () => {
    const paths = resolveAntigravityPaths();
    expect(paths.antigravityExe).toContain("Antigravity.exe");
    expect(paths.languageServerExe).toContain("language_server.exe");
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
