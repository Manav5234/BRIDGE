// Real integration probe: discovery, health, providers, models.
// Run with: node scripts/probe.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";

function readState() {
  const candidates = [
    process.env.XDG_STATE_HOME && join(process.env.XDG_STATE_HOME, "opencode", "service.json"),
    join(homedir(), ".local", "state", "opencode", "service.json"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "opencode", "service.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (typeof parsed?.url === "string") return { ...parsed, source: p };
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

const state = readState();
console.log("state:", JSON.stringify(state));
if (!state) process.exit(1);

const auth = "Basic " + Buffer.from(`opencode:${state.password}`).toString("base64");
const client = OpenCode.make({ baseUrl: state.url, headers: { Authorization: auth } });

const info = await client.server.info();
console.log("server.info:", JSON.stringify(info));

const location = await client.location.get();
console.log("location.get:", JSON.stringify(location));

const providers = await client.provider.list();
console.log("providers:", providers.data.map((p) => p.id).join(", "));

const models = await client.model.list();
console.log("model count:", models.data.length);
for (const m of models.data) {
  const cost = m.cost?.[0];
  console.log(
    `  ${m.providerID}/${m.modelID} enabled=${m.enabled} status=${m.status} ` +
      `in=$${cost?.input ?? "?"} out=$${cost?.output ?? "?"}`,
  );
}

const def = await client.model.default();
console.log("model.default:", JSON.stringify(def.data));
