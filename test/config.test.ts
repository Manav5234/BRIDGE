import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  basicAuthHeader,
  discoverConfiguredPassword,
  discoverServiceState,
  isLoopbackUrl,
  normalizeBaseUrl,
  parseServiceState,
  redactSecrets,
  resolveEndpoint,
  serviceStatePaths,
  type BridgeSettings,
} from "../src/config";

const settings = (overrides: Partial<BridgeSettings> = {}): BridgeSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bridge-test-"));
}

describe("service state discovery", () => {
  it("parses a real OpenCode service state file", () => {
    const state = parseServiceState(
      JSON.stringify({ id: "x", version: "2.0.30", url: "http://127.0.0.1:45278", pid: 22, password: "pw" }),
      "src",
    );
    expect(state).toEqual({
      url: "http://127.0.0.1:45278",
      password: "pw",
      pid: 22,
      version: "2.0.30",
      source: "src",
    });
  });

  it("rejects unusable state files", () => {
    expect(parseServiceState("not json")).toBeUndefined();
    expect(parseServiceState("null")).toBeUndefined();
    expect(parseServiceState("[]")).toBeUndefined();
    expect(parseServiceState("{}")).toBeUndefined();
    expect(parseServiceState('{"url":""}')).toBeUndefined();
    expect(parseServiceState('{"url":42}')).toBeUndefined();
  });

  it("lists state paths in precedence order", () => {
    const paths = serviceStatePaths(
      { XDG_STATE_HOME: "/xdg", LOCALAPPDATA: "/la", APPDATA: "/ap" },
      "/home/user",
    );
    expect(paths[0]).toBe(join("/xdg", "opencode", "service.json"));
    expect(paths[1]).toBe(join("/home/user", ".local", "state", "opencode", "service.json"));
    expect(paths).toContain(join("/la", "opencode", "service.json"));
  });

  it("skips missing and corrupt files to find a usable one", () => {
    const dir = tempDir();
    const corrupt = join(dir, "corrupt.json");
    const good = join(dir, "good.json");
    writeFileSync(corrupt, "{ oops");
    writeFileSync(good, JSON.stringify({ url: "http://127.0.0.1:1234", password: "p" }));

    const state = discoverServiceState([join(dir, "missing.json"), corrupt, good]);
    expect(state?.url).toBe("http://127.0.0.1:1234");
    expect(state?.source).toBe(good);
  });

  it("returns undefined when OpenCode was never started here", () => {
    const dir = tempDir();
    expect(discoverServiceState([join(dir, "nope.json")])).toBeUndefined();
  });

  it("reads the configured password fallback", () => {
    const home = tempDir();
    mkdirSync(join(home, "opencode"), { recursive: true });
    writeFileSync(join(home, "opencode", "service.json"), JSON.stringify({ password: "configured" }));
    expect(discoverConfiguredPassword({ XDG_CONFIG_HOME: home }, "/nonexistent")).toBe("configured");
  });

  it("reads the configured password from the default config home", () => {
    const home = tempDir();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "service.json"), JSON.stringify({ password: "cfg" }));
    expect(discoverConfiguredPassword({}, home)).toBe("cfg");
  });

  it("returns undefined when no configured password exists", () => {
    expect(discoverConfiguredPassword({}, tempDir())).toBeUndefined();
  });
});

describe("loopback guard", () => {
  it("accepts loopback addresses", () => {
    expect(isLoopbackUrl("http://127.0.0.1:4096")).toBe(true);
    expect(isLoopbackUrl("http://localhost:4096")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:4096")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1")).toBe(true);
  });

  it("rejects anything else, including lookalike hostnames", () => {
    expect(isLoopbackUrl("http://192.168.1.10:4096")).toBe(false);
    expect(isLoopbackUrl("http://example.com")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.com")).toBe(false);
    expect(isLoopbackUrl("file:///tmp/socket")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and whitespace", () => {
    expect(normalizeBaseUrl("  http://127.0.0.1:4096/  ")).toBe("http://127.0.0.1:4096");
    expect(normalizeBaseUrl("http://127.0.0.1:4096///")).toBe("http://127.0.0.1:4096");
  });
});

describe("endpoint resolution", () => {
  it("prefers an explicit server URL setting", () => {
    const result = resolveEndpoint(
      settings({ serverUrl: "http://127.0.0.1:4096", password: "from-setting" }),
      { url: "http://127.0.0.1:45278", password: "from-state", source: "s" },
      "from-config",
    );
    expect(result).toEqual({
      ok: true,
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "from-setting",
      source: "setting",
    });
  });

  it("falls back to the running background service", () => {
    const result = resolveEndpoint(
      settings(),
      {
        url: "http://127.0.0.1:45278/",
        password: "from-state",
        source: "s",
      },
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      baseUrl: "http://127.0.0.1:45278",
      username: "opencode",
      password: "from-state",
      source: "service-state",
    });
  });

  it("refuses a remote host unless the user opts in", () => {
    const blocked = resolveEndpoint(settings({ serverUrl: "http://10.0.0.5:4096" }), undefined, undefined);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.guidance).toContain("allowRemoteServer");

    const allowed = resolveEndpoint(
      settings({ serverUrl: "http://10.0.0.5:4096", allowRemoteServer: true }),
      undefined,
      undefined,
    );
    expect(allowed.ok).toBe(true);
  });

  it("explains how to start OpenCode when nothing is available", () => {
    const result = resolveEndpoint(settings(), undefined, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No OpenCode server found");
      expect(result.guidance).toContain("opencode service start");
    }
  });

  it("uses the configured password when the state file has none", () => {
    const result = resolveEndpoint(settings(), { url: "http://127.0.0.1:1", source: "s" }, "config-pw");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.password).toBe("config-pw");
  });

  it("allows a server with no password configured", () => {
    const result = resolveEndpoint(settings(), { url: "http://127.0.0.1:1", source: "s" }, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.password).toBeUndefined();
  });
});

describe("credential handling", () => {
  it("builds an HTTP Basic header the way the server expects", () => {
    expect(basicAuthHeader("opencode", "secret")).toBe(
      "Basic " + Buffer.from("opencode:secret").toString("base64"),
    );
    expect(basicAuthHeader("opencode", undefined)).toBe(
      "Basic " + Buffer.from("opencode:").toString("base64"),
    );
  });

  it("redacts known secrets and auth headers from text", () => {
    const text = "failed for password supersecretvalue and header Authorization: Basic YWJjZGVmZ2g=";
    const redacted = redactSecrets(text, ["supersecretvalue"]);
    expect(redacted).not.toContain("supersecretvalue");
    expect(redacted).not.toContain("YWJjZGVmZ2g=");
    expect(redacted).toContain("[redacted]");
  });

  it("does not mangle text when there are no secrets", () => {
    expect(redactSecrets("plain message", [undefined])).toBe("plain message");
  });

  it("leaves short values alone so ordinary words are not eaten", () => {
    expect(redactSecrets("the app is running", ["app"])).toBe("the app is running");
  });
});
