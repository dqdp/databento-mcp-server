import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const { payloadFiles } = require('../packaging/openai/install-openai.cjs');
const root = process.cwd();
const consumer = path.join(root, 'dist/consumer');
const output = path.join(root, 'dist/windows');
const plugin = path.join(output, 'databento-mcp');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = '24.18.1';
const runtimeName = `node-v${nodeVersion}-win-x64`;
const runtimeSha256 = 'ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

async function main() {
  const cache = path.join(os.tmpdir(), 'databento-node-runtime-cache');
  const cachedZip = path.join(cache, `${runtimeName}.zip`);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(cachedZip) || sha256(readFileSync(cachedZip)) !== runtimeSha256) {
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${runtimeName}.zip`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== runtimeSha256) throw new Error('Official Node.js Windows ZIP SHA-256 mismatch');
    writeFileSync(cachedZip, bytes);
  }
  rmSync(output, { recursive: true, force: true }); mkdirSync(plugin, { recursive: true });
  const extension = path.join(consumer, 'databento-mcp-desktop-extension');
  for (const name of ['server', 'node_modules', 'package.json']) cpSync(path.join(extension, name), path.join(plugin, name), { recursive: true });
  for (const name of ['start.cjs', 'install-openai.cjs', 'Install-ChatGPT.ps1', 'Install-ChatGPT.cmd']) {
    cpSync(path.join(root, 'packaging/openai', name), path.join(plugin, name));
  }
  mkdirSync(path.join(plugin, 'runtime'));
  const runtime = new AdmZip(cachedZip);
  for (const name of ['node.exe', 'LICENSE']) {
    const entry = runtime.getEntry(`${runtimeName}/${name}`);
    if (!entry) throw new Error(`Node.js ZIP missing ${name}`);
    writeFileSync(path.join(plugin, 'runtime', name), entry.getData());
  }
  const identity = { name: 'databento-mcp', version: pkg.version, description: 'Local Databento market data tools for Windows', author: { name: 'dqdp' }, license: 'MIT' };
  json(path.join(plugin, 'plugin.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', ...identity,
    extensions: { 'com.openai': { requires_local_executor: true, interface: { displayName: 'Databento MCP', shortDescription: 'Databento market data', capabilities: [] } } },
  });
  const server = { command: '${PLUGIN_ROOT}/runtime/node.exe', args: ['${PLUGIN_ROOT}/start.cjs'], cwd: '${PLUGIN_ROOT}' };
  json(path.join(plugin, 'mcp.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { databento: { type: 'stdio', ...server } } });
  mkdirSync(path.join(plugin, '.codex-plugin'));
  json(path.join(plugin, '.codex-plugin/plugin.json'), { ...identity, skills: './skills/', mcpServers: './.mcp.json', requires_local_executor: true });
  json(path.join(plugin, '.mcp.json'), { mcpServers: { databento: server } });
  mkdirSync(path.join(plugin, 'skills/market-data'), { recursive: true });
  const skill = readFileSync(path.join(consumer, 'market-data-skill/market-data/SKILL.md'), 'utf8').replaceAll('Claude Desktop', 'ChatGPT Work');
  writeFileSync(path.join(plugin, 'skills/market-data/SKILL.md'), skill);
  cpSync(path.join(root, 'docs/windows-client-install.md'), path.join(plugin, 'README.md'));
  const build = {
    version: pkg.version, source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    working_tree_dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    node_version: nodeVersion, node_archive_sha256: runtimeSha256, platform: 'win32-x64',
    files: payloadFiles(plugin),
  };
  json(path.join(plugin, 'BUILD.json'), build);
  const archive = new AdmZip(); archive.addLocalFolder(plugin);
  archive.writeZip(path.join(output, `databento-chatgpt-windows-${pkg.version}.zip`));
  cpSync(path.join(consumer, 'databento-mcp-desktop-extension.mcpb'), path.join(output, `databento-claude-${pkg.version}.mcpb`));
  cpSync(path.join(consumer, 'market-data-skill.zip'), path.join(output, `market-data-skill-${pkg.version}.zip`));
  cpSync(path.join(root, 'docs/windows-client-install.md'), path.join(output, 'INSTALL-WINDOWS.md'));
  const archives = [`databento-chatgpt-windows-${pkg.version}.zip`, `databento-claude-${pkg.version}.mcpb`, `market-data-skill-${pkg.version}.zip`];
  writeFileSync(path.join(output, 'SHA256SUMS.txt'), archives.map(name => `${sha256(readFileSync(path.join(output, name)))}  ${name}`).join('\n') + '\n');
  json(path.join(output, 'BUILD.json'), { ...build, files: undefined });
  console.log(`Windows packages built: ${output}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
