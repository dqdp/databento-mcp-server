import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type SkillManifest = {
  skills: Array<{
    name: string;
    path: string;
    version: string;
    scripts: Array<{
      name: string;
      path: string;
    }>;
  }>;
};

const projectRoot = process.cwd();
const apiKeyError = "DATABENTO_API_KEY environment variable is required";

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function envWithoutDatabentoKey(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
  };
  delete env.DATABENTO_API_KEY;
  return env;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `exit status: ${result.status}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
      ].filter(Boolean).join("\n")
    );
  }

  return result;
}

function assertNoKeyMode(scriptPath: string, scriptName: string) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    env: envWithoutDatabentoKey(),
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert(
    result.status === 1,
    `${scriptName} should exit 1 without DATABENTO_API_KEY, got ${result.status}\n${output}`
  );
  assert(
    output.includes(apiKeyError),
    `${scriptName} should fail with the standard API-key message\n${output}`
  );
}

function main() {
  const sourceManifest = readJson<SkillManifest>(path.join(projectRoot, "skills/manifest.json"));
  const sourceSkill = sourceManifest.skills.find((skill) => skill.name === "databento");
  assert(sourceSkill, "skills/manifest.json is missing the databento skill");

  const homeDir = mkdtempSync(path.join(os.tmpdir(), "databento-skills-home-"));
  const claudeSkillsDir = path.join(homeDir, ".claude", "skills");
  const targetDir = path.join(claudeSkillsDir, "databento");
  const masterManifestPath = path.join(claudeSkillsDir, "manifest.json");

  try {
    mkdirSync(claudeSkillsDir, { recursive: true });
    writeFileSync(
      masterManifestPath,
      `${JSON.stringify({ skills: [{ name: "existing", path: "existing/SKILL.md" }] }, null, 2)}\n`
    );

    run("npm", ["run", "install:skills"], envWithoutDatabentoKey({ HOME: homeDir }));

    assert(existsSync(path.join(targetDir, "SKILL.md")), "installed SKILL.md is missing");
    assert(existsSync(path.join(targetDir, "manifest.json")), "installed manifest.json is missing");
    assert(existsSync(path.join(targetDir, "src")), "installed shared src runtime is missing");
    assert(
      existsSync(path.join(targetDir, "src/http/databento-http.js")),
      "installed shared HTTP runtime is missing"
    );

    const installedManifest = readJson<SkillManifest>(path.join(targetDir, "manifest.json"));
    const installedSkill = installedManifest.skills.find((skill) => skill.name === "databento");
    assert(installedSkill, "installed manifest is missing the databento skill");
    assert(
      JSON.stringify(installedSkill) === JSON.stringify(sourceSkill),
      "installed manifest skill entry differs from source manifest"
    );

    const masterManifest = readJson<SkillManifest>(masterManifestPath);
    const masterSkillNames = masterManifest.skills.map((skill) => skill.name).sort();
    assert(
      JSON.stringify(masterSkillNames) === JSON.stringify(["databento", "existing"]),
      `master manifest should contain existing and databento skills, got ${JSON.stringify(masterSkillNames)}`
    );
    assert(
      JSON.stringify(masterManifest.skills.find((skill) => skill.name === "databento")) ===
        JSON.stringify(sourceSkill),
      "master manifest databento entry should come from skills/manifest.json"
    );

    for (const script of sourceSkill.scripts) {
      const installedScriptPath = path.join(claudeSkillsDir, script.path);

      assert(existsSync(installedScriptPath), `installed script is missing: ${script.path}`);
      assert(
        (statSync(installedScriptPath).mode & 0o111) !== 0,
        `installed script is not executable: ${script.path}`
      );
      assertNoKeyMode(installedScriptPath, script.name);
    }

    console.log(`Installed skill smoke passed: ${targetDir}`);
  } finally {
    if (!process.env.KEEP_SKILL_SMOKE_HOME) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
