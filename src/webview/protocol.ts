/**
 * Message contract between the extension host and the webview.
 *
 * The webview is untrusted input: everything arriving from it is validated here
 * before it reaches the OpenCode connection. Credentials never travel the other
 * way, so nothing in the outbound payloads needs redacting.
 */

export const MAX_PROMPT_LENGTH = 100_000;
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface UiToolCall {
  readonly name: string;
  readonly status: "running" | "ok" | "failed";
}

export interface UiMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** True while the answer is still streaming in. */
  readonly pending: boolean;
  readonly failed: boolean;
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly tools?: readonly UiToolCall[];
}

export interface UiSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updated: number;
}

export interface UiState {
  readonly connection: {
    readonly status: ConnectionStatus;
    readonly baseUrl?: string;
    readonly version?: string;
    readonly source?: string;
    /** Short human-readable status or failure reason. */
    readonly message?: string;
    /** Multi-line setup instructions shown when nothing is connected. */
    readonly guidance?: string;
  };
  readonly workspace: {
    readonly directory?: string;
    readonly projectID?: string;
  };
  readonly sessions: readonly UiSessionSummary[];
  readonly activeSessionID?: string;
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly messages: readonly UiMessage[];
  readonly busy: boolean;
  readonly status: string;
  /** Present when the user must act before chatting: shows the setup panel. */
  readonly setup?: { readonly message: string; readonly guidance?: string };
  /** Transient operation failure, shown with a retry action where retryable. */
  readonly error?: { readonly message: string; readonly retryable: boolean };
}

/** Extension host -> webview. */
export type OutboundMessage =
  | { readonly type: "state"; readonly state: UiState }
  | { readonly type: "delta"; readonly messageID: string; readonly text: string };

/** Webview -> extension host, before validation. */
export type InboundMessage =
  | { readonly type: "ready" }
  | { readonly type: "connect" }
  | { readonly type: "disconnect" }
  | { readonly type: "newSession" }
  | { readonly type: "refreshSessions" }
  | { readonly type: "selectSession"; readonly sessionID: string }
  | { readonly type: "send"; readonly text: string; readonly requestID: string }
  | { readonly type: "stop" }
  | { readonly type: "retry" }
  | { readonly type: "openSettings" };

export type InboundParseResult =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly error: string };

function fail(error: string): InboundParseResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

const SIMPLE_TYPES = new Set([
  "ready",
  "connect",
  "disconnect",
  "newSession",
  "refreshSessions",
  "stop",
  "retry",
  "openSettings",
]);

/**
 * Validate one message from the webview. Returns a typed message or a reason,
 * never throws, and rejects unknown fields rather than guessing.
 */
export function parseInboundMessage(raw: unknown): InboundParseResult {
  if (!isRecord(raw)) return fail("message must be an object");

  const type = raw.type;
  if (typeof type !== "string") return fail("message.type must be a string");
  if (SIMPLE_TYPES.has(type)) return { ok: true, message: { type } as InboundMessage };

  switch (type) {
    case "selectSession": {
      if (!isShortString(raw.sessionID, 128) || !SESSION_ID_PATTERN.test(raw.sessionID)) {
        return fail("selectSession requires a valid sessionID");
      }
      return { ok: true, message: { type: "selectSession", sessionID: raw.sessionID } };
    }
    case "send": {
      if (typeof raw.text !== "string") return fail("send requires text");
      const text = raw.text;
      if (text.trim() === "") return fail("send requires non-empty text");
      if (text.length > MAX_PROMPT_LENGTH) return fail(`send text exceeds ${MAX_PROMPT_LENGTH} characters`);
      if (!isShortString(raw.requestID, 64)) return fail("send requires a requestID");
      return { ok: true, message: { type: "send", text, requestID: raw.requestID } };
    }
    default:
      return fail(`unknown message type: ${type}`);
  }
}
