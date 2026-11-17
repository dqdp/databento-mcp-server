/** Authenticated service cost lease; estimates are not confirmed provider charges. */
export const MAX_COST_USD=1_000_000;
export const COST_BASIS = "provider_estimate_after_plan_discounts" as const;
export interface PlatformCostControl {
  reservation_id: string;
  allowance_usd: number;
}
export interface PlatformCostSummary {
  reservation_id: string | null;
  estimated_spent_usd: number;
  approval_required: boolean;
  required_allowance_usd?: number;
  subscription_covered_requests?: number;
  basis: typeof COST_BASIS;
}

/** Service-only fields are authenticated by the Gateway body digest, never MCP arguments. */
export function validateCostControl(value: unknown): PlatformCostControl | undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid cost control");
  const item=value as Record<string,unknown>;
  if(Object.keys(item).length!==2||typeof item.reservation_id!=="string"||!/^[a-f0-9]{32}$/.test(item.reservation_id)||
    typeof item.allowance_usd!=="number"||!Number.isFinite(item.allowance_usd)||item.allowance_usd<0||item.allowance_usd>MAX_COST_USD||
    !Number.isSafeInteger(Math.floor(item.allowance_usd*1_000_000)))throw new Error("Invalid cost control");
  return {reservation_id:item.reservation_id,allowance_usd:item.allowance_usd};
}

export function emptyCostSummary(control?:PlatformCostControl):PlatformCostSummary {
  return {reservation_id:control?.reservation_id??null,estimated_spent_usd:0,approval_required:false,basis:COST_BASIS};
}

export function validateCostSummary(value:unknown,control?:PlatformCostControl):PlatformCostSummary {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid cost summary");
  const item=value as Record<string,unknown>;
  if(Object.keys(item).some(key=>!["reservation_id","estimated_spent_usd","approval_required","required_allowance_usd","subscription_covered_requests","basis"].includes(key))||
    item.reservation_id!==(control?.reservation_id??null)||item.basis!==COST_BASIS||
    typeof item.estimated_spent_usd!=="number"||!Number.isFinite(item.estimated_spent_usd)||item.estimated_spent_usd<0||
    item.estimated_spent_usd>(control?.allowance_usd??0)||typeof item.approval_required!=="boolean"||
    (item.subscription_covered_requests!==undefined&&(!Number.isSafeInteger(item.subscription_covered_requests)||
      (item.subscription_covered_requests as number)<0||(item.subscription_covered_requests as number)>10000))||
    (item.approval_required?(typeof item.required_allowance_usd!=="number"||
      !Number.isFinite(item.required_allowance_usd)||item.required_allowance_usd>(MAX_COST_USD)||
      item.required_allowance_usd<=(control?.allowance_usd??0)):
      item.required_allowance_usd!==undefined))throw new Error("Invalid cost summary");
  return item as unknown as PlatformCostSummary;
}
