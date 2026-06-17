import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8")) as T;
}

function readText(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

describe("installed skill smoke contract", () => {
  const packageJson = readJson<{
    scripts: Record<string, string>;
    files: string[];
  }>("package.json");
  const workflow = readText(".github/workflows/ci.yml");

  it("exposes the installed skill smoke as a repo-native npm script", () => {
    expect(packageJson.scripts["smoke:skills"]).toBe("tsx scripts/smoke-installed-skills.ts");
    expect(existsSync(path.join(projectRoot, "scripts/smoke-installed-skills.ts"))).toBe(true);
  });

  it("runs the installed skill smoke from GitHub CI instead of inline shell checks", () => {
    expect(workflow).toContain("run: npm run smoke:skills");
    expect(workflow).not.toContain('HOME="$RUNNER_TEMP/databento-skills-home" npm run install:skills');
    expect(workflow).not.toContain("grep -F");
  });

  it("keeps publish files broad enough for installer and built skill runtime", () => {
    expect(packageJson.files).toContain("dist/mcp/");
    expect(packageJson.files).toContain("dist/skills/");
    expect(packageJson.files).toContain("scripts/install-skills.sh");
    expect(packageJson.files).toContain("skills/manifest.json");
    expect(packageJson.files).toContain("skills/market-data/SKILL.md");
  });
});
