#!/usr/bin/env node
import { DataBentoClient } from "../../../src/databento-client.js";
import * as dotenv from "dotenv";

dotenv.config();

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const timestampArg = args[0];

  const timestamp = timestampArg ? new Date(timestampArg) : undefined;

  try {
    const client = new DataBentoClient(DATABENTO_API_KEY!);
    const sessionInfo = client.getSessionInfo(timestamp);

    const result = {
      currentSession: sessionInfo.currentSession,
      sessionStart: sessionInfo.sessionStart.toISOString(),
      sessionEnd: sessionInfo.sessionEnd.toISOString(),
      timestamp: sessionInfo.timestamp.toISOString(),
      utcHour: sessionInfo.timestamp.getUTCHours(),
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
