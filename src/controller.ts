import { redactSecrets, type BridgeSettings } from "./config";
import { describeConnectionError, type ConnectionManager } from "./opencode/connection";
import { SessionGateway } from "./opencode/sessions";
import type { BridgeStreamEvent, EventStream } from "./opencode/stream";
import type { UiMessage, UiSessionSummary, UiState, UiToolCall } from "./webview/protocol";

interface Disposable {
  dispose(): void;
}

const NO_WORKSPACE_GUIDANCE = [
  "Bridge scopes OpenCode sessions to a folder so the agent works in the right project.",
  "",
  "Open a folder in VS Code, or set `bridge.directory` in Settings.",
].join("\n");

export interface ControllerOptions {
  readonly connection: ConnectionManager;
  readonly stream: EventStream;
  readonly settings: () => BridgeSettings;
  /** Directory OpenCode sessions should be scoped to. */
  readonly directory: () => string | undefined;
  readonly log?: (message: string) => void;
}

/**
 * Owns the chat state shown in the webview.
 *
 * Streaming output is applied optimistically for responsiveness, but the stored
 * OpenCode messages are the source of truth: every turn ends by reloading history
 * so the transcript can never drift from what the agent actually produced.
 */
export class BridgeController {
  private readonly stateListeners = new Set<(state: UiState) => void>();
  private readonly deltaListeners = new Set<(messageID: string, text: string) => void>();

  private gateway: SessionGateway | undefined;
  private workspace = {};
  private workspaceMissing = false;
  private sessions: UiSessionSummary[] = [];
  private activeSessionID: string | undefined;
  private model: UiState["model"];
  private messages: UiMessage[] = [];
  private busy = false;
  private status = "Not connected";
  private error: UiState["error"];
  private lastFailedText: string | undefined;
  private localCounter = 0;
  private readonly disposables: Disposable[] = [];

  constructor(private readonly options: ControllerOptions) {
    this.status = "Not connected";
  }

