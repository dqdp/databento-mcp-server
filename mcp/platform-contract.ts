/** Public tool filtering shared by the private parent and disposable MCP child. */
import { listDatabentoTools } from "./index.js";

export const PLATFORM_DISABLED_TOOLS = [
  "batch_submit_job", "batch_list_jobs", "batch_download",
  "reference_search_securities", "reference_get_corporate_actions", "reference_get_adjustments",
] as const;

export const PLATFORM_MCP_OPTIONS = {disabledTools: PLATFORM_DISABLED_TOOLS, profile: "platform"} as const;

export function listPlatformTools() {
  return listDatabentoTools(PLATFORM_MCP_OPTIONS);
}

import type {PlatformCostControl} from "../src/api/platform-cost.js";
import type {PlatformSubscription} from "../src/api/platform-subscription.js";
export {validatePlatformSubscription,type PlatformSubscription} from "../src/api/platform-subscription.js";
export {COST_BASIS,validateCostControl,validateCostSummary,emptyCostSummary,type PlatformCostControl,type PlatformCostSummary} from "../src/api/platform-cost.js";

export interface PlatformCall {
  name: string;
  arguments: Record<string, unknown>;
  api_key?: string;
  cost_control?: PlatformCostControl;
  subscription?: PlatformSubscription;
}
