import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

type PackageJson = {
  name: string;
  version: string;
  engines: { node: string };
  dependencies: Record<string, string>;
};

type LockPackage = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

type PackageLock = {
  packages: Record<string, LockPackage>;
};

type McpbManifest = {
  version: string;
  compatibility: {
    runtimes: { node: string };
  };
};

const projectRoot = process.cwd();
const skillArtifactRelativePath = "dist/consumer/market-data-skill";
const extensionArtifactRelativePath = "dist/consumer/databento-mcp-desktop-extension";
const consumerRoot = path.join(projectRoot, "dist/consumer");
const skillArtifactDir = path.join(projectRoot, skillArtifactRelativePath);
const extensionArtifactDir = path.join(projectRoot, extensionArtifactRelativePath);
const skillArchivePath = path.join(consumerRoot, "market-data-skill.zip");
const extensionArchivePath = path.join(consumerRoot, "databento-mcp-desktop-extension.mcpb");

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertExists(filePath: string, message: string) {
  if (!existsSync(filePath)) {
    throw new Error(`${message}: ${filePath}`);
  }
}

function copyDirectory(from: string, to: string) {
  assertExists(from, "Missing source directory");
  cpSync(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
  });
}

function packageLockPath(packageName: string) {
  return `node_modules/${packageName}`;
}

function addDependency(
  packageName: string,
  queue: string[],
  seen: Set<string>,
  lock: PackageLock,
  optional: boolean
) {
  if (seen.has(packageName)) {
    return;
  }

  const lockKey = packageLockPath(packageName);
  const installedPath = path.join(projectRoot, lockKey);
  if (!lock.packages[lockKey] || !existsSync(installedPath)) {
    if (optional) {
      return;
    }
    throw new Error(`Runtime dependency is missing from node_modules/package-lock: ${packageName}`);
  }

  queue.push(packageName);
}

function collectRuntimeDependencies(packageJson: PackageJson, lock: PackageLock) {
  const queue = Object.keys(packageJson.dependencies ?? {});
  const seen = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index];
    if (seen.has(packageName)) {
      continue;
    }
    seen.add(packageName);

    const lockEntry = lock.packages[packageLockPath(packageName)];
    if (!lockEntry) {
      throw new Error(`Runtime dependency is missing from package-lock: ${packageName}`);
    }

    for (const dependencyName of Object.keys(lockEntry.dependencies ?? {})) {
      addDependency(dependencyName, queue, seen, lock, false);
    }
    for (const dependencyName of Object.keys(lockEntry.optionalDependencies ?? {})) {
      addDependency(dependencyName, queue, seen, lock, true);
    }
    for (const dependencyName of Object.keys(lockEntry.peerDependencies ?? {})) {
      const optional = lockEntry.peerDependenciesMeta?.[dependencyName]?.optional === true;
      addDependency(dependencyName, queue, seen, lock, optional);
    }
  }

  return [...seen].sort();
}

function copyRuntimeNodeModules(targetNodeModules: string) {
  const packageJson = readJson<PackageJson>(path.join(projectRoot, "package.json"));
  const lock = readJson<PackageLock>(path.join(projectRoot, "package-lock.json"));
  const runtimeDependencies = collectRuntimeDependencies(packageJson, lock);

  mkdirSync(targetNodeModules, { recursive: true });
  for (const packageName of runtimeDependencies) {
    const sourcePackagePath = path.join(projectRoot, "node_modules", packageName);
    const targetPackagePath = path.join(targetNodeModules, packageName);

    mkdirSync(path.dirname(targetPackagePath), { recursive: true });
    copyDirectory(sourcePackagePath, targetPackagePath);
  }
}

function replaceSection(markdown: string, startHeading: string, endHeading: string, replacement: string) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Cannot build consumer skill: section boundary not found (${startHeading} -> ${endHeading})`);
  }

  return `${markdown.slice(0, start)}${replacement.trimEnd()}\n\n${markdown.slice(end)}`;
}

function buildConsumerSkillMarkdown(sourceMarkdown: string) {
  let markdown = sourceMarkdown.replace(/\r\n?/g, "\n").replace(
    /Route market-data requests across configured sources\.[\s\S]*?actual tool access\s+comes from configured MCP servers\./,
    [
      "Route market-data requests across configured sources. In Claude Desktop,",
      "this file is portable routing guidance only; actual tool access comes",
      "from configured MCP servers.",
    ].join(" ")
  );

  markdown = replaceSection(
    markdown,
    "## Scope",
    "## Portable Claude Desktop Consumer Contract",
    `## Scope

- Claude Desktop: use configured Databento and Alpha Vantage MCP servers. This
  skill file documents routing and operating rules; it does not provide tools by
  itself.
- Multi-source market data: do not treat this skill as the default for every
  market-data request. Databento remains the source of record for Standard CME
  historical data, order-book data, Databento symbology, Databento metadata, and
  Databento batch workflows. Use other configured MCP servers for their own
  domains.
