/** Public tool filtering shared by the private parent and disposable MCP child. */
import { listDatabentoTools } from "./index.js";

export const PLATFORM_DISABLED_TOOLS = [
  "get_live_futures_quote", "batch_submit_job", "batch_list_jobs", "batch_download",
  "reference_search_securities", "reference_get_corporate_actions", "reference_get_adjustments",
] as const;

export function listPlatformTools() {
  return listDatabentoTools({disabledTools: PLATFORM_DISABLED_TOOLS});
}

export interface PlatformCall {
  name: string;
  arguments: Record<string, unknown>;
  api_key?: string;
}
