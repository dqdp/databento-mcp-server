import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const { verifyPayload } = require('../packaging/openai/install-openai.cjs');
const root = process.cwd();
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const temp = mkdtempSync(path.join(os.tmpdir(), 'databento Windows тест '));

async function main() {
  const extracted = path.join(temp, 'extracted plugin');
  const zip = new AdmZip(path.join(root, `dist/windows/databento-chatgpt-windows-${version}.zip`));
  for (const entry of zip.getEntries()) {
    assert(!entry.entryName.split('/').includes('..'), 'Archive contains traversal');
    assert(!/(^|\/)\.env$|api_key\.txt$|(^|\/)\.git\//.test(entry.entryName), 'Archive contains a secret or checkout file');
  }
  zip.extractAllTo(extracted);
  verifyPayload(extracted);
  const manifest = JSON.parse(readFileSync(path.join(extracted, 'plugin.json'), 'utf8'));
  const overlay = JSON.parse(readFileSync(path.join(extracted, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'databento-mcp'); assert.equal(manifest.version, version);
  assert.equal(overlay.version, version); assert.equal(overlay.name, manifest.name);
  assert.equal(manifest.extensions['com.openai'].requires_local_executor, true);
  assert(existsSync(path.join(extracted, 'skills/market-data/SKILL.md')));
  assert.equal(readFileSync(path.join(extracted, 'runtime/node.exe')).subarray(0, 2).toString(), 'MZ');
  // Isolate os.homedir in child processes without changing the user's HOME or
  // USERPROFILE. The real extracted CLI writes the key; the real launcher must
  // then load that file with no key injected into its environment.
  const preload = path.join(temp, 'isolated-home.cjs');
  writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(path.join(temp, 'clean home'))};\n`);
  const runtime = process.platform === 'win32' ? path.join(extracted, 'runtime/node.exe') : process.execPath;
  const installed = JSON.parse(execFileSync(runtime, ['--require', preload, path.join(extracted, 'install-openai.cjs')], {
    cwd: extracted, env: { ...getDefaultEnvironment(), DATABENTO_API_KEY: 'db-test-key' }, encoding: 'utf8',
  }));
  const config = JSON.parse(readFileSync(path.join(installed.target, 'mcp.json'), 'utf8')).mcpServers.databento;
  const legacy = JSON.parse(readFileSync(path.join(installed.target, '.mcp.json'), 'utf8')).mcpServers.databento;
  assert.equal(config.type, 'stdio'); assert.equal(config.command, legacy.command);
  assert.deepEqual(config.args, legacy.args);
  const resolve = (value: string) => value.replaceAll('${PLUGIN_ROOT}', installed.target);
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? resolve(config.command) : process.execPath,
    args: ['--require', preload, ...config.args.map(resolve)], cwd: resolve(config.cwd),
    env: { ...getDefaultEnvironment(), SMILE_WEB_PORT: '' }, stderr: 'pipe',
  });
  const client = new Client({ name: 'windows-package-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ['get_futures_quote', 'get_live_futures_quote', 'get_session_info']) assert(tools.tools.some(tool => tool.name === name));
    const result = await client.callTool({ name: 'get_session_info' });
    assert(!result.isError);
    const text = (result.content as Array<{ type: string; text: string }>).find(item => item.type === 'text');
    assert(text); assert(JSON.parse(text.text).timestamp);
    const invalid = await client.callTool({ name: 'get_futures_quote', arguments: { symbol: 'INVALID' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await transport.close(); }
  console.log(`Windows archive smoke passed (${process.platform === 'win32' ? 'bundled Windows node.exe' : 'host Node; Windows binary execution requires Windows CI'})`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
