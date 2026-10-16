// Focused probe: interrupt (Stop Generation), and behaviour when a session is already busy.
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

const session = await client.session.create({ location: { directory: WORKSPACE }, title: "interrupt probe" });
log("session:", session.id);

const ac = new AbortController();
const terminal = [];
const pump = (async () => {
  for await (const event of client.event.subscribe({ signal: ac.signal })) {
    const sid = event.data?.sessionID;
    if (sid !== undefined && sid !== session.id) continue;
    if (event.type.startsWith("session.execution.") || event.type === "session.idle") {
      log("TERMINAL EVENT:", event.type, JSON.stringify(event.data));
      terminal.push(event.type);
      if (event.type !== "session.execution.started") break;
    }
  }
})().catch((e) => log("stream err", e?.message));

// A prompt that should keep the model busy for a while.
await client.session.prompt({
  sessionID: session.id,
  text: "Write a 40-line numbered list. Every line must be a short sentence about turtles.",
});
log("prompt 1 sent (long)");

await new Promise((r) => setTimeout(r, 1500));

// Duplicate submission while busy.
try {
  const second = await client.session.prompt({ sessionID: session.id, text: "second prompt while busy" });
  log("prompt 2 ACCEPTED while busy, delivery =", second.delivery);
} catch (err) {
  log("prompt 2 REJECTED while busy:", err?.constructor?.name, err?.message);
}

await new Promise((r) => setTimeout(r, 1500));

const res = await client.session.interrupt({ sessionID: session.id });
log("interrupt ->", JSON.stringify(res));

await Promise.race([pump, new Promise((r) => setTimeout(r, 25_000))]);
ac.abort();
log("terminal events:", JSON.stringify(terminal));

const messages = await client.message.list({ sessionID: session.id });
log("message count:", messages.data.length);
for (const m of messages.data) {
  if (m.type === "idle") log("  idle outcome:", m.outcome, m.error ? JSON.stringify(m.error) : "");
  if (m.type === "assistant") log("  assistant finish:", m.finish);
}

await client.session.remove({ sessionID: session.id });
log("done");
process.exit(0);
