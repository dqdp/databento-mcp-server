const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

function payloadFiles(root, prefix = '') {
  const files = {};
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error('Package must not contain symbolic links');
    if (item.isDirectory()) Object.assign(files, payloadFiles(root, name));
    else if (item.isFile() && name !== 'BUILD.json') {
      files[name] = createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    } else if (!item.isFile()) throw new Error('Unsupported package file');
  }
  return files;
}

function verifyPayload(source) {
  const expected = JSON.parse(fs.readFileSync(path.join(source, 'BUILD.json'), 'utf8')).files;
  const actual = payloadFiles(source);
  if (!expected || Object.keys(expected).length !== Object.keys(actual).length ||
      Object.entries(actual).some(([name, hash]) => expected[name] !== hash)) {
    throw new Error('Package SHA-256 mismatch; extract a fresh copy of the complete ZIP');
  }
}

function installPlugin({ source, home = os.homedir(), apiKey = process.env.DATABENTO_API_KEY }) {
  source = path.resolve(source);
  verifyPayload(source);
  const catalog = path.join(home, '.agents/plugins/marketplace.json');
  const target = path.join(home, '.codex/plugins/databento-mcp');
  const keyFile = path.join(home, '.databento-mcp/.env');
  const existing = fs.existsSync(catalog)
    ? JSON.parse(fs.readFileSync(catalog, 'utf8'))
    : { name: 'personal-plugins', interface: { displayName: 'Personal plugins' }, plugins: [] };
  if (!existing || typeof existing !== 'object' || !Array.isArray(existing.plugins) ||
      existing.plugins.some(entry => !entry || typeof entry !== 'object')) {
    throw new Error('Existing marketplace.json has an unsupported format; nothing was changed');
  }
  if (apiKey && !/^db-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('Invalid Databento API key format');
  if (!apiKey && !fs.existsSync(keyFile)) throw new Error('Databento API key is required for the first installation');
  const catalogBefore = fs.existsSync(catalog) ? fs.readFileSync(catalog) : undefined;
  const keyBefore = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : undefined;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.databento-stage-'));
  const staged = path.join(staging, 'databento-mcp');
  const backupRoot = path.join(home, '.codex/databento-backups');
  const stamp = `${Date.now()}-${process.pid}`;
  let backup, activated = false, keyChanged = false;
  const pending = `${catalog}.${stamp}.tmp`;
  try {
    fs.cpSync(source, staged, { recursive: true, dereference: false });
    verifyPayload(staged);
    existing.plugins = existing.plugins.filter(entry => entry.name !== 'databento-mcp');
    existing.plugins.push({ name: 'databento-mcp', source: { source: 'local', path: './.codex/plugins/databento-mcp' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
    fs.mkdirSync(path.dirname(catalog), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify(existing, null, 2) + '\n', { flag: 'wx' });
    fs.mkdirSync(backupRoot, { recursive: true });
    if (catalogBefore) fs.writeFileSync(path.join(backupRoot, `marketplace-${stamp}.json`), catalogBefore);
    if (fs.existsSync(target)) {
      backup = path.join(backupRoot, `databento-mcp-${stamp}`);
      fs.renameSync(target, backup);
    }
    fs.renameSync(staged, target);
    activated = true;
    if (apiKey) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      keyChanged = true;
      fs.writeFileSync(keyFile, `DATABENTO_API_KEY=${JSON.stringify(apiKey)}\n`, { mode: 0o600 });
    }
    fs.renameSync(pending, catalog);
    return { target, catalog, backup, next: 'Restart ChatGPT, then install Databento MCP from your personal plugin catalog.' };
  } catch (error) {
    if (activated) fs.renameSync(target, staged);
    if (backup) fs.renameSync(backup, target);
    if (keyChanged) {
      if (keyBefore) fs.writeFileSync(keyFile, keyBefore, { mode: 0o600 });
      else fs.rmSync(keyFile, { force: true });
    }
    throw error;
  } finally {
    fs.rmSync(pending, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { installPlugin, payloadFiles, verifyPayload };
if (require.main === module) {
  try { console.log(JSON.stringify(installPlugin({ source: __dirname }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
