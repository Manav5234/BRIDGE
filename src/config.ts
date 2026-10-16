import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeSettings {
  readonly serverUrl: string;
  readonly allowRemoteServer: boolean;
  readonly username: string;
  readonly password: string;
  readonly directory: string;
  readonly requestTimeoutMs: number;
}

export const DEFAULT_SETTINGS: BridgeSettings = {
  serverUrl: "",
  allowRemoteServer: false,
  username: "opencode",
  password: "",
  directory: "",
  requestTimeoutMs: 15_000,
};

/** Runtime state that OpenCode writes while its background service is running. */
export interface ServiceState {
  readonly url: string;
  readonly password?: string;
  readonly pid?: number;
  readonly version?: string;
  readonly source: string;
}

export type EndpointResolution =
  | {
      readonly ok: true;
      readonly baseUrl: string;
      readonly username: string;
      readonly password?: string;
      /** Where the connection details came from, shown in diagnostics. */
      readonly source: "setting" | "service-state";
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly guidance: string;
    };

/**
 * Files OpenCode may write its background-service details to, most specific first.
 * `~/.local/state/opencode/service.json` is what `opencode` writes today; it holds
 * the live port and the generated HTTP Basic password.
 */
export function serviceStatePaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  const paths: (string | undefined)[] = [
    env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "opencode", "service.json") : undefined,
    join(home, ".local", "state", "opencode", "service.json"),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "opencode", "service.json") : undefined,
    env.APPDATA ? join(env.APPDATA, "opencode", "service.json") : undefined,
  ];
  return paths.filter((p): p is string => typeof p === "string");
}

/** Parse a service state file. Returns undefined when the file is not usable. */
export function parseServiceState(raw: string, source = ""): ServiceState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url === "") return undefined;
  return {
    url: record.url,
    password: typeof record.password === "string" ? record.password : undefined,
    pid: typeof record.pid === "number" ? record.pid : undefined,
    version: typeof record.version === "string" ? record.version : undefined,
    source,
  };
}

/** Read the first usable service state file, if any. Never throws. */
export function discoverServiceState(paths: string[] = serviceStatePaths()): ServiceState | undefined {
  for (const path of paths) {
    try {
      const state = parseServiceState(readFileSync(path, "utf8"), path);
      if (state) return state;
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }
  return undefined;
}

/**
 * The OpenCode config directory stores only the configured password, not the port.
 * It is the fallback when a user runs their own server with a fixed URL.
 */
export function discoverConfiguredPassword(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | undefined {
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  try {
    const raw = readFileSync(join(configHome, "opencode", "service.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.password === "string" && parsed.password !== "" ? parsed.password : undefined;
  } catch {
    return undefined;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when the URL targets the local machine over http/https. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Strip trailing slashes so the SDK can append `/api/...` predictably. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

const SETUP_GUIDANCE = [
  "Bridge could not find a running OpenCode server.",
  "",
  "Start OpenCode (the background service is shared with the TUI):",
  "  1. Run `opencode` once in a terminal, or",
  "  2. Run `opencode service start`.",
  "",
  "Then run `Bridge: Connect to OpenCode` again.",
  "",
  "If you run your own server on a fixed URL, set `bridge.serverUrl` in Settings",
  "(include the password in `bridge.password` when the server requires one).",
].join("\n");

/**
 * Decide which server to talk to and how to authenticate.
 * Precedence: explicit setting, then the running background service.
 *
 * All discovery results are passed in so this stays a pure decision function.
 */
export function resolveEndpoint(
  settings: BridgeSettings,
  state: ServiceState | undefined,
  fallbackPassword: string | undefined,
): EndpointResolution {
  const configuredUrl = settings.serverUrl.trim();
  const configuredPassword = settings.password !== "" ? settings.password : undefined;

  if (configuredUrl !== "") {
    const baseUrl = normalizeBaseUrl(configuredUrl);
    if (!isLoopbackUrl(baseUrl) && !settings.allowRemoteServer) {
      return {
        ok: false,
        reason: `Bridge only connects to loopback addresses by default, and ${baseUrl} is not one of them.`,
        guidance:
          "Bridge sends your OpenCode credentials to that host over plain HTTP. If you control that host and accept the risk, enable `bridge.allowRemoteServer`.",
      };
    }
    return {
      ok: true,
      baseUrl,
      username: settings.username,
      password: configuredPassword ?? state?.password ?? fallbackPassword,
      source: "setting",
    };
  }

  if (state) {
    return {
      ok: true,
      baseUrl: normalizeBaseUrl(state.url),
      username: settings.username,
      password: configuredPassword ?? state.password ?? fallbackPassword,
      source: "service-state",
    };
  }

  return {
    ok: false,
    reason: "No OpenCode server found on this machine.",
    guidance: SETUP_GUIDANCE,
  };
}

/** HTTP Basic header value. Kept in the extension host and never sent to the webview. */
export function basicAuthHeader(username: string, password: string | undefined): string {
  return "Basic " + Buffer.from(`${username}:${password ?? ""}`).toString("base64");
}

/**
 * Remove anything that looks like a credential before a string reaches the UI or a log.
 * Media paths and secrets both show up in OpenCode errors and URLs.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/gi, "$1 [redacted]");
}
