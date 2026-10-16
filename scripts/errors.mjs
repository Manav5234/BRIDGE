// Probe: what do real failures look like? (bad password, no server, wrong path)
import { OpenCode } from "@opencode/client";

async function attempt(label, options) {
  const client = OpenCode.make(options);
  try {
    const info = await client.server.info({ signal: AbortSignal.timeout(4000) });
    console.log(label, "=> OK", JSON.stringify(info));
  } catch (err) {
    console.log(label, "=> THREW");
    console.log("   ctor:", err?.constructor?.name, "name:", err?.name);
    console.log("   reason:", err?.reason, "detail:", JSON.stringify(err?.detail));
    console.log("   message:", err?.message);
    console.log("   cause:", err?.cause?.constructor?.name, err?.cause?.code, err?.cause?.message);
    console.log("   keys:", Object.keys(err ?? {}));
  }
}

await attempt("no-server (port 1)", { baseUrl: "http://127.0.0.1:1" });
await attempt("bad-password", {
  baseUrl: "http://127.0.0.1:45278",
  headers: { Authorization: "Basic " + Buffer.from("opencode:wrong").toString("base64") },
});
await attempt("good", {
  baseUrl: "http://127.0.0.1:45278",
  headers: {
    Authorization:
      "Basic " +
      Buffer.from(
        "opencode:" +
          JSON.parse(
            (await import("node:fs")).readFileSync(
              (await import("node:path")).join(
                (await import("node:os")).homedir(),
                ".local",
                "state",
                "opencode",
                "service.json",
              ),
              "utf8",
            ),
          ).password,
      ).toString("base64"),
  },
});