  start(): void {
    this.disposables.push(
      this.options.connection.onDidChange(() => this.emitState()),
      this.options.stream.onEvent((event) => void this.onStreamEvent(event)),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.stateListeners.clear();
    this.deltaListeners.clear();
  }

  onDidChange(listener: (state: UiState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  onDidDelta(listener: (messageID: string, text: string) => void): Disposable {
    this.deltaListeners.add(listener);
    return { dispose: () => this.deltaListeners.delete(listener) };
  }

  snapshot(): UiState {
    const connection = this.options.connection.snapshot();
    const connected = connection.status === "connected";
    // One place decides whether the user can chat, so the webview stays dumb.
    const setup = !connected
      ? {
          message: connection.message ?? "Not connected to OpenCode.",
          guidance: connection.guidance,
        }
      : this.workspaceMissing
        ? { message: "No workspace folder is open.", guidance: NO_WORKSPACE_GUIDANCE }
        : undefined;

    return {
      connection: {
        status: connection.status,
        baseUrl: connection.baseUrl,
        version: connection.version,
        source: connection.source,
        message: connection.message,
        guidance: connection.guidance,
      },
      workspace: this.workspace,
      sessions: this.sessions,
      activeSessionID: this.activeSessionID,
      model: this.model,
      messages: this.messages,
      busy: this.busy,
      status: this.status,
      setup,
      error: this.error,
    };
  }

  private emitState(): void {
    const state = this.snapshot();
    for (const listener of this.stateListeners) listener(state);
  }

  private emitDelta(messageID: string, text: string): void {
    for (const listener of this.deltaListeners) listener(messageID, text);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * Turn any thrown value into a message safe to display.
   * Credentials are stripped because OpenCode errors can echo request URLs.
   */
  private reason(error: unknown): string {
    return redactSecrets(
      describeConnectionError(error, this.options.connection.redactableSecrets()).reason,
      this.options.connection.redactableSecrets(),
    );
  }

  private fail(error: unknown, retryable = false): void {
    this.error = { message: this.reason(error), retryable };
    this.log(`operation failed: ${this.error.message}`);
  }

  // ---------------------------------------------------------------- connection

  async connect(): Promise<void> {
    this.error = undefined;
    await this.options.connection.connect();
    const connection = this.options.connection.snapshot();

    if (connection.status !== "connected") {
      this.gateway = undefined;
      this.activeSessionID = undefined;
      this.messages = [];
      this.status = "Not connected";
      this.emitState();
      return;
    }

    const directory = this.options.directory();
    if (!directory) {
      this.gateway = undefined;
      this.workspaceMissing = true;
      this.status = "No workspace folder";
      this.emitState();
      return;
    }
    this.workspaceMissing = false;

    try {
      const client = this.options.connection.client();
      this.gateway = new SessionGateway(client);
      const workspace = await this.gateway.describeWorkspace(directory, this.timeoutSignal());
      this.workspace = { directory: workspace.directory, projectID: workspace.projectID };
      this.sessions = await this.gateway.listSessions(directory, this.timeoutSignal());
      const defaultModel = await this.gateway.defaultModel(directory, this.timeoutSignal());
      this.model = defaultModel
        ? { providerID: defaultModel.providerID, id: defaultModel.modelID }
        : undefined;
      this.status = this.sessions.length > 0 ? "Connected" : "Connected. No sessions yet.";
      this.messages = [];
      this.activeSessionID = undefined;
      this.options.stream.start(client);
    } catch (error) {
      this.gateway = undefined;
      this.fail(error);
      this.status = "Connected, but could not read the workspace";
    }

    this.emitState();
  }

  disconnect(): void {
    this.options.stream.stop();
    this.options.connection.reset();
    this.gateway = undefined;
    this.sessions = [];
    this.activeSessionID = undefined;
    this.model = undefined;
    this.messages = [];
    this.busy = false;
    this.error = undefined;
    this.lastFailedText = undefined;
    this.status = "Not connected";
    this.workspace = {};
    this.workspaceMissing = false;
    this.emitState();
  }

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.options.settings().requestTimeoutMs);
  }

  private requireGateway(): SessionGateway | undefined {
    if (!this.gateway) {
      this.error = { message: "Bridge is not connected to OpenCode.", retryable: true };
      this.emitState();
      return undefined;
    }
    return this.gateway;
  }

  // ----------------------------------------------------------------- sessions

  async refreshSessions(): Promise<void> {
    const gateway = this.requireGateway();
    const directory = this.options.directory();
    if (!gateway || !directory) return;
    try {
      this.sessions = await gateway.listSessions(directory, this.timeoutSignal());
      this.emitState();
    } catch (error) {
      this.fail(error);
      this.emitState();
    }
  }

  async newSession(): Promise<void> {
    const gateway = this.requireGateway();
    const directory = this.options.directory();
    if (!gateway || !directory) return;
    try {
      const summary = await gateway.createSession(directory, this.timeoutSignal());
      this.sessions = [summary, ...this.sessions];
      this.activeSessionID = summary.id;
      this.messages = [];
      this.error = undefined;
      this.status = "New session";
    } catch (error) {
      this.fail(error, true);
    }
    this.emitState();
  }

  async selectSession(sessionID: string): Promise<void> {
    const gateway = this.requireGateway();
    if (!gateway) return;
    this.activeSessionID = sessionID;
    this.error = undefined;
    this.busy = false;
    this.status = "Loading session...";
    this.emitState();
    await this.resync();
  }

  /** Reuse the active session, creating one only when the user has none. */
  private async ensureSession(gateway: SessionGateway, directory: string): Promise<string> {
    if (this.activeSessionID) {
      this.log(`session: reusing ${this.activeSessionID}`);
      return this.activeSessionID;
    }
    this.log("session: creating a new OpenCode session");
    const summary = await gateway.createSession(directory, this.timeoutSignal());
    this.log(`session: created ${summary.id}`);
    this.sessions = [summary, ...this.sessions];
    this.activeSessionID = summary.id;
    return summary.id;
  }

  // -------------------------------------------------------------------- turns

  async send(text: string): Promise<void> {
    this.log(`send: requested (${text.length} chars)`);
    // Guards the server-side gap: OpenCode accepts a second prompt while busy
    // (delivery "steer"), so Bridge must refuse duplicates itself.
    if (this.busy) {
      this.log("send: refused, a response is still streaming");
      this.status = "A response is still streaming. Stop it first.";
      this.emitState();
      return;
    }

    const gateway = this.requireGateway();
    const directory = this.options.directory();
    if (!gateway || !directory) {
      this.log("send: refused, no connected gateway or workspace");
      return;
    }

    this.busy = true;
    this.error = undefined;
    this.status = "Sending";
    this.localCounter += 1;
    const localID = `local-${this.localCounter}`;
    this.messages = [...this.messages, { id: localID, role: "user", text, pending: true, failed: false }];
    this.emitState();

    try {
      const sessionID = await this.ensureSession(gateway, directory);
      this.log(`send: session=${sessionID}`);
      this.log(`send: prompt -> sdk (${text.length} chars)`);
      const inbox = await gateway.sendPrompt(sessionID, text, directory, this.timeoutSignal());
      this.log(`send: sdk accepted prompt as ${inbox.id} (delivery=${inbox.delivery})`);
      this.messages = this.messages.map((message) =>
        message.id === localID ? { ...message, id: inbox.id, pending: false } : message,
      );
    } catch (error) {
      this.log(`send: sdk error: ${this.reason(error)}`);
      this.messages = this.messages.map((message) =>
        message.id === localID ? { ...message, pending: false, failed: true } : message,
      );
      this.lastFailedText = text;
      this.busy = false;
      this.status = "Could not send";
      this.fail(error, true);
    }

    this.emitState();
  }

  /** Re-send the last failed message. */
  async retry(): Promise<void> {
    const text = this.lastFailedText;
    if (text === undefined) return;
    this.messages = this.messages.filter((message) => !(message.role === "user" && message.failed));
    this.lastFailedText = undefined;
    this.error = undefined;
    await this.send(text);
  }

  async stop(): Promise<void> {
    const gateway = this.requireGateway();
    if (!gateway || !this.activeSessionID) return;
    try {
      const result = await gateway.interrupt(this.activeSessionID, this.timeoutSignal());
      this.status = result.interrupted ? "Stopping..." : "Nothing was running.";
      if (!result.interrupted) this.busy = false;
    } catch (error) {
      this.fail(error);
    }
    this.emitState();
  }

  /** Reload the transcript from OpenCode, the authoritative record. */
  private async resync(): Promise<{
    outcome?: "succeeded" | "failed" | "interrupted";
    error?: string;
  }> {
    const gateway = this.gateway;
    const sessionID = this.activeSessionID;
    if (!gateway || !sessionID) return {};
    this.log(`resync: start session=${sessionID}`);
    try {
      const history = await gateway.loadHistory(sessionID, this.timeoutSignal());
      this.messages = history.messages;
      this.log(
        `resync: loaded ${history.messages.length} messages, stored outcome=${history.outcome ?? "none"}`,
      );
      const lastAssistant = [...this.messages].reverse().find((message) => message.role === "assistant");
      if (lastAssistant?.model) this.model = lastAssistant.model;
      this.emitState();
      return { outcome: history.outcome, error: history.error };
    } catch (error) {
      this.fail(error);
      this.emitState();
      return {};
    }
  }

  // ------------------------------------------------------------------- stream

  private findOrAddAssistant(messageID: string): UiMessage {
    const existing = this.messages.find((message) => message.id === messageID);
    if (existing) return existing;

    const created: UiMessage = {
      id: messageID,
      role: "assistant",
      text: "",
      pending: true,
      failed: false,
      model: this.model,
    };
    this.messages = [...this.messages, created];
    return created;
  }

  private async onStreamEvent(event: BridgeStreamEvent): Promise<void> {
    const sessionID = "sessionID" in event ? event.sessionID : undefined;
    const detail =
      event.kind === "dropped"
        ? ` (${redactSecrets(event.message, this.options.connection.redactableSecrets())})`
        : "";
    this.log(`event: ${event.kind}${sessionID ? ` session=${sessionID}` : ""}${detail}`);
    switch (event.kind) {
      case "connected":
        this.status = "Listening to OpenCode events";
        this.emitState();
        return;

      case "dropped":
        this.status = "Live updates interrupted. Reconnecting...";
        // Do not leave the UI stuck in a busy state that will never complete.
        this.busy = false;
        this.emitState();
        return;

      case "resumed":
        this.status = "Live updates restored";
        await this.resync();
        return;

      case "delta": {
        if (event.sessionID !== this.activeSessionID) return;
        const existing = this.messages.find((message) => message.id === event.messageID);
        if (!existing) {
          // First chunk of a new assistant message: send full state so the
          // webview has the message before incremental deltas arrive.
          const created = this.findOrAddAssistant(event.messageID);
          this.messages = this.messages.map((message) =>
            message.id === created.id ? { ...message, text: message.text + event.text } : message,
          );
          this.status = "Responding";
          this.emitState();
          return;
        }
        this.messages = this.messages.map((message) =>
          message.id === event.messageID ? { ...message, text: message.text + event.text } : message,
        );
        this.emitDelta(event.messageID, event.text);
        return;
      }

      case "model":
        if (event.sessionID !== this.activeSessionID) return;
        this.model = { providerID: event.providerID, id: event.modelID };
        this.emitState();
        return;

      case "activity":
        if (event.sessionID !== this.activeSessionID) return;
        this.status = event.note;
        this.emitState();
        return;

      case "tool": {
        if (event.sessionID !== this.activeSessionID) return;
        const message = this.findOrAddAssistant(event.messageID);
        const tools: UiToolCall[] = [...(message.tools ?? [])];
        const index = tools.findIndex((tool) => tool.name === event.name && tool.status === "running");
        if (index >= 0 && event.status !== "running") tools[index] = { name: event.name, status: event.status };
        else if (index < 0) tools.push({ name: event.name, status: event.status });
        this.messages = this.messages.map((entry) =>
          entry.id === message.id ? { ...entry, tools } : entry,
        );
        this.status = event.status === "running" ? `Running ${event.name}` : this.status;
        this.emitState();
        return;
      }

      case "settled": {
        if (event.sessionID !== this.activeSessionID) return;
        this.busy = false;
        const history = await this.resync();
        // `session.idle` carries no outcome, so prefer the stored one.
        const outcome = event.outcome ?? history.outcome;
        const failure = event.error ?? (outcome === "failed" ? history.error : undefined);
        this.log(
          `turn settled: outcome=${outcome ?? "unknown"} (stream=${event.outcome ?? "none"}, stored=${history.outcome ?? "none"})`,
        );
        this.status =
          outcome === "succeeded"
            ? "Ready"
            : outcome === "interrupted"
              ? "Stopped"
              : outcome === "failed"
                ? "OpenCode reported a failure"
                : "Ready";
        this.error = failure ? { message: failure, retryable: false } : undefined;
        this.emitState();
        // Titles are generated by OpenCode, so pull the list again after a turn.
        await this.refreshSessions();
        return;
      }
    }
  }
}
