/** Public tool filtering shared by the private parent and disposable MCP child. */
import { listDatabentoTools } from "./index.js";
import { bbaTool } from "./bba-contract.js";
import path from "node:path";

export function sanitizedWorkerEnvironment(directory: string): NodeJS.ProcessEnv {
  return {HOME: directory, XDG_CACHE_HOME: path.join(directory, "cache"), TMPDIR: directory,
    NODE_ENV: "production", TZ: "UTC", LANG: "C.UTF-8"};
}

export const PLATFORM_DISABLED_TOOLS = [
  "batch_submit_job", "batch_list_jobs", "batch_download",
  "reference_search_securities", "reference_get_corporate_actions", "reference_get_adjustments",
] as const;

export const PLATFORM_MCP_OPTIONS = {disabledTools: PLATFORM_DISABLED_TOOLS, profile: "platform"} as const;

export function listPlatformTools() {
  return [...listDatabentoTools(PLATFORM_MCP_OPTIONS), bbaTool];
}

import type {PlatformCostControl} from "../src/api/platform-cost.js";
import type {PlatformSubscription} from "../src/api/platform-subscription.js";
export {validatePlatformSubscription,type PlatformSubscription} from "../src/api/platform-subscription.js";
export {COST_BASIS,validateCostControl,validateCostSummary,emptyCostSummary,type PlatformCostControl,type PlatformCostSummary} from "../src/api/platform-cost.js";

export interface PlatformCall {
  name: string;
  arguments: Record<string, unknown>;
  api_key?: string;
  credential_revision?: string;
  cost_control?: PlatformCostControl;
  subscription?: PlatformSubscription;
}
