#!/usr/bin/env node
import { startDatabentoMcpServer } from "./index.js";

startDatabentoMcpServer().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
