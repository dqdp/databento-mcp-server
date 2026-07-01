/**
 * OPT-IN live smoke for get_futures_options_smile — hits the REAL Databento GLBX.MDP3 API
 * (not in the default gate; needs DATABENTO_API_KEY). Drives buildSmile at the real entrypoint
 * for one root and prints the resulting chain, so we verify the pull/normalize/Black-76
 * pipeline against live data shapes.
 *
 *   npx tsx scripts/smoke-smile-live.ts [ROOT] [expiry|mode]
 *   e.g. npx tsx scripts/smoke-smile-live.ts ES
 *        npx tsx scripts/smoke-smile-live.ts ES quarterly
 */
import { readFileSync } from "node:fs";
import { createDefaultDatabentoMcpClients } from "../mcp/index.js";
import { buildSmile, clampNowToAvailable, resolveExpirySelector } from "../src/analytics/pull-chain.js";

// Load .env (self-locating) without adding a dotenv dependency.
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — rely on the ambient environment */
}

const apiKey = process.env.DATABENTO_API_KEY;
if (!apiKey) {
  console.error("DATABENTO_API_KEY required (in .env or the environment) for the live smile smoke");
  process.exit(1);
}

const root = (process.argv[2] ?? "ES").toUpperCase();
const { mode, expiry } = resolveExpirySelector(process.argv[3]);

const { timeseriesClient, metadataClient } = createDefaultDatabentoMcpClients(apiKey);

const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

async function main() {
  const t0 = Date.now();

  // Mirror the MCP handler: clamp `now` to the dataset's available_end (the historical feed
  // lags wall-clock, so an end at wall-now 422s with data_end_after_available_end).
  let availableEnd: string | undefined;
  try {
    const range = (await metadataClient.getDatasetRange({ dataset: "GLBX.MDP3" })) as { end?: string; end_date?: string };
    availableEnd = range?.end ?? range?.end_date;
  } catch {
    availableEnd = undefined;
  }
  const nowIso = clampNowToAvailable(new Date().toISOString(), availableEnd);
  const today = nowIso.slice(0, 10);
  console.log(`wall-now ${new Date().toISOString()} · available_end ${availableEnd ?? "n/a"} · effective now ${nowIso}`);

  const chain = await buildSmile(timeseriesClient, root, {
    today,
    now: nowIso,
    mode,
    expiry,
  });
  const ms = Date.now() - t0;

  console.log(`\n=== ${chain.symbol} futures-options smile (LIVE) ===`);
  console.log(`exp ${chain.expiration} · ${chain.dte} DTE · spot(F) ${chain.spot} · asOf ${chain.asOf}`);
  console.log(`ATM IV ${pct(chain.atmIV)} · 25Δ skew ${chain.skew25 == null ? "n/a" : `${(chain.skew25 * 100).toFixed(1)}pt`} · ` +
    `PCR(OI) ${chain.pcrOI == null ? "n/a" : chain.pcrOI.toFixed(2)} · max pain ${chain.maxPain}`);
  console.log(`nExpirations ${chain.nExpirations} · nContracts ${chain.nContracts} · strikes shown ${chain.strikes.length}`);
  console.log(`expirations: ${chain.expirations.slice(0, 12).join(", ")}${chain.expirations.length > 12 ? " …" : ""}`);

  const ivCount = chain.callIV.filter((v) => v != null).length + chain.putIV.filter((v) => v != null).length;
  console.log(`solved IV points: ${ivCount} across ${chain.strikes.length} strikes`);
  console.log(`sample: K=${chain.atmStrike} callIV=${pct(chain.callIV[chain.strikes.indexOf(chain.atmStrike)] ?? null)} ` +
    `putIV=${pct(chain.putIV[chain.strikes.indexOf(chain.atmStrike)] ?? null)}`);

  // Correctness gates for the smoke to be meaningful:
  if (!(chain.spot > 0)) throw new Error("forward (spot) not positive");
  if (chain.strikes.length === 0) throw new Error("no strikes in the smile");
  if (ivCount === 0) throw new Error("no IV solved on any strike");
  if (chain.nExpirations < 1) throw new Error("nExpirations < 1");

  console.log(`\nLive smile smoke passed in ${ms} ms (${root}${mode ? ` / ${mode}` : expiry ? ` / ${expiry}` : ""}).`);
}

main().catch((err) => {
  console.error(`\nLive smile smoke FAILED for ${root}: ${(err as Error).message}`);
  process.exit(1);
});
