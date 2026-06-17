import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type TextContent = {
  type: "text";
  text: string;
};

type McpbManifest = {
  manifest_version: string;
  server: {
    entry_point: string;
    mcp_config: {
      args: string[];
      env: Record<string, string>;
    };
  };
  user_config: Record<string, { sensitive?: boolean; required?: boolean }>;
};

const projectRoot = process.cwd();
const extensionArtifactRelativePath = "dist/consumer/databento-mcp-desktop-extension";
const consumerRoot = path.join(projectRoot, "dist/consumer");
const skillArtifactDir = path.join(consumerRoot, "market-data-skill");
const extensionArtifactDir = path.join(projectRoot, extensionArtifactRelativePath);
const skillArchivePath = path.join(consumerRoot, "market-data-skill.zip");
const extensionArchivePath = path.join(consumerRoot, "databento-mcp-desktop-extension.mcpb");
const apiKey = "db-test-key";

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isTextContent(content: unknown): content is TextContent {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    (content as { type: unknown }).type === "text" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertConsumerSkillMarkdown(skillPath: string, manifestPath: string) {
  assert(existsSync(skillPath), "consumer skill artifact is missing SKILL.md");
  assert(
    !existsSync(manifestPath),
    "consumer skill artifact must not include Claude Code manifest.json without bundled scripts"
  );

  const skillText = readFileSync(skillPath, "utf8");
  assert(!/https?:\/\//.test(skillText), "consumer skill must not contain external documentation URLs");
  assert(!/\[[^\]]+\]\([^)]+\)/.test(skillText), "consumer skill must not contain markdown links");
  assert(
    !skillText.includes("~/.claude/skills"),
    "consumer skill artifact must not advertise local Claude Code skill paths"
  );
  assert(
    !skillText.includes("market-data/scripts") && !/node\s+.*scripts\//.test(skillText),
    "consumer skill artifact must not advertise unavailable script commands"
  );
}

function assertNoExternalLinksInSkill() {
  assertConsumerSkillMarkdown(
    path.join(skillArtifactDir, "market-data/SKILL.md"),
    path.join(skillArtifactDir, "market-data/manifest.json")
  );
}

function assertArchiveLooksLikeZip(archivePath: string, label: string) {
  assert(existsSync(archivePath), `${label} archive is missing`);
  assert(statSync(archivePath).size > 0, `${label} archive is empty`);

  const header = readFileSync(archivePath).subarray(0, 2).toString("utf8");
  assert(header === "PK", `${label} archive should be a zip file`);
}

