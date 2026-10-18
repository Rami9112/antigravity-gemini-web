import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRepo } from "../scripts/check-repo.mjs";

function createValidRepoFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agy-check-repo-"));
  mkdirSync(path.join(dir, "host"), { recursive: true });
  mkdirSync(path.join(dir, "src"), { recursive: true });

  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "antigravity-gemini-web",
        version: "0.1.0",
        bin: { "antigravity-gemini-web": "./dist/cli.js" },
        engines: { node: ">=22.0.0" },
        os: ["darwin", "win32", "linux"],
        cpu: ["arm64", "x64"],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(dir, "tsconfig.json"), "{}", "utf8");
  writeFileSync(path.join(dir, "tsconfig.build.json"), "{}", "utf8");
  writeFileSync(path.join(dir, "README.md"), "# antigravity-gemini-web\n", "utf8");
  writeFileSync(path.join(dir, "LICENSE"), "MIT\n", "utf8");
  writeFileSync(
    path.join(dir, "host", "electron-host.cjs"),
    "const x = 1;\nmodule.exports = { x };\n",
    "utf8",
  );
  writeFileSync(
    path.join(dir, "host", "chrome-preload.cjs"),
    "const y = 2;\nmodule.exports = { y };\n",
    "utf8",
  );
  writeFileSync(path.join(dir, "src", "cli.ts"), "export {};\n", "utf8");
  writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n", "utf8");

  return dir;
}

describe("checkRepo (offline repository integrity & security verifier)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("1. passes on the actual repository root", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const result = checkRepo(repoRoot);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checkedFileCount).toBeGreaterThan(10);
  });

  it("2. passes on a minimal valid repository fixture", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);

    const result = checkRepo(dir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("3. fails when a required entrypoint or manifest file is missing", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    rmSync(path.join(dir, "host", "electron-host.cjs"));

    const result = checkRepo(dir);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Missing required file: host/electron-host.cjs");
  });

  it("4. fails when package.json is missing required cross-platform os or cpu entries", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "antigravity-gemini-web",
        bin: { "antigravity-gemini-web": "./dist/cli.js" },
        engines: { node: ">=22.0.0" },
        os: ["win32"],
        cpu: ["arm64"],
      }),
      "utf8",
    );

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('package.json os array is missing "darwin"');
    expect(result.errors).toContain('package.json os array is missing "linux"');
    expect(result.errors).toContain('package.json cpu array is missing "x64"');
  });

  it("5. fails when package.json is missing bin or engines.node", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "antigravity-gemini-web",
        os: ["darwin", "win32", "linux"],
        cpu: ["arm64", "x64"],
      }),
      "utf8",
    );

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'package.json must define bin["antigravity-gemini-web"]',
    );
    expect(result.errors).toContain(
      "package.json must define a non-empty engines.node range",
    );
  });

  it("6. detects unsplit Google API Key literals that trigger GitHub Secret Scanning", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    const fakeKey = ["AI", "za", "Sy", "A2KlwBX3mkFo30om9LUFYQhpqLoa_BNhE"].join("");
    writeFileSync(
      path.join(dir, "src", "leak.ts"),
      `export const KEY = "${fakeKey}";\n`,
      "utf8",
    );

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Google API Key literal"))).toBe(true);
  });

  it("7. detects leaked GitHub Personal Access Tokens", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    const fakePat = `${["gh", "p_"].join("")}${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
    writeFileSync(
      path.join(dir, "src", "token.ts"),
      `export const TOKEN = "${fakePat}";\n`,
      "utf8",
    );

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("GitHub Personal Access Token")),
    ).toBe(true);
  });

  it("8. detects Private Key PEM blocks in tracked files", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    const pemHeader = ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join("");
    writeFileSync(path.join(dir, "src", "key.ts"), `// ${pemHeader}\n`, "utf8");

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Private Key PEM block"))).toBe(true);
  });

  it("9. detects forbidden legacy repository or account traces", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    const legacyName = ["codex", "-chatgpt-", "web"].join("");
    writeFileSync(
      path.join(dir, "src", "legacy.ts"),
      `// ported from ${legacyName}\n`,
      "utf8",
    );

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Forbidden legacy trace"))).toBe(
      true,
    );
  });

  it("10. detects hardcoded personal user home directory paths while allowing generic dev/user examples", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    const leakedWinPath = ["C:\\\\Users", "alice_secret", "project"].join("\\\\");
    writeFileSync(
      path.join(dir, "src", "paths.ts"),
      `export const SAFE = "/Users/dev/workspace";\nexport const LEAK = "${leakedWinPath}";\n`,
      "utf8",
    );

    const result = checkRepo(dir, { runSyntaxCheck: false });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("Hardcoded personal user home directory path"),
      ),
    ).toBe(true);
  });

  it("11. fails when a CommonJS host script has invalid JavaScript syntax or a symlink escapes root", () => {
    const dir = createValidRepoFixture();
    tempDirs.push(dir);
    writeFileSync(
      path.join(dir, "host", "electron-host.cjs"),
      "const broken = (\n",
      "utf8",
    );

    // Also test symlink escape if the OS allows creating symlinks without elevation
    const outsideFile = path.join(os.tmpdir(), `agy-outside-${Date.now()}.txt`);
    writeFileSync(outsideFile, "outside", "utf8");
    let symlinkCreated = false;
    try {
      symlinkSync(outsideFile, path.join(dir, "src", "escaped-link.ts"));
      symlinkCreated = true;
    } catch {
      // Unprivileged Windows without Developer Mode may disallow symlink creation
    }

    try {
      const result = checkRepo(dir, { runSyntaxCheck: true });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) =>
          e.includes("JavaScript syntax check failed for host/electron-host.cjs"),
        ),
      ).toBe(true);
      if (symlinkCreated) {
        expect(
          result.errors.some((e) => e.includes("Symlink escape detected")),
        ).toBe(true);
      }
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });
});
