/** Service-only assertion of an owner's subscription, bound to their current credential. */
import {createHash} from "node:crypto";
import {getStandardCmeSchemaEntitlement} from "./entitlement-policy.js";

export interface PlatformSubscription {
  plan:"cme_standard";
  policy_version:1;
  credential_sha256:string;
}
const HISTORICAL_TOOLS=new Set([
  "timeseries_get_range","get_historical_bars","get_futures_quote","get_futures_options_smile",
]);

export function validatePlatformSubscription(value:unknown,apiKey:unknown,toolName:string):PlatformSubscription|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=="object"||Array.isArray(value)||!HISTORICAL_TOOLS.has(toolName)||
    typeof apiKey!=="string"||!apiKey.startsWith("db-"))throw new Error("Invalid subscription assertion");
  const item=value as Record<string,unknown>;
  if(Object.keys(item).length!==3||item.plan!=="cme_standard"||item.policy_version!==1||
    typeof item.credential_sha256!=="string"||!/^[a-f0-9]{64}$/.test(item.credential_sha256)||
    item.credential_sha256!==createHash("sha256").update(apiKey).digest("hex"))
    throw new Error("Invalid subscription assertion");
  return {plan:"cme_standard",policy_version:1,credential_sha256:item.credential_sha256};
}

// Date.parse truncates fractional seconds to milliseconds. Never use it alone at a billing
// boundary: one nanosecond outside a rolling window must not acquire included-data status.
function timestampNanoseconds(value:unknown):bigint|undefined {
  if(typeof value!=="string")return undefined;
  if(/^(0|[1-9]\d{0,19})$/.test(value)){
    const nanos=BigInt(value);
    return nanos<=18_446_744_073_709_551_615n?nanos:undefined;
  }
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if(!match)return undefined;
  const [,year,month,day,hour="00",minute="00",second="00",fraction="",zone="Z"]=match;
  const localDate=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)));
  if(localDate.getUTCFullYear()!==Number(year)||localDate.getUTCMonth()!==Number(month)-1||
    localDate.getUTCDate()!==Number(day))return undefined;
  const seconds=Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
  if(!Number.isSafeInteger(seconds))return undefined;
  return BigInt(seconds)*1_000_000n+BigInt(fraction.padEnd(9,"0"));
}

function subtractUtcMonths(date:Date,months:number):Date {
  const result=new Date(date.getTime());
  const day=result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth()-months);
  const lastDay=new Date(Date.UTC(result.getUTCFullYear(),result.getUTCMonth()+1,0)).getUTCDate();
  result.setUTCDate(Math.min(day,lastDay));
  return result;
}

/** Conservative classification of each actual HTTP subrequest, never inferred from a tool. */
export function isStandardCmeHistoricalCovered(request:Record<string,unknown>,now=new Date()):boolean {
  if(request.dataset!=="GLBX.MDP3"||typeof request.schema!=="string"||
    request.schema!==request.schema.trim().toLowerCase()||!Number.isFinite(now.getTime()))return false;
  const entitlement=getStandardCmeSchemaEntitlement(request.schema);
  if(!entitlement)return false;
  const start=timestampNanoseconds(request.start);
  let end=timestampNanoseconds(request.end);
  // The provider documents YYYY-MM-DD with omitted end as exactly the next UTC midnight:
  // https://databento.com/docs/conventions/common-fields-enums-types#forward-filling-end-parameters
  // Classify that effective interval without rewriting the original request. No inference is
  // made for omitted second/nanosecond-resolution end values.
  if(request.end===undefined&&start!==undefined&&typeof request.start==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(request.start))
    end=start+86_400_000_000_000n;
  const nowNs=BigInt(now.getTime())*1_000_000n;
  // Unknown forward-fill semantics require a provider estimate. In particular, a date-only
  // start is midnight, not rounded forward to the rolling-window boundary.
  if(start===undefined||end===undefined||start<0n||end<=start||end>nowNs)return false;
  if(entitlement.rollingWindowMonths===undefined)return true;
  const earliest=BigInt(subtractUtcMonths(now,entitlement.rollingWindowMonths).getTime())*1_000_000n;
  return start>=earliest;
}
