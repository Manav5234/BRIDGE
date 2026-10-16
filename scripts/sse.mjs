// Focused probe: SSE lifecycle. Does the stream end? Does session.idle arrive?
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";

const WORKSPACE = process.cwd();
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

const state = JSON.parse(readFileSync(join(homedir(), ".local", "state", "opencode", "service.json"), "utf8"));
const auth = "Basic " + Buffer.from(`opencode:${state.password}`).toString("base64");
const client = OpenCode.make({ baseUrl: state.url, headers: { Authorization: auth } });

const session = await client.session.create({ location: { directory: WORKSPACE }, title: "SSE probe" });
log("session:", session.id);

const ac = new AbortController();
const pump = (async () => {
  try {
    for await (const event of client.event.subscribe({ signal: ac.signal })) {
      const sid = event.data?.sessionID;
      if (sid !== undefined && sid !== session.id) continue;
      log("event:", event.type, event.type === "session.text.delta" ? JSON.stringify(event.data.delta) : "");
      if (event.type === "session.idle") break;
    }
    log("stream for-await COMPLETED normally");
  } catch (err) {
    log("stream threw:", err?.name, err?.message);
  }
})();

await client.session.prompt({ sessionID: session.id, text: "Count from 1 to 5, one number per line." });
log("prompt sent");

const timer = setTimeout(() => {
  log("30s elapsed -> aborting");
  ac.abort();
}, 30_000);
await pump;
clearTimeout(timer);
log("pump settled");

const messages = await client.message.list({ sessionID: session.id });
for (const m of messages.data) {
  if (m.type === "assistant") {
    log("final assistant model:", JSON.stringify(m.model), "finish:", m.finish);
  }
}

await client.session.remove({ sessionID: session.id });
log("done");
process.exit(0);
