import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { installPlugin } = require("../../packaging/openai/install-openai.cjs");
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "databento-install-test-")); roots.push(root);
  const source = path.join(root, "source"); const home = path.join(root, "home");
  mkdirSync(source); mkdirSync(home);
  const payload = { "plugin.json": JSON.stringify({ name: "databento-mcp", version: "1.3.2" }), "server.js": "test fixture" };
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(payload)) { writeFileSync(path.join(source, name), content); files[name] = createHash("sha256").update(content).digest("hex"); }
  writeFileSync(path.join(source, "BUILD.json"), JSON.stringify({ files }));
  return { source, home };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("Windows local plugin installer", () => {
  it("executes the packaged Windows runtime smoke on the Windows runner", () => {
    const workflow = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    expect(workflow.slice(workflow.indexOf('  windows-consumer-smoke:'))).toContain('run: npm run smoke:windows');
  });
  it("preserves other marketplace entries and keeps the API key outside the copied plugin", () => {
    const { source, home } = fixture();
    const catalog = path.join(home, ".agents/plugins/marketplace.json"); mkdirSync(path.dirname(catalog), { recursive: true });
    const other = { name: "existing-plugin", source: { source: "local", path: "./other" } };
    writeFileSync(catalog, JSON.stringify({ name: "personal", plugins: [other], custom: true }));
    const result = installPlugin({ source, home, apiKey: "db-test-key" });
    const saved = JSON.parse(readFileSync(catalog, "utf8"));
    expect(saved.plugins[0]).toEqual(other); expect(saved.custom).toBe(true);
    expect(saved.plugins[1].source.path).toBe("./.codex/plugins/databento-mcp");
    expect(readFileSync(path.join(result.target, "server.js"), "utf8")).toBe("test fixture");
    expect(existsSync(path.join(result.target, ".env"))).toBe(false);
    expect(readFileSync(path.join(home, ".databento-mcp/.env"), "utf8")).toContain("db-test-key");
    expect(JSON.stringify(result)).not.toContain("db-test-key");
    const second = installPlugin({ source, home });
    expect(JSON.parse(readFileSync(catalog, "utf8")).plugins).toHaveLength(2);
    expect(existsSync(second.backup)).toBe(true);
    expect(readFileSync(path.join(home, ".databento-mcp/.env"), "utf8")).toContain("db-test-key");
  });
  it("rejects a malformed existing catalog without altering it or storing a key", () => {
    const { source, home } = fixture(); const catalog = path.join(home, ".agents/plugins/marketplace.json");
    mkdirSync(path.dirname(catalog), { recursive: true }); writeFileSync(catalog, '{"plugins":"bad"}');
    expect(() => installPlugin({ source, home, apiKey: "db-test-key" })).toThrow();
    expect(readFileSync(catalog, "utf8")).toBe('{"plugins":"bad"}');
    expect(existsSync(path.join(home, ".databento-mcp/.env"))).toBe(false);
  });
  it("rejects tampered or extra payload files before changing an existing installation", () => {
    const { source, home } = fixture(); installPlugin({ source, home, apiKey: "db-test-key" });
    const catalog = path.join(home, ".agents/plugins/marketplace.json"); const before = readFileSync(catalog, "utf8");
    writeFileSync(path.join(source, "server.js"), "tampered");
    expect(() => installPlugin({ source, home })).toThrow(/hash|SHA/i);
    expect(readFileSync(catalog, "utf8")).toBe(before);
    expect(readFileSync(path.join(home, ".codex/plugins/databento-mcp/server.js"), "utf8")).toBe("test fixture");
    writeFileSync(path.join(source, 'server.js'), 'test fixture');
    writeFileSync(path.join(source, 'unexpected.env'), 'untracked');
    expect(() => installPlugin({ source, home })).toThrow(/hash|SHA/i);
  });
  it("restores the plugin and key if catalog publication fails", () => {
    const { source, home } = fixture(); installPlugin({ source, home, apiKey: 'db-old-test-key' });
    const catalog = path.join(home, '.agents/plugins/marketplace.json'); const before = readFileSync(catalog, 'utf8');
    const fs = require('node:fs'); const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from: string, to: string) => {
      if (to === catalog) throw new Error('simulated catalog failure');
      return rename(from, to);
    });
    expect(() => installPlugin({ source, home, apiKey: 'db-new-test-key' })).toThrow('simulated catalog failure');
    expect(readFileSync(catalog, 'utf8')).toBe(before);
    expect(readFileSync(path.join(home, '.databento-mcp/.env'), 'utf8')).toContain('db-old-test-key');
    expect(readFileSync(path.join(home, '.codex/plugins/databento-mcp/server.js'), 'utf8')).toBe('test fixture');
  });
});
