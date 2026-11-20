import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bbaActions, BBA_IDLE_MS, BBA_LIFETIME_MS } from "./bba-contract.js";
import type { BbaCommand, BbaWorkerReply } from "./bba-worker.js";
import { LIVE_COST_STATUS } from "../src/api/platform-live.js";
import type { PlatformCall } from "./platform-contract.js";
import type { PlatformClaims, PlatformReply } from "./platform.js";
import { sanitizedWorkerEnvironment } from "./platform-contract.js";

export interface BbaPeer {
  request(command: BbaCommand): Promise<BbaWorkerReply>;
  close(): void;
}

function createPeer(): BbaPeer {
  const directory = mkdtempSync(path.join(tmpdir(), "databento-bba-"));
  const source = path.extname(__filename) === ".ts";
  const args = source ? ["--import", require.resolve("tsx")] : [];
  let child;
  try {
    child = fork(path.join(__dirname, source ? "bba-worker.ts" : "bba-worker.js"), [], {
      cwd: directory, env: sanitizedWorkerEnvironment(directory), stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [...args, "--max-old-space-size=96"]});
  } catch (error) { rmSync(directory, {recursive: true, force: true}); throw error; }
  const processHandle = child;
  let pending: {resolve: (reply: BbaWorkerReply) => void; reject: (error: Error) => void} | undefined;
  const failed = () => { pending?.reject(new Error("Stream worker unavailable")); pending = undefined; };
  processHandle.on("error", failed);
  processHandle.once("close", () => { failed(); rmSync(directory, {recursive: true, force: true}); });
  processHandle.on("message", (reply: BbaWorkerReply | {error: string}) => {
    if ("error" in reply) failed();
    else { pending?.resolve(reply); pending = undefined; }
  });
  return {
    request(command) {
      if (pending || !processHandle.connected) return Promise.reject(new Error("Stream unavailable"));
      return new Promise((resolve, reject) => {
        pending = {resolve, reject};
        processHandle.send(command, error => { if (error) failed(); });
      });
    },
    close() { failed(); processHandle.kill("SIGKILL"); },
  };
}

interface Session {owner: string; credential: string; peer: BbaPeer; expires: number; timer: NodeJS.Timeout; busy: boolean}
export class BbaSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly spawnPeer: () => BbaPeer = createPeer) {}

  private remove(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.timer);
    session.peer.close();
  }

  async call(input: PlatformCall, claims: PlatformClaims, signal: AbortSignal): Promise<PlatformReply> {
    const command = bbaActions.parse(input.arguments);
    const owner = JSON.stringify([claims.workspace, claims.sub]);
    const credential = createHash("sha256").update(input.api_key!).update(":").update(input.credential_revision!).digest("hex");
    const id = command.action === "start" ? randomBytes(16).toString("hex") : command.stream_id;
    const reply = (data: object, originals: PlatformReply["originals"] = []): PlatformReply => ({
      result: {content: [{type: "text", text: JSON.stringify({stream_id: id, ...data})}]},
      originals, live_cost_status: LIVE_COST_STATUS});
    if (command.action === "start") {
      if (this.sessions.size >= 12 || [...this.sessions.values()].filter(s => s.owner === owner).length >= 2)
        return reply({status: "stream_limit"});
      const peer = this.spawnPeer();
      const timer = setTimeout(() => this.remove(id), BBA_IDLE_MS);
      this.sessions.set(id, {owner, credential, peer, timer, expires: Date.now() + BBA_LIFETIME_MS, busy: false});
    }
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return reply({status: "unavailable"});
    if (session.credential !== credential) { this.remove(id); return reply({status: "unavailable"}); }
    if (command.action === "stop") { this.remove(id); return reply({status: "stopped"}); }
    if (session.busy) return reply({status: "busy"});
    const remaining = session.expires - Date.now();
    if (remaining <= 0) { this.remove(id); return reply({status: "unavailable"}); }
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.remove(id), Math.min(remaining, BBA_IDLE_MS));
    session.busy = true;
    const abort = () => this.remove(id);
    signal.addEventListener("abort", abort, {once: true});
    try {
      if (signal.aborted) { abort(); throw new Error("Aborted"); }
      const message: BbaCommand = command.action === "start"
        ? {action: "start", subscription: {symbol: command.symbol, stype_in: command.stype_in}, apiKey: input.api_key!}
        : {action: "read", after: command.after, limit: command.limit ?? 32, waitMs: command.wait_ms ?? 1000};
      const result = await session.peer.request(message);
      return reply(result.data, result.originals);
    } catch {
      this.remove(id);
      return reply({status: "unavailable"});
    } finally {
      signal.removeEventListener("abort", abort);
      session.busy = false;
    }
  }

  close() { for (const id of this.sessions.keys()) this.remove(id); }
}
