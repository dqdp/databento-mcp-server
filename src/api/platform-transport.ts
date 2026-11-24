/** Server-only estimate allowance and exact HTTP body capture. Estimates are not actual bills. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { DataBentoHTTP, DataBentoHTTPStatusError, NonRetryableResponseError } from "../http/databento-http.js";
import {COST_BASIS,MAX_COST_USD,usdToMicros,validateCostControl,type PlatformCostControl,type PlatformCostSummary} from "./platform-cost.js";
import {isStandardCmeHistoricalCovered,validatePlatformSubscription,type PlatformSubscription} from "./platform-subscription.js";

export interface PlatformOriginal {
  name: string;
  media_type: string;
  data_base64: string;
  sha256: string;
  request: {endpoint: string; parameters: Record<string, unknown>};
  received_at: string;
  representation: "decoded_http_body" | "raw_live_dbn" | "selected_live_dbn";
}
const FREE_METADATA = new Set([
  "/v0/metadata.list_datasets", "/v0/metadata.list_schemas", "/v0/metadata.list_publishers",
  "/v0/metadata.list_fields", "/v0/metadata.get_cost", "/v0/metadata.get_dataset_range",
]);
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const CME_DEFINITION_TIMEOUT_MS = 45_000;
const ERROR = "Databento server operation is not permitted";
const COST_FIELDS = ["dataset", "symbols", "schema", "start", "end", "stype_in", "limit"];
type FailurePhase="metadata"|"cost_estimate"|"market_data"|"result_processing";
export interface PlatformFailure {
  error_code:"upstream_http_error"|"timeout"|"transport_error"|"response_rejected"|"invalid_cost_estimate"|"approval_required"|"result_processing_failed";
  phase:FailurePhase;
  http_status?:number;
}
function isTimeout(error:unknown):boolean {
  for(let depth=0;depth<4&&error instanceof Error;depth++,error=error.cause)
    if(["AbortError","TimeoutError"].includes(error.name))return true;
  return false;
}
function finalHttpStatus(error:unknown):number|undefined {
  for(let depth=0;depth<4&&error instanceof Error;depth++,error=error.cause)
    if(error instanceof DataBentoHTTPStatusError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)
      return error.status;
  return undefined;
}

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

export function installPlatformTransportGuard(apiKey: string, suppliedControl?:PlatformCostControl,suppliedSubscription?:PlatformSubscription) {
  const control=validateCostControl(suppliedControl);
  const subscription=validatePlatformSubscription(suppliedSubscription,apiKey,"timeseries_get_range");
  // Integer micro-USD are reserved before data starts; rounding cannot under-count tiny pulls.
  const allowanceMicros = usdToMicros(String(control?.allowance_usd ?? 0), "down");
  let spentMicros=0,approvalRequired=false,requiredAllowance:number|undefined;
  let subscriptionCoveredRequests=0;
  let failure:PlatformFailure|undefined;
  function rejected(error_code:PlatformFailure["error_code"],phase:FailurePhase):never {
    failure={error_code,phase};throw new NonRetryableResponseError(ERROR);
  }
  function costSummary():PlatformCostSummary {
    return {reservation_id:control?.reservation_id??null,estimated_spent_usd:spentMicros/1_000_000,
      approval_required:approvalRequired,...(requiredAllowance===undefined?{}:{required_allowance_usd:requiredAllowance}),
      ...(subscriptionCoveredRequests?{subscription_covered_requests:subscriptionCoveredRequests}:{}),basis:COST_BASIS};
  }
  const prototype = DataBentoHTTP.prototype;
  const originalGet = prototype.get;
  const originalPost = prototype.post;
  const originalPostForm = prototype.postForm;
  const originalBinary = prototype.postFormBinary;
  const originalReadResponseText = prototype.readResponseText;
  const contexts = new AsyncLocalStorage<{body?: Buffer}>();
  const originals: PlatformOriginal[] = [];
  // Count every consumed body byte, including error/retry responses and parallel pulls.
  let consumedBytes = 0;

  prototype.readResponseText = async function(response: Response): Promise<string> {
    const context = contexts.getStore();
    if (!context) {
      await response.body?.cancel().catch(() => {});
      throw new NonRetryableResponseError(ERROR);
    }
    delete context.body;
    if (!response.body) {
      context.body = Buffer.alloc(0);
      return "";
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", {fatal: true});
    const chunks: Buffer[] = [];
    const text: string[] = [];
    let responseBytes = 0;
    const responseLimit = response.ok ? MAX_CAPTURE_BYTES : MAX_ERROR_BODY_BYTES;
    try {
      // Content-Length refers to encoded bytes when compression is in use. Always enforce the
      // streamed decoded byte count; only precheck identity bodies with a well-formed length.
      const declared = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      if ((!encoding || encoding === "identity") && declared && /^[0-9]{1,20}$/.test(declared) &&
          BigInt(declared) > BigInt(Math.min(responseLimit, MAX_CAPTURE_BYTES - consumedBytes))) {
        throw new NonRetryableResponseError(ERROR);
      }
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.byteLength > responseLimit - responseBytes ||
            part.value.byteLength > MAX_CAPTURE_BYTES - consumedBytes) {
          consumedBytes = MAX_CAPTURE_BYTES;
          throw new NonRetryableResponseError(ERROR);
        }
        responseBytes += part.value.byteLength;
        consumedBytes += part.value.byteLength;
        const bytes = Buffer.from(part.value);
        chunks.push(bytes);
        text.push(decoder.decode(bytes, {stream: true}));
      }
      // Capture the original bytes before final decoding; BOM handling belongs only to text.
      context.body = Buffer.concat(chunks, responseBytes);
      text.push(decoder.decode());
      return text.join("");
    } catch(error) {
      delete context.body;
      await reader.cancel().catch(() => {});
      throw new NonRetryableResponseError(ERROR,{cause:error});
    } finally {
      reader.releaseLock();
    }
  };

  async function readInvocation(invoke: () => Promise<string>,phase:FailurePhase) {
    if (consumedBytes >= MAX_CAPTURE_BYTES) rejected("response_rejected",phase);
    const context: {body?: Buffer} = {};
    try{
      const value = await contexts.run(context, invoke);
      if (!Buffer.isBuffer(context.body)) rejected("response_rejected",phase);
      return {value, body: context.body};
    }catch(error){
      const status=finalHttpStatus(error);
      failure=status!==undefined?
        {error_code:"upstream_http_error",phase,http_status:status}:
        {error_code:isTimeout(error)?"timeout":error instanceof NonRetryableResponseError?"response_rejected":"transport_error",phase};
      throw error;
    }
  }

  function capture(endpoint: string, params: Record<string, unknown>, body: Buffer) {
    if (body.includes(Buffer.from(apiKey, "utf8")) || JSON.stringify(params).includes(apiKey)) {
      throw new NonRetryableResponseError(ERROR);
    }
    const media = endpoint === "/v0/timeseries.get_range" ? "text/csv" : "application/json";
    originals.push({name: `databento-${originals.length + 1}.${media === "text/csv" ? "csv" : "json"}`,
      media_type: media, data_base64: body.toString("base64"), sha256: createHash("sha256").update(body).digest("hex"),
      request: {endpoint, parameters: params}, received_at: new Date().toISOString(), representation: "decoded_http_body"});
  }

  prototype.get = async function(endpoint, params, options) {
    const safe = parameters(params);
    if (FREE_METADATA.has(endpoint)) {
      const response = await readInvocation(() => originalGet.call(this, endpoint, params, options),endpoint==="/v0/metadata.get_cost"?"cost_estimate":"metadata");
      capture(endpoint, safe, response.body);
      return response.value;
    }
    if (endpoint !== "/v0/timeseries.get_range") throw new Error(ERROR);
    if(approvalRequired)throw new NonRetryableResponseError(ERROR);
    if (!["dataset", "symbols", "schema", "start"].every(field => typeof safe[field] === "string" && safe[field])) throw new Error(ERROR);
    const dataOptions = {...options, retry: false};
    if (safe.dataset === "GLBX.MDP3" && safe.schema === "definition" && dataOptions.timeout === undefined) {
      dataOptions.timeout = CME_DEFINITION_TIMEOUT_MS;
    }
    if(subscription&&isStandardCmeHistoricalCovered(safe)){
      if(subscriptionCoveredRequests>=10000)throw new NonRetryableResponseError(ERROR);
      subscriptionCoveredRequests++;
      // An included attempt has no monetary estimate. Keep all byte limits, exact originals,
      // and no automatic retries; a mixed tool must classify its next subrequest anew.
      const response=await readInvocation(()=>originalGet.call(this,endpoint,params,dataOptions),"market_data");
      capture(endpoint,safe,response.body);
      return response.value;
    }
    const estimate: Record<string, unknown> = {};
    for (const field of COST_FIELDS) if (safe[field] !== undefined) estimate[field] = safe[field];
    // Omitted end stays omitted: preflight and download use identical forward-fill semantics.
    const costResponse = await readInvocation(() => originalGet.call(this, "/v0/metadata.get_cost", estimate, options),"cost_estimate");
    let costMicros: number;
    try {
      costMicros = usdToMicros(costResponse.value, "up");
    } catch {
      rejected("invalid_cost_estimate", "cost_estimate");
    }
    capture("/v0/metadata.get_cost", estimate, costResponse.body);
    if(consumedBytes>=MAX_CAPTURE_BYTES)throw new NonRetryableResponseError(ERROR);
    // No await between this check and reservation: parallel sub-pulls share one invocation cap.
    if(approvalRequired)throw new NonRetryableResponseError(ERROR);
    const requiredMicros=costMicros+spentMicros;
    if(!Number.isSafeInteger(requiredMicros)||requiredMicros>MAX_COST_USD*1_000_000)throw new NonRetryableResponseError(ERROR);
    if(costMicros>allowanceMicros-spentMicros){
      approvalRequired=true;
      requiredAllowance=requiredMicros/1_000_000;
      rejected("approval_required","cost_estimate");
    }
    spentMicros+=costMicros;
    // A timeout/HTTP failure may still be billable; retain its estimate and never retry data.
    const response = await readInvocation(() => originalGet.call(this, endpoint, params, dataOptions),"market_data");
    capture(endpoint, safe, response.body);
    return response.value;
  };
  prototype.postForm = async function(endpoint, data, options) {
    if (endpoint !== "/v0/symbology.resolve") throw new Error(ERROR);
    const safe = parameters(data);
    const response = await readInvocation(() => originalPostForm.call(this, endpoint, data, options),"metadata");
    capture(endpoint, safe, response.body);
    return response.value;
  };
  prototype.post = async function() { throw new Error(ERROR); };
  prototype.postFormBinary = async function() { throw new Error(ERROR); };

  return {originals, costSummary, failureSummary:():PlatformFailure=>failure?{...failure}:{error_code:"result_processing_failed",phase:"result_processing"},restore() {
    prototype.get = originalGet; prototype.post = originalPost;
    prototype.postForm = originalPostForm; prototype.postFormBinary = originalBinary;
    prototype.readResponseText = originalReadResponseText;
    contexts.disable();
  }};
}
