import type { OpenCodeClient } from "./connection";
import type { OpenCodeEvent } from "@opencode/client";

/** Normalised events the rest of Bridge reacts to. */
export type BridgeStreamEvent =
  | { readonly kind: "connected" }
  | { readonly kind: "dropped"; readonly message: string }
  | { readonly kind: "resumed" }
  | { readonly kind: "delta"; readonly sessionID: string; readonly messageID: string; readonly text: string }
  | { readonly kind: "activity"; readonly sessionID: string; readonly note: string }
  | { readonly kind: "model"; readonly sessionID: string; readonly providerID: string; readonly modelID: string }
  | {
      readonly kind: "tool";
      readonly sessionID: string;
      readonly messageID: string;
      readonly toolID: string;
      readonly name: string;
      readonly status: "running" | "ok" | "failed";
    }
  | {
      readonly kind: "settled";
      readonly sessionID: string;
      /** Undefined for `session.idle`, which carries no outcome; history has the real one. */
      readonly outcome?: "succeeded" | "failed" | "interrupted";
      readonly error?: string;
    };

export type StreamListener = (event: BridgeStreamEvent) => void;

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 5_000];

interface Disposable {
  dispose(): void;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Subscribes to the OpenCode server-sent event stream and keeps it alive.
 *
 * The stream is the only source of live assistant output, so a dropped
 * connection must not lose the conversation: Bridge retries with backoff and
 * tells the host to resynchronise history, which is the authoritative record.
 */
export class EventStream {
  private readonly listeners = new Set<StreamListener>();
  private controller: AbortController | undefined;
  private running = false;
  private everConnected = false;
  /** Tool names arrive only on `session.tool.called`; later events reference the call id. */
  private readonly toolNames = new Map<string, string>();

  /** `log` receives one line per raw server event, for diagnosing the live stream. */
  constructor(private readonly log?: (message: string) => void) {}

  onEvent(listener: StreamListener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(event: BridgeStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  start(client: OpenCodeClient): void {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(client, controller.signal);
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = undefined;
  }

  private async run(client: OpenCodeClient, signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (this.running && !signal.aborted) {
      let established = false;
      try {
        for await (const event of client.event.subscribe({ signal })) {
          if (signal.aborted) break;
          if (!established) {
            established = true;
            attempt = 0;
            if (this.everConnected) {
              this.emit({ kind: "resumed" });
            } else {
              this.everConnected = true;
              this.emit({ kind: "connected" });
            }
          }
          this.handle(event);
        }
        if (signal.aborted) break;
        this.emit({ kind: "dropped", message: "The OpenCode event stream closed." });
      } catch (error) {
        if (signal.aborted) break;
        this.emit({ kind: "dropped", message: error instanceof Error ? error.message : String(error) });
      }

      if (!this.running || signal.aborted) break;
      await delay(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 5000, signal);
      attempt += 1;
    }
  }

  private handle(event: OpenCodeEvent): void {
    const sessionID = (event.data as { sessionID?: unknown }).sessionID;
    this.log?.(
      `sdk event: ${event.type}${typeof sessionID === "string" ? ` session=${sessionID}` : " (global)"}`,
    );
    if (typeof sessionID !== "string") return; // Global event, not session-scoped.

    switch (event.type) {
      case "session.text.delta":
        this.emit({
          kind: "delta",
          sessionID,
          messageID: event.data.assistantMessageID,
          text: event.data.delta,
        });
        return;
      case "session.reasoning.delta":
        this.emit({ kind: "activity", sessionID, note: "Thinking" });
        return;
      case "session.step.started":
        this.emit({
          kind: "model",
          sessionID,
          providerID: event.data.model.providerID,
          modelID: event.data.model.id,
        });
        return;
      case "session.tool.input.started":
        this.toolNames.set(event.data.id, event.data.name);
        return;
      case "session.tool.called": {
        this.emit({
          kind: "tool",
          sessionID,
          messageID: event.data.assistantMessageID,
          toolID: event.data.id,
          name: this.toolNames.get(event.data.id) ?? "tool",
          status: "running",
        });
        return;
      }
      case "session.tool.success":
        this.emit({
          kind: "tool",
          sessionID,
          messageID: event.data.assistantMessageID,
          toolID: event.data.id,
          name: this.toolNames.get(event.data.id) ?? "tool",
          status: "ok",
        });
        return;
      case "session.tool.failed":
        this.emit({
          kind: "tool",
          sessionID,
          messageID: event.data.assistantMessageID,
          toolID: event.data.id,
          name: this.toolNames.get(event.data.id) ?? "tool",
          status: "failed",
        });
        return;
      case "session.retry.scheduled":
        this.emit({ kind: "activity", sessionID, note: `Retrying (attempt ${event.data.attempt})` });
        return;
      case "session.execution.started":
        this.emit({ kind: "activity", sessionID, note: "Working" });
        return;
      case "session.execution.succeeded":
        this.emit({ kind: "settled", sessionID, outcome: "succeeded" });
        return;
      case "session.execution.failed":
        this.emit({
          kind: "settled",
          sessionID,
          outcome: "failed",
          error: event.data.error?.message ?? "OpenCode reported a failure.",
        });
        return;
      case "session.execution.interrupted":
        this.emit({ kind: "settled", sessionID, outcome: "interrupted" });
        return;
      case "session.idle":
        // OpenCode 2.0.30 does not emit this for normal turns. It carries no
        // outcome, so the controller reads the real one from stored messages.
        this.emit({ kind: "settled", sessionID });
        return;
      default:
        return;
    }
  }
}
