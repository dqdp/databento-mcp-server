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

type PackageJson = {
  version: string;
  engines: { node: string };
  scripts: Record<string, string>;
  files: string[];
};

type McpbManifest = {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  privacy_policies?: string[];
  server: {
    type: string;
    entry_point: string;
    mcp_config: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
  user_config: Record<string, {
    type: string;
    title: string;
    required?: boolean;
    sensitive?: boolean;
    default?: string | number | boolean;
  }>;
  compatibility: {
    platforms: string[];
    runtimes: { node: string };
  };
  tools: Array<{ name: string; description: string }>;
  tools_generated: boolean;
};

describe("consumer distribution packaging contract", () => {
  const packageJson = readJson<PackageJson>("package.json");
  const manifestPath = "packaging/mcpb/databento/manifest.template.json";
  const buildScriptPath = "scripts/build-consumer-artifacts.ts";
  const smokeScriptPath = "scripts/smoke-consumer-artifacts.ts";

  it("exposes repo-native consumer build and archive-smoke scripts without publishing source-only packagers", () => {
    expect(packageJson.scripts["build:consumer"]).toBe("npm run build && tsx scripts/build-consumer-artifacts.ts");
    expect(packageJson.scripts["smoke:consumer"]).toBe("npm run build:consumer && tsx scripts/smoke-consumer-artifacts.ts");
    expect(existsSync(path.join(projectRoot, buildScriptPath))).toBe(true);
    expect(existsSync(path.join(projectRoot, smokeScriptPath))).toBe(true);
    expect(packageJson.files).not.toContain("packaging/mcpb/databento/manifest.template.json");
    expect(packageJson.files).not.toContain("scripts/build-consumer-artifacts.ts");
    expect(packageJson.files).not.toContain("scripts/smoke-consumer-artifacts.ts");
  });

  it("runs the consumer artifact smoke in CI", () => {
    const workflow = readText(".github/workflows/ci.yml");

    expect(workflow).toContain("run: npm run smoke:consumer");
  });

  it("defines an MCPB manifest template with sensitive Databento configuration", () => {
    expect(existsSync(path.join(projectRoot, manifestPath))).toBe(true);

    const manifest = readJson<McpbManifest>(manifestPath);
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("databento-mcp");
    expect(manifest.display_name).toBe("Databento MCP");
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.privacy_policies).toEqual(["https://databento.com/legal/privacy-policy"]);
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("server/mcp/extension-entrypoint.js");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/server/mcp/extension-entrypoint.js"]);
    expect(manifest.server.mcp_config.env.DATABENTO_API_KEY).toBe("${user_config.databento_api_key}");
    expect(manifest.server.mcp_config.env.DATABENTO_DATASET).toBe("${user_config.databento_dataset}");
    expect(manifest.server.mcp_config.env.MCP_DIRECT_MAX_RECORDS).toBe("${user_config.direct_max_records}");
    expect(manifest.server.mcp_config.env.MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH).toBe(
      "${user_config.require_zero_cost_preflight_for_batch}"
    );
    expect(manifest.user_config.databento_api_key).toEqual(
      expect.objectContaining({
        type: "string",
        required: true,
        sensitive: true,
      })
    );
    expect(manifest.user_config.databento_dataset.default).toBe("GLBX.MDP3");
    expect(manifest.user_config.direct_max_records.default).toBe(10000);
    expect(manifest.user_config.require_zero_cost_preflight_for_batch.default).toBe(true);
    expect(manifest.compatibility.platforms.sort()).toEqual(["darwin", "linux", "win32"]);
    expect(manifest.compatibility.runtimes.node).toBe(packageJson.engines.node);
    expect(manifest.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["get_session_info", "timeseries_get_range", "batch_submit_job"])
    );
    expect(manifest.tools_generated).toBe(false);
  });

  it("keeps consumer packaging implementation focused on staged artifacts, not source checkout smoke", () => {
    const buildScript = readText(buildScriptPath);
    const smokeScript = readText(smokeScriptPath);

    expect(buildScript).toContain("dist/consumer/market-data-skill");
    expect(buildScript).toContain("market-data-skill.zip");
    expect(buildScript).toContain("dist/consumer/databento-mcp-desktop-extension");
    expect(buildScript).toContain("manifest.template.json");
    expect(buildScript).toContain("copyRuntimeNodeModules");
    expect(buildScript).toContain("buildConsumerSkillMarkdown");
    expect(buildScript).toContain("createSkillArchive");
    expect(buildScript).not.toContain("skills/manifest.json");
    expect(smokeScript).toContain("market-data-skill.zip");
    expect(smokeScript).toContain("assertConsumerSkillArchive");
    expect(smokeScript).toContain("databento-mcp-desktop-extension.mcpb");
    expect(smokeScript).toContain("extractMcpbArchive");
    expect(smokeScript).toContain("consumer skill artifact must not advertise local Claude Code skill paths");
    expect(smokeScript).toContain("consumer skill artifact must not advertise unavailable script commands");
    expect(smokeScript).toContain("dist/consumer/databento-mcp-desktop-extension");
    expect(smokeScript).toContain("assertRequiredEntrypointWorks");
    expect(smokeScript).toContain("server/mcp/index.js");
    expect(smokeScript).toContain("server/mcp/extension-entrypoint.js");
    expect(smokeScript).toContain("StdioClientTransport");
    expect(smokeScript).toContain("assertNoSourceCheckoutFallback");
    expect(smokeScript).not.toContain("cpSync(extensionArtifactDir");
  });
});
