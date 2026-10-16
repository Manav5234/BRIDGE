// Does session.tool.called actually carry the tool name at runtime?
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";

const WORKSPACE = process.cwd();
const state = JSON.parse(readFileSync(join(homedir(), ".local", "state", "opencode", "service.json"), "utf8"));
const auth = "Basic " + Buffer.from(`opencode:${state.password}`).toString("base64");
const client = OpenCode.make({ baseUrl: state.url, headers: { Authorization: auth } });

const session = await client.session.create({ location: { directory: WORKSPACE } });
const ac = new AbortController();

const pump = (async () => {
  for await (const event of client.event.subscribe({ signal: ac.signal })) {
    if (event.data?.sessionID !== session.id) continue;
    if (event.type.startsWith("session.tool.")) {
      console.log(event.type, "DATA KEYS:", JSON.stringify(Object.keys(event.data)));
      console.log(event.type, "DATA:", JSON.stringify(event.data).slice(0, 400));
    }
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") break;
  }
})().catch(() => {});

await client.session.prompt({
  sessionID: session.id,
  text: "Use the bash tool to run `echo bridge-tool-probe`. Then reply 'done'.",
});

await Promise.race([pump, new Promise((r) => setTimeout(r, 120_000))]);
ac.abort();
await client.session.remove({ sessionID: session.id });
process.exit(0);
