// Real end-to-end probe: session create -> prompt -> stream live events -> final message.
// Run with: node scripts/e2e.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";

const WORKSPACE = process.cwd();

function readState() {
  const candidates = [
    process.env.XDG_STATE_HOME && join(process.env.XDG_STATE_HOME, "opencode", "service.json"),
    join(homedir(), ".local", "state", "opencode", "service.json"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "opencode", "service.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (typeof parsed?.url === "string") return parsed;
    } catch {
      /* next */
    }
  }
  throw new Error("no OpenCode service state file found");
}

const state = readState();
const auth = "Basic " + Buffer.from(`opencode:${state.password}`).toString("base64");
const client = OpenCode.make({ baseUrl: state.url, headers: { Authorization: auth } });

const scoped = await client.location.get({ location: { directory: WORKSPACE } });
console.log("scoped location:", JSON.stringify(scoped));

console.log("existing sessions:", (await client.session.list({ directory: WORKSPACE })).data.length);

const session = await client.session.create({
  location: { directory: WORKSPACE },
  title: "Bridge spike",
});
console.log("created session:", session.id, "model:", JSON.stringify(session.model));

const ac = new AbortController();
let assistantText = "";
const seen = new Set();

const pump = (async () => {
  for await (const event of client.event.subscribe({ signal: ac.signal })) {
    if (event.type === "server.connected") continue;
    const sid = event.data?.sessionID;
    if (sid !== undefined && sid !== session.id) continue;
    if (!seen.has(event.type)) {
      seen.add(event.type);
      console.log("  event:", event.type);
    }
    if (event.type === "session.text.delta") {
      assistantText += event.data.delta;
      process.stdout.write(event.data.delta);
    } else if (event.type === "session.execution.failed") {
      console.log("\nexecution failed:", JSON.stringify(event.data.error));
    } else if (event.type === "session.idle") {
      break;
    }
  }
})();

const inbox = await client.session.prompt({
  sessionID: session.id,
  text: "Reply with exactly the word: bridge-ok",
});
console.log("prompt accepted, inbox id:", inbox.id, "delivery:", inbox.delivery);

await Promise.race([pump, new Promise((r) => setTimeout(r, 90_000))]);
ac.abort();

console.log("\n--- streamed text ---");
console.log(JSON.stringify(assistantText));

console.log("--- stored messages ---");
const messages = await client.message.list({ sessionID: session.id });
for (const m of messages.data) {
  if (m.type === "user") console.log(`  user: ${JSON.stringify(m.text)}`);
  else if (m.type === "assistant") {
    const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    console.log(`  assistant model=${JSON.stringify(m.model)} finish=${m.finish}: ${JSON.stringify(text)}`);
  } else if (m.type === "idle") console.log(`  idle: outcome=${m.outcome}`);
}

await client.session.remove({ sessionID: session.id });
console.log("session removed");
