import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "../..");
// Resolve tsx's CLI via Node module resolution (walks up to the nearest node_modules) rather than
// assuming it sits under this checkout's own node_modules: in a git worktree the deps resolve from
// the parent working tree, so projectRoot/node_modules is empty. tsx's package `exports` don't
// expose ./dist/cli.mjs, so resolve the always-exported package.json and join the bin path.
const tsxCli = path.join(path.dirname(createRequire(__filename).resolve("tsx/package.json")), "dist/cli.mjs");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8")) as T;
}

function readText(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

type SkillManifest = {
  version: string;
  description: string;
  skills: Array<{
    name: string;
    path: string;
    description: string;
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
  triggers?: {
    automatic?: Array<{
      pattern: string;
      skill: string;
    }>;
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
  const skill = manifest.skills.find((entry) => entry.name === "market-data");
  const skillText = readText("skills/market-data/SKILL.md");
  const batchScriptText = readText("skills/market-data/scripts/batch.ts");
  const referenceScriptText = readText("skills/market-data/scripts/reference.ts");
  const batchHandlersText = readText("src/api/batch-handlers.ts");
  const readmeText = readText("README.md");
  const installerText = readText("scripts/install-skills.sh");
  const multiSourcePlanText = readText("docs/multi-source-market-data-plan.md");
  const consumerDistributionPlanText = readText("docs/consumer-distribution-plan.md");

  it("keeps manifest runtime metadata aligned with package and TypeScript output", () => {
    expect(skill).toBeDefined();
    expect(manifest.version).toBe(packageJson.version);
    expect(skill?.version).toBe(packageJson.version);
    expect(skillText).toMatch(new RegExp(`^version: ${packageJson.version}$`, "m"));
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
    expect(skill?.path).toBe("market-data/SKILL.md");
    expect(existsSync(path.join(projectRoot, "skills", skill?.path ?? ""))).toBe(true);

    for (const script of skill?.scripts ?? []) {
      const sourcePath = path.join(
        projectRoot,
        "skills",
        script.path.replace(/\.js$/, ".ts"),
      );

      expect(script.path).toMatch(/^market-data\/scripts\/[\w-]+\.js$/);
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
    const scriptPath = path.join(projectRoot, "skills/market-data/scripts/get-historical.ts");
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

  it("keeps Databento reference script defaults out of broad equity routing", () => {
    expect(referenceScriptText).not.toContain('|| "XNAS.ITCH"');
    expect(referenceScriptText).not.toContain('|| "AAPL"');
    expect(referenceScriptText).toContain('|| "GLBX.MDP3"');
    expect(referenceScriptText).toContain('|| "ES.FUT"');
  });

  it("documents multi-source market data routing for Alpha Vantage MCP", () => {
    expect(skillText).toContain("Multi-Source Market Data Routing");
    expect(skillText).toContain("Alpha Vantage MCP");
    expect(skillText).toContain("TOOL_LIST");
    expect(skillText).toContain("TOOL_GET");
    expect(skillText).toContain("TOOL_CALL");
    expect(skillText).toContain("Databento remains the source of record for Standard CME historical data");
    expect(skillText).toContain("Alpha Vantage should handle broad equity");
    expect(skillText).toContain("CME futures options");
    expect(skillText).toContain("Databento");
    expect(skillText).toContain("equity options");
    expect(skillText).toContain("Alpha Vantage MCP");
    expect(manifest.description).not.toContain("all asset classes");
    expect(skill?.description).not.toContain("all asset classes");
    expect(manifest.triggers?.automatic?.map((trigger) => trigger.pattern)).not.toContain("market data");
    expect(manifest.triggers?.automatic?.map((trigger) => trigger.pattern)).not.toContain("historical bars");
    expect(manifest.skills.map((entry) => entry.name)).not.toContain("databento");
  });

  it("documents data shape differences between Databento and Alpha Vantage", () => {
    expect(skillText).toContain("Data Shape Differences");
    expect(skillText).toContain("Databento record schemas");
    expect(skillText).toContain("Alpha Vantage functions");
    expect(skillText).toContain("TOOL_GET before TOOL_CALL");
    expect(skillText).toContain("endpoint-specific JSON");
    expect(skillText).toContain("adjusted vs raw");
    expect(skillText).toContain("symbol identity models");
    expect(skillText).toContain("batch exports");
  });

  it("keeps routing examples compact and decision-oriented", () => {
    const section = skillText.match(/## Routing Examples\n\n(?<body>[\s\S]*?)\n\n## /)?.groups?.body;
    const examples = section?.split("\n").filter((line) => line.startsWith("- `")) ?? [];

    expect(section).toBeDefined();
    expect(examples).toHaveLength(6);
    expect(section).toContain("`AAPL options` -> Alpha Vantage MCP");
    expect(section).toContain("`ES options` -> Databento");
    expect(section).toContain("`GLBX.MDP3 mbp-10` -> Databento");
    expect(section).toContain("`NVDA fundamentals` -> Alpha Vantage MCP");
    expect(section).toContain("`SPY 1min bars` -> Alpha Vantage MCP");
    expect(section).toContain("`compare ES futures and SPY ETF` -> use both sources");
  });

  it("documents portable Claude Desktop consumer assumptions", () => {
    expect(skillText).toContain("Portable Claude Desktop Consumer Contract");
    expect(skillText).toContain("Do not assume this repository checkout");
    expect(skillText).toContain("Claude Desktop users must configure MCP servers separately");
    expect(skillText).toContain("Do not ask users to paste API keys into prompts");
    expect(skillText).toContain("Verify the user's Databento entitlement profile");
    expect(skillText).toContain("If a required MCP server or tool is unavailable, stop and ask for setup");
    expect(skillText).toContain("Desktop Extension");
    expect(skillText).toContain("sensitive configuration");
    expect(multiSourcePlanText).toContain("Portable Claude Desktop Consumer Assumptions");
    expect(multiSourcePlanText).toContain("not tied to this repository checkout");
  });

  it("keeps the skill self-contained for offline consumers", () => {
    const expectedDatabentoMcpTools = [
      "get_live_futures_quote",
      "get_futures_quote",
      "get_session_info",
      "get_historical_bars",
      "timeseries_get_range",
      "symbology_resolve",
      "metadata_list_datasets",
      "metadata_list_schemas",
      "metadata_list_publishers",
      "metadata_list_fields",
      "metadata_get_cost",
      "metadata_get_dataset_range",
      "batch_submit_job",
      "batch_list_jobs",
      "batch_download",
      "reference_search_securities",
      "reference_get_corporate_actions",
      "reference_get_adjustments",
    ];

    expect(skillText).toContain("No External Documentation Assumption");
    expect(skillText).toContain("Do not require the user to open external documentation");
    expect(skillText).toContain("Expected Claude Desktop MCP Tools");
    expect(skillText).toContain("Databento MCP tools");
    for (const toolName of expectedDatabentoMcpTools) {
      expect(skillText).toContain(toolName);
    }
    expect(skillText).not.toContain("resolve_symbols");
    expect(skillText).toContain("Alpha Vantage MCP tools");
    expect(skillText).toContain("Consumer Installation Packages");
    expect(skillText).not.toMatch(/https?:\/\//);
    expect(skillText).not.toMatch(/\[[^\]]+\]\([^)]+\)/);
  });

  it("documents separate consumer packages for skill and MCP server delivery", () => {
    expect(consumerDistributionPlanText).toContain("Consumer Distribution Plan");
    expect(consumerDistributionPlanText).toContain("Artifact A: Market Data Skill Package");
    expect(consumerDistributionPlanText).toContain("Artifact B: Databento MCP Desktop Extension Package");
    expect(consumerDistributionPlanText).toContain("MCPB");
    expect(consumerDistributionPlanText).toContain("sensitive");
    expect(consumerDistributionPlanText).toContain("nontechnical user");
    expect(consumerDistributionPlanText).toContain("No API keys in files");
    expect(consumerDistributionPlanText).toContain("Acceptance Gate");
  });

  it("documents reference dataset and session key-check semantics accurately", () => {
    expect(skillText).toContain("reference dataset argument is output metadata only");
    expect(skillText).toContain("env/key-format check");
    expect(skillText).not.toContain("after API-key validation");
  });

  it("updates the Claude skills master manifest from skills/manifest.json", () => {
    expect(installerText).toContain("skills/manifest.json");
    expect(installerText).toContain("skillsManifest.skills.find");
    expect(installerText).toContain("Legacy databento skill remains");
    expect(installerText).not.toContain('rm -rf "$LEGACY_TARGET_DIR"');
    expect(installerText).not.toContain('jq --arg skillPath');
    expect(installerText).not.toContain('"version": "1.0.0"');
    expect(installerText).not.toContain('{"name": "get-quote"');
  });
});
