import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { startExpoReceiptWorker } from "./services/expoPush.js";
import { warmContentTopics } from "./services/wordpress.js";

const env = config();
const server = createApp().listen(env.PORT, env.HOST, () => {
  console.log(`IBS Intelligence API listening on ${env.HOST}:${env.PORT}`);
});
const stopReceiptWorker = startExpoReceiptWorker();
// The topic counts are the one slow thing a screen can wait on; counted
// now, behind the listener, so the first reader finds them ready.
void warmContentTopics();

async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down`);
  stopReceiptWorker();
  server.close(async () => {
    await pool().end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