- Live Databento API: Databento MCP tools call Databento over the network and
  require a valid Databento API key configured in the MCP server or Desktop
  Extension.
- Side effects: Databento batch submit can create Databento batch jobs. Treat
  batch submit as a paid operation unless the user explicitly approves the query
  scope and cost risk.`
  );

  markdown = markdown.replace(
    /- Do not assume this repository checkout, build output, `\.env` file,\n\s+`~\/\.claude\/skills\/market-data`, or local scripts exist for that user\./,
    "- Do not assume this repository checkout, build output, local environment files, or local scripts exist for that user."
  );

  markdown = replaceSection(
    markdown,
    "## Prerequisites",
    "## Multi-Source Market Data Routing",
    `## Databento MCP Operating Rules

Use Databento through connected MCP tools, not local shell scripts. If the
Databento MCP server or required tool name is missing in Claude Desktop, stop and
ask the user to install or enable the Databento MCP package.

Confirm the dataset, symbols, schema, date range, and cost risk with the user
before calling \`batch_submit_job\`, because it creates a Databento batch job and
may be paid if zero-cost preflight is disabled or overridden. Batch submit
requires an explicit \`end\` and should keep Databento \`metadata_get_cost\`
zero-cost preflight enabled by default.

Historical Standard CME guardrails:

- L0 \`ohlcv-1s\`, \`ohlcv-1m\`, \`ohlcv-1h\`, \`ohlcv-1d\`, \`definition\`,
  \`statistics\`, and \`status\`: full available history.
- L1 \`trades\`, \`mbp-1\`, \`tbbo\`, \`bbo-1s\`, and \`bbo-1m\`: rolling last
  12 months.
- L2 \`mbp-10\` and L3 \`mbo\`: rolling last 1 month.
- Direct \`timeseries_get_range\` rejects \`ALL_SYMBOLS\` and caps direct output
  with \`MCP_DIRECT_MAX_RECORDS\` (default 10000).
- Use \`batch_submit_job\` for large covered exports, including \`ALL_SYMBOLS\`.`
  );

  return markdown;
}

function buildSkillArtifact() {
  const skillTargetDir = path.join(skillArtifactDir, "market-data");
  const skillSourcePath = path.join(projectRoot, "skills/market-data/SKILL.md");

  mkdirSync(skillTargetDir, { recursive: true });
  writeFileSync(
    path.join(skillTargetDir, "SKILL.md"),
    buildConsumerSkillMarkdown(readFileSync(skillSourcePath, "utf8"))
  );
}

function createSkillArchive() {
  const skillPackageDir = path.join(skillArtifactDir, "market-data");
  createZipArchive(skillPackageDir, skillArchivePath);
}

function buildExtensionArtifact() {
  const packageJson = readJson<PackageJson>(path.join(projectRoot, "package.json"));
  const manifestTemplatePath = path.join(projectRoot, "packaging/mcpb/databento/manifest.template.json");
  const manifest = readJson<McpbManifest>(manifestTemplatePath);

  manifest.version = packageJson.version;
  manifest.compatibility.runtimes.node = packageJson.engines.node;

  mkdirSync(extensionArtifactDir, { recursive: true });
  writeJson(path.join(extensionArtifactDir, "manifest.json"), manifest);
  copyDirectory(path.join(projectRoot, "dist/mcp"), path.join(extensionArtifactDir, "server"));
  writeJson(path.join(extensionArtifactDir, "package.json"), {
    name: "databento-mcp-desktop-extension-runtime",
    version: packageJson.version,
    private: true,
    type: "commonjs",
    engines: packageJson.engines,
    dependencies: packageJson.dependencies,
  });
  copyRuntimeNodeModules(path.join(extensionArtifactDir, "node_modules"));
}

function createMcpbArchive() {
  createZipArchive(extensionArtifactDir, extensionArchivePath);
}

function createZipArchive(sourceDir: string, archivePath: string) {
  rmSync(archivePath, { force: true });

  const zip = new AdmZip();
  zip.addLocalFolder(sourceDir);
  zip.writeZip(archivePath);
}

function main() {
  assertExists(path.join(projectRoot, "dist/mcp/mcp/index.js"), "Missing built MCP entrypoint. Run npm run build:mcp first");
  assertExists(path.join(projectRoot, "skills/market-data/SKILL.md"), "Missing market-data skill");

  rmSync(consumerRoot, { recursive: true, force: true });
  mkdirSync(consumerRoot, { recursive: true });

  buildSkillArtifact();
  createSkillArchive();
  buildExtensionArtifact();
  createMcpbArchive();

  console.log(`Consumer artifacts built: ${consumerRoot}`);
  console.log(`Skill archive: ${skillArchivePath}`);
  console.log(`MCPB archive: ${extensionArchivePath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
