/** Server-only zero-cost guard and decoded original capture. Install in an isolated child only. */
import { createHash } from "node:crypto";
import { DataBentoHTTP } from "../http/databento-http.js";

export interface PlatformOriginal {
  name: string;
  media_type: string;
  data_base64: string;
  sha256: string;
  request: {endpoint: string; parameters: Record<string, unknown>};
  received_at: string;
  representation: "decoded_http_body";
}
const FREE_METADATA = new Set([
  "/v0/metadata.list_datasets", "/v0/metadata.list_schemas", "/v0/metadata.list_publishers",
  "/v0/metadata.list_fields", "/v0/metadata.get_cost", "/v0/metadata.get_dataset_range",
]);
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const ERROR = "Databento server operation is not permitted";
const COST_FIELDS = ["dataset", "symbols", "schema", "start", "end", "stype_in", "limit"];

function parameters(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(ERROR);
  const copied: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (/key|token|password|secret|authorization|credential/i.test(name)) throw new Error(ERROR);
    if (item !== undefined && item !== null) {
      if (!["string", "number", "boolean"].includes(typeof item) && !Array.isArray(item)) throw new Error(ERROR);
      if (Array.isArray(item) && item.some(v => typeof v !== "string")) throw new Error(ERROR);
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error(ERROR);
      copied[name] = Array.isArray(item) ? [...item] : item;
    }
  }
  return copied;
}

export function installPlatformTransportGuard(apiKey: string) {
  const prototype = DataBentoHTTP.prototype;
  const originalGet = prototype.get;
  const originalPost = prototype.post;
  const originalPostForm = prototype.postForm;
  const originalBinary = prototype.postFormBinary;
  const originals: PlatformOriginal[] = [];
  let bytes = 0;

  function capture(endpoint: string, params: Record<string, unknown>, value: string | Buffer) {
    const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    if (body.includes(Buffer.from(apiKey, "utf8")) || JSON.stringify(params).includes(apiKey) || bytes + body.length > MAX_CAPTURE_BYTES) throw new Error(ERROR);
    bytes += body.length;
    const media = endpoint === "/v0/timeseries.get_range" ? "text/csv" : "application/json";
    originals.push({name: `databento-${originals.length + 1}.${media === "text/csv" ? "csv" : "json"}`,
      media_type: media, data_base64: body.toString("base64"), sha256: createHash("sha256").update(body).digest("hex"),
      request: {endpoint, parameters: params}, received_at: new Date().toISOString(), representation: "decoded_http_body"});
  }

  prototype.get = async function(endpoint, params, options) {
    const safe = parameters(params);
    if (FREE_METADATA.has(endpoint)) {
      const value = await originalGet.call(this, endpoint, params, options);
      capture(endpoint, safe, value);
      return value;
    }
    if (endpoint !== "/v0/timeseries.get_range") throw new Error(ERROR);
    if (!["dataset", "symbols", "schema", "start"].every(field => typeof safe[field] === "string" && safe[field])) throw new Error(ERROR);
    const estimate: Record<string, unknown> = {};
    for (const field of COST_FIELDS) if (safe[field] !== undefined) estimate[field] = safe[field];
    // Omitted end stays omitted: preflight and download use identical provider forward-fill semantics.
    const rawCost = await originalGet.call(this, "/v0/metadata.get_cost", estimate, options);
    let cost: unknown;
    try { cost = JSON.parse(rawCost); } catch { throw new Error(ERROR); }
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost !== 0) throw new Error(ERROR);
    capture("/v0/metadata.get_cost", estimate, rawCost);
    const value = await originalGet.call(this, endpoint, params, options);
    capture(endpoint, safe, value);
    return value;
  };
  prototype.postForm = async function(endpoint, data, options) {
    if (endpoint !== "/v0/symbology.resolve") throw new Error(ERROR);
    const safe = parameters(data);
    const value = await originalPostForm.call(this, endpoint, data, options);
    capture(endpoint, safe, value);
    return value;
  };
  prototype.post = async function() { throw new Error(ERROR); };
  prototype.postFormBinary = async function() { throw new Error(ERROR); };

  return {originals, restore() {
    prototype.get = originalGet; prototype.post = originalPost;
    prototype.postForm = originalPostForm; prototype.postFormBinary = originalBinary;
  }};
}
