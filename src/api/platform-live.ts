/** Private platform capture. Only received DBN bytes are originals; no auth/control transcript. */
import {AsyncLocalStorage} from "node:async_hooks";
import {createHash} from "node:crypto";

export const LIVE_COST_STATUS={basis:"live_subscription_entitlement",status:"not_estimated",
  additional_cost_usd:null,historical_get_cost_applicable:false} as const;
export type PlatformLiveCostStatus=typeof LIVE_COST_STATUS;
export interface PlatformLiveOriginal {
  name:string;media_type:"application/octet-stream";data_base64:string;sha256:string;
  request:{endpoint:"live.subscribe";parameters:Record<string,unknown>};
  received_at:string;representation:"raw_live_dbn";
}
const captures=new AsyncLocalStorage<PlatformLiveOriginal[]>();
export function withPlatformLiveCapture<T>(originals:PlatformLiveOriginal[],operation:()=>Promise<T>):Promise<T>{
  return captures.run(originals,operation);
}
export function platformLiveCaptureActive():boolean{return captures.getStore()!==undefined;}
export function captureLiveDbn(bytes:Buffer,parameters:Record<string,unknown>,receivedAt:string,apiKey:string):void{
  const originals=captures.getStore();
  if(!originals)return;
  if(bytes.length<8||bytes.length>16*1024*1024||bytes.toString("ascii",0,3)!=="DBN")throw new Error("Invalid Live DBN capture");
  if(bytes.includes(Buffer.from(apiKey,"utf8")))throw new Error("Invalid Live DBN capture");
  originals.push({name:`databento-live-${originals.length+1}.dbn`,media_type:"application/octet-stream",
    data_base64:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex"),
    request:{endpoint:"live.subscribe",parameters},received_at:receivedAt,representation:"raw_live_dbn"});
}
export function validateLiveCostStatus(value:unknown):PlatformLiveCostStatus{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==4||
    Object.entries(LIVE_COST_STATUS).some(([key,item])=>(value as Record<string,unknown>)[key]!==item))throw new Error("Invalid Live cost status");
  return LIVE_COST_STATUS;
}
