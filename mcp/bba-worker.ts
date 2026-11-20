/** Private IPC for a single stream. Disconnecting the parent also releases the provider socket. */
import { BbaFeed, InvalidBbaCursor, type BbaSubscription } from "../src/api/bba-feed.js";

export type BbaCommand = {action: "start"; subscription: BbaSubscription; apiKey: string} |
  {action: "read"; after: number; limit: number; waitMs: number};
export type BbaPage = Awaited<ReturnType<BbaFeed["read"]>>;
export type BbaWorkerReply = BbaPage | {data: {status: "connecting" | "invalid_cursor"}; originals: []};

if (require.main === module) {
  let feed: BbaFeed | undefined;
  process.once("disconnect", () => { feed?.stop(); process.exit(0); });
  process.on("message", async (message: BbaCommand) => {
    try {
      if (message.action === "start" && !feed) {
        feed = new BbaFeed(message.subscription, message.apiKey);
        process.send!({data: {status: "connecting"}, originals: []});
      } else if (message.action === "read" && feed) {
        process.send!(await feed.read(message.after, message.limit, message.waitMs));
      } else throw new Error("Invalid stream command");
    } catch (error) {
      if (error instanceof InvalidBbaCursor) process.send!({data: {status: "invalid_cursor"}, originals: []});
      else process.send!({error: "invalid_stream_request"});
    }
  });
}