function extractZipArchive(archivePath: string, targetDir: string, label: string) {
  const result = spawnSync("unzip", ["-q", archivePath, "-d", targetDir], {
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`Failed to run unzip for ${label} archive: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `Failed to extract ${label} archive`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
      ].filter(Boolean).join("\n")
    );
  }
}

function extractMcpbArchive(targetDir: string) {
  extractZipArchive(extensionArchivePath, targetDir, "MCPB");
}

function assertConsumerSkillArchive(targetDir: string) {
  extractZipArchive(skillArchivePath, targetDir, "consumer skill");
  assertConsumerSkillMarkdown(
    path.join(targetDir, "SKILL.md"),
    path.join(targetDir, "manifest.json")
  );
}

function assertManifest(extensionDir: string) {
  const manifest = readJson<McpbManifest>(path.join(extensionDir, "manifest.json"));

  assert(manifest.manifest_version === "0.3", "MCPB manifest version should be 0.3");
  assert(
    manifest.server.entry_point === "server/mcp/extension-entrypoint.js",
    "MCPB manifest should point to the UtilityProcess-safe staged server entrypoint"
  );
  assert(
    JSON.stringify(manifest.server.mcp_config.args) === JSON.stringify(["${__dirname}/server/mcp/extension-entrypoint.js"]),
    "MCPB manifest args should use ${__dirname}"
  );
  assert(
    manifest.server.mcp_config.env.DATABENTO_API_KEY === "${user_config.databento_api_key}",
    "MCPB manifest should read DATABENTO_API_KEY from user_config"
  );
  assert(
    manifest.user_config.databento_api_key?.sensitive === true &&
      manifest.user_config.databento_api_key?.required === true,
    "Databento API key should be required sensitive user_config"
  );
}

function assertNoSourceCheckoutFallback(extensionDir: string) {
  assert(existsSync(path.join(extensionDir, "server/mcp/index.js")), "staged MCP entrypoint is missing");
  assert(
    existsSync(path.join(extensionDir, "server/mcp/extension-entrypoint.js")),
    "staged MCPB extension entrypoint is missing"
  );
  assert(existsSync(path.join(extensionDir, "server/src/databento-client.js")), "staged compiled src runtime is missing");
  assert(
    existsSync(path.join(extensionDir, "node_modules/@modelcontextprotocol/sdk/package.json")),
    "staged runtime node_modules are missing @modelcontextprotocol/sdk"
  );
}

async function assertNoStartupStdout(entrypoint: string, cwd: string) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: {
      DATABENTO_API_KEY: apiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  await wait(500);
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(1000),
  ]);

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  if (stdout.length > 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new Error(
      `Staged MCP server wrote startup output to stdout: ${JSON.stringify(stdout)}${stderr ? `\nstderr: ${stderr}` : ""}`
    );
  }
}

async function assertStagedMcpServerWorks(extensionDir: string) {
  const entrypoint = path.join(extensionDir, "server/mcp/extension-entrypoint.js");

  await assertNoStartupStdout(entrypoint, extensionDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: extensionDir,
    env: {
      DATABENTO_API_KEY: apiKey,
    },
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const client = new Client({
    name: "databento-consumer-artifact-smoke",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    for (const requiredTool of ["get_session_info", "timeseries_get_range", "batch_submit_job"]) {
      assert(toolNames.includes(requiredTool), `staged MCP tools/list is missing ${requiredTool}`);
    }

    const result = await client.callTool({ name: "get_session_info" });
    const content = Array.isArray(result.content) ? result.content : [];
    assert(!result.isError, "staged get_session_info returned an MCP error");
    const firstContent = content[0];
    assert(isTextContent(firstContent), "staged get_session_info did not return text content");

    const payload = JSON.parse(firstContent.text);
    for (const key of ["currentSession", "sessionStart", "sessionEnd", "timestamp", "utcHour"]) {
      assert(key in payload, `staged get_session_info response is missing ${key}`);
    }
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) {
      console.error(stderr);
    }
    throw error;
  } finally {
    await client.close();
    await transport.close();
  }
}

async function assertRequiredEntrypointWorks(extensionDir: string) {
  const entrypoint = path.join(extensionDir, "server/mcp/extension-entrypoint.js");
  const requireScript = `require(${JSON.stringify(entrypoint)})`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", requireScript],
    cwd: extensionDir,
    env: {
      DATABENTO_API_KEY: apiKey,
    },
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const client = new Client({
    name: "databento-consumer-artifact-require-smoke",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(
      tools.tools.some((tool) => tool.name === "get_session_info"),
      "required MCPB extension entrypoint did not expose get_session_info"
    );
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) {
      console.error(stderr);
    }
    throw error;
  } finally {
    await client.close();
    await transport.close();
  }
}

async function main() {
  assert(existsSync(extensionArtifactDir), "consumer Databento MCP extension artifact is missing; run npm run build:consumer");
  assertNoExternalLinksInSkill();
  assertArchiveLooksLikeZip(skillArchivePath, "consumer skill");
  assertArchiveLooksLikeZip(extensionArchivePath, "MCPB");

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "databento-consumer-artifact-"));
  const extractedSkillDir = path.join(tempDir, "market-data-skill");
  const extractedExtensionDir = path.join(tempDir, "databento-mcp-desktop-extension");

  try {
    assertConsumerSkillArchive(extractedSkillDir);
    extractMcpbArchive(extractedExtensionDir);

    assertManifest(extractedExtensionDir);
    assertNoSourceCheckoutFallback(extractedExtensionDir);
    await assertStagedMcpServerWorks(extractedExtensionDir);
    await assertRequiredEntrypointWorks(extractedExtensionDir);

    console.log(`Consumer artifact smoke passed: ${extractedExtensionDir}`);
  } finally {
    if (!process.env.KEEP_CONSUMER_SMOKE_ARTIFACT) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
