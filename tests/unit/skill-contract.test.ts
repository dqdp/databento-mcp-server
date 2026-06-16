import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "../..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8")) as T;
}

function readText(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

type SkillManifest = {
  version: string;
  skills: Array<{
    name: string;
    path: string;
    version: string;
    scripts: Array<{
      name: string;
      path: string;
    }>;
  }>;
  metadata: {
    updated: string;
    repository: string;
    compatibility: {
      node: string;
      module_type?: string;
    };
  };
};

describe("Claude Code skill contract", () => {
  const packageJson = readJson<{
    version: string;
    engines: { node: string };
    type: string;
  }>("package.json");
  const tsconfig = readJson<{ compilerOptions: { module: string } }>("tsconfig.json");
  const manifest = readJson<SkillManifest>("skills/manifest.json");
  const batchTools = readJson<Array<{ name: string; inputSchema: { properties: Record<string, any> } }>>("src/api/batch-tools.json");
  const skill = manifest.skills.find((entry) => entry.name === "databento");
  const skillText = readText("skills/databento/SKILL.md");
  const batchScriptText = readText("skills/databento/scripts/batch.ts");
  const batchHandlersText = readText("src/api/batch-handlers.ts");
  const readmeText = readText("README.md");
  const installerText = readText("scripts/install-skills.sh");

  it("keeps manifest runtime metadata aligned with package and TypeScript output", () => {
    expect(skill).toBeDefined();
    expect(manifest.version).toBe(packageJson.version);
    expect(skill?.version).toBe(packageJson.version);
    expect(manifest.metadata.compatibility.node).toBe(packageJson.engines.node);
    expect(manifest.metadata.compatibility.module_type).toBe("CommonJS");
    expect(packageJson.type).toBe("commonjs");
    expect(tsconfig.compilerOptions.module).toBe("commonjs");
  });

  it("does not publish stale placeholder manifest metadata", () => {
    const updatedAtUtc = new Date(`${manifest.metadata.updated}T00:00:00.000Z`);

    expect(manifest.metadata.repository).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    expect(manifest.metadata.repository).not.toContain("yourusername");
    expect(manifest.metadata.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(updatedAtUtc.getTime())).toBe(false);
    expect(updatedAtUtc.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 5, 16));
    expect(manifest.metadata.updated).not.toBe("2025-10-19");
  });

  it("maps every manifest script to an installed command and source file", () => {
    expect(skill).toBeDefined();
    expect(skill?.path).toBe("databento/SKILL.md");
    expect(existsSync(path.join(projectRoot, "skills", skill?.path ?? ""))).toBe(true);

    for (const script of skill?.scripts ?? []) {
      const sourcePath = path.join(
        projectRoot,
        "skills",
        script.path.replace(/\.js$/, ".ts"),
      );

      expect(script.path).toMatch(/^databento\/scripts\/[\w-]+\.js$/);
      expect(existsSync(sourcePath)).toBe(true);
    }
  });

  it("documents every manifest script as an operational command", () => {
    expect(skill).toBeDefined();

    for (const script of skill?.scripts ?? []) {
      expect(skillText).toContain(`\`${script.name}\``);
      expect(skillText).toContain(`\`${script.path}\``);
      expect(skillText).toContain(`node ~/.claude/skills/${script.path}`);
    }
  });

  it("documents argument forms for multi-command scripts", () => {
    const requiredForms = [
      "metadata list-datasets [start_date] [end_date]",
      "metadata list-schemas [dataset]",
      "metadata list-publishers [dataset]",
      "metadata list-fields [schema] [encoding]",
      "metadata get-cost dataset start",
      "metadata get-dataset-range [dataset]",
      "batch list [states]",
      "batch submit dataset symbols schema start end",
      "batch download <job_id>",
      "reference search dataset symbols start_date [end_date] [limit]",
      "reference corporate-actions dataset symbols start_date [end_date]",
      "reference adjustments dataset symbols start_date [end_date]",
    ];

    for (const form of requiredForms) {
      expect(skillText).toContain(form);
    }
  });

  it("rejects malformed get-historical counts without truncating them", () => {
    const scriptPath = path.join(projectRoot, "skills/databento/scripts/get-historical.ts");
    const env = {
      ...process.env,
      DATABENTO_API_KEY: "db-test-key",
    };

    for (const count of ["0.5", "0abc"]) {
      const result = spawnSync(process.execPath, [tsxCli, scriptPath, "ES", "1d", count], {
        cwd: projectRoot,
        env,
        encoding: "utf8",
        timeout: 5000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain(`Error: Count must be between 1 and 10000 for 1d, got: ${count}`);
    }
  });

  it("states the Claude Code and Claude Desktop boundaries explicitly", () => {
    expect(skillText).toContain("Claude Code");
    expect(skillText).toContain("Claude Desktop");
    expect(skillText).toContain("MCP stdio");
    expect(skillText).toContain("not a Claude Desktop extension");
  });

  it("marks live API calls and batch side effects in the skill contract", () => {
    expect(skillText).toContain("Live Databento API");
    expect(skillText).toContain("Side effects");
    expect(skillText).toContain("batch");
    expect(skillText).toContain("paid");
  });

  it("requires zero-cost preflight before skill batch submit", () => {
    expect(batchScriptText).toContain("MetadataClient");
    expect(batchScriptText).toContain("metadataClient.getCost");
    expect(batchScriptText).toContain("MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH");
    expect(batchScriptText).toContain("MCP_ZERO_COST_EPSILON_USD");
    expect(batchScriptText).toContain("Databento estimated this covered Standard CME request as billable");
  });

  it("does not document stale paid GLBX trades examples under Standard CME", () => {
    expect(readmeText).not.toContain('"schema": "trades",\n  "start": "2024-10-01"');
    expect(readmeText).not.toContain('"cost_usd": 15.50');
  });

  it("keeps static batch submit schema constraints aligned with MCP", () => {
    const submitSchema = batchTools.find((tool) => tool.name === "batch_submit_job")?.inputSchema;

    expect(submitSchema?.properties.symbols).toEqual(
      expect.objectContaining({
        minItems: 1,
        maxItems: 2000,
      })
    );
    expect(submitSchema?.properties.limit).toEqual(
      expect.objectContaining({
        type: "integer",
        minimum: 1,
      })
    );
    expect(submitSchema?.properties.split_size).toEqual(
      expect.objectContaining({
        type: "integer",
        minimum: 1,
      })
    );
    expect(batchHandlersText).toContain("split_size: {");
    expect(batchHandlersText).toContain('type: "integer"');
    expect(batchHandlersText).toContain("minimum: 1");
  });

  it("keeps historical skill examples within Standard CME scope", () => {
    expect(skillText).not.toContain("Get trades for SPY");
    expect(skillText).not.toContain("Fetch MBP-1 data for TSLA");
    expect(skillText).not.toContain("trade data for SPY");
  });

  it("documents reference dataset and session key-check semantics accurately", () => {
    expect(skillText).toContain("reference dataset argument is output metadata only");
    expect(skillText).toContain("env/key-format check");
    expect(skillText).not.toContain("after API-key validation");
  });

  it("updates the Claude skills master manifest from skills/manifest.json", () => {
    expect(installerText).toContain("skills/manifest.json");
    expect(installerText).toContain("skillsManifest.skills.find");
    expect(installerText).not.toContain('jq --arg skillPath');
    expect(installerText).not.toContain('"version": "1.0.0"');
    expect(installerText).not.toContain('{"name": "get-quote"');
  });
});
