import { ClientError, OpenCode, isUnauthorizedError } from "@opencode/client";
import {
  basicAuthHeader,
  discoverConfiguredPassword,
  redactSecrets,
  resolveEndpoint,
  type BridgeSettings,
  type ServiceState,
} from "../config";
import type { ConnectionStatus } from "../webview/protocol";

export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly baseUrl?: string;
  readonly version?: string;
  readonly source?: string;
  readonly message?: string;
  readonly guidance?: string;
}

interface Disposable {
  dispose(): void;
}

const SETUP_GUIDANCE = [
  "Bridge could not find a running OpenCode server.",
  "",
  "Start OpenCode (the background service is shared with the TUI):",
  "  1. Run `opencode` once in a terminal, or",
  "  2. Run `opencode service start`.",
  "",
  "Then connect again.",
].join("\n");

const AUTH_GUIDANCE = [
  "OpenCode rejected the credentials Bridge sent.",
  "",
  "If you started the server yourself, set the same password for Bridge:",
  "  - `bridge.password` in Settings, or",
  "  - add it to your OpenCode `service.json`.",
  "",
  "For the shared background service, Bridge reads the password that",
  "OpenCode writes to its state directory. Run `opencode service restart`",
  "if that file is out of date.",
].join("\n");

/** Walk the error chain to find a low-level socket error code such as ECONNREFUSED. */
function socketCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]{3,}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function describeConnectionError(error: unknown, secrets: readonly (string | undefined)[] = []): {
  reason: string;
  guidance?: string;
} {
  if (isUnauthorizedError(error)) {
    return { reason: "The OpenCode server rejected Bridge's credentials.", guidance: AUTH_GUIDANCE };
  }

  if (error instanceof ClientError) {
    if (error.reason === "Transport") {
      const code = socketCode(error.cause) ?? socketCode(error);
      const detail =
        code === "ECONNREFUSED"
          ? "Nothing is listening on that address."
          : code === "ETIMEDOUT"
            ? "The connection timed out."
            : "The server did not respond.";
      return { reason: `Cannot reach the OpenCode server. ${detail}`, guidance: SETUP_GUIDANCE };
    }
    if (error.reason === "SseEventTooLarge") {
      return { reason: "The OpenCode event stream sent an event Bridge could not buffer." };
    }
    return { reason: `OpenCode returned an unexpected response (${error.reason}).`, guidance: SETUP_GUIDANCE };
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return { reason: "Timed out waiting for the OpenCode server.", guidance: SETUP_GUIDANCE };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { reason: redactSecrets(message, secrets) };
}

function isVersionTwo(version: string): boolean {
  return version.split(".")[0] === "2";
}

/**
 * Owns the single OpenCode client instance and the connection state machine.
 * Bridge holds one connection for the whole window; sessions are selected on top of it.
 */
export class ConnectionManager {
  private clientInstance: OpenCodeClient | undefined;
  private state: ConnectionSnapshot = { status: "disconnected" };
  private readonly listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private secrets: (string | undefined)[] = [];
  /** Guards against overlapping connect attempts from repeated command invocations. */
  private connecting: Promise<ConnectionSnapshot> | undefined;

  constructor(
    private readonly getSettings: () => BridgeSettings,
    private readonly discoverState: () => ServiceState | undefined,
  ) {}

  onDidChange(listener: (snapshot: ConnectionSnapshot) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  snapshot(): ConnectionSnapshot {
    return this.state;
  }

  /** The live client. Throws when called while disconnected. */
  client(): OpenCodeClient {
    if (!this.clientInstance) throw new Error("Bridge is not connected to OpenCode.");
    return this.clientInstance;
  }

  /** Secrets currently in play, so callers can redact them from anything user-visible. */
  redactableSecrets(): readonly (string | undefined)[] {
    return this.secrets;
  }

  noteTransportFailure(error: unknown): string {
    if (this.state.status !== "connected") return describeConnectionError(error).reason;
    const described = describeConnectionError(error, this.secrets);
    const lost = this.state.status === "connected" && this.isTransportError(error);
    if (lost) {
      this.update({
        ...this.state,
        status: "error",
        message: `Lost the connection to OpenCode. ${described.reason}`,
        guidance: SETUP_GUIDANCE,
      });
    }
    return described.reason;
  }

  private isTransportError(error: unknown): boolean {
    if (isUnauthorizedError(error)) return false;
    return error instanceof ClientError && error.reason === "Transport";
  }

  async connect(): Promise<ConnectionSnapshot> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async doConnect(): Promise<ConnectionSnapshot> {
    this.disconnect();
    this.update({ status: "connecting", message: "Looking for a local OpenCode server..." });

    const settings = this.getSettings();
    const resolution = resolveEndpoint(settings, this.discoverState(), discoverConfiguredPassword());

    if (!resolution.ok) {
      this.update({ status: "disconnected", message: resolution.reason, guidance: resolution.guidance });
      return this.state;
    }

    this.secrets = [resolution.password];
    const headers = { Authorization: basicAuthHeader(resolution.username, resolution.password) };
    const client = OpenCode.make({ baseUrl: resolution.baseUrl, headers });

    try {
      const info = await client.server.info({ signal: AbortSignal.timeout(settings.requestTimeoutMs) });
      this.clientInstance = client;
      const compatible = isVersionTwo(info.version);
      this.update({
        status: "connected",
        baseUrl: resolution.baseUrl,
        version: info.version,
        source: resolution.source,
        message: compatible
          ? undefined
          : `Connected to OpenCode ${info.version}. Bridge targets OpenCode 2.x; some features may not work.`,
      });
    } catch (error) {
      const described = describeConnectionError(error, this.secrets);
      let guidance = described.guidance;
      if (described.guidance === SETUP_GUIDANCE && settings.serverUrl.trim() !== "") {
        guidance = `Bridge tried \`bridge.serverUrl\` = ${settings.serverUrl.trim()}.\n\n${SETUP_GUIDANCE}`;
      }
      this.update({ status: "error", message: described.reason, guidance });
    }

    return this.state;
  }

  disconnect(): void {
    this.clientInstance = undefined;
  }

  /** Reset to a clean disconnected state, for the Disconnect command. */
  reset(): void {
    this.disconnect();
    this.secrets = [];
    this.update({ status: "disconnected" });
  }

  private update(next: ConnectionSnapshot): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
