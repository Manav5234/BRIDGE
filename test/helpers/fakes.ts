import type { BridgeStreamEvent } from "../../src/opencode/stream";
import type { ConnectionManager } from "../../src/opencode/connection";
import type { EventStream } from "../../src/opencode/stream";

export interface FakeCallLog {
  readonly prompt: { sessionID: string; text: string }[];
  readonly createSession: number;
  readonly history: string[];
  readonly interrupt: string[];
}

interface FakeClientOptions {
  readonly sessionId?: string;
  readonly historyMessages?: unknown[];
  readonly promptResultId?: string;
  /** Thrown by the next prompt call only, so a test can fail once and then retry. */
  readonly promptError?: Error;
  readonly interruptResult?: boolean;
  readonly defaultModel?: unknown;
  readonly sessions?: unknown[];
}

/** A stand-in for the OpenCode SDK client, shaped exactly like the real one. */
export function makeFakeClient(options: FakeClientOptions = {}) {
  const sessionId = options.sessionId ?? "ses_test1";
  let pendingPromptError = options.promptError;
  const calls: FakeCallLog & { createSession: number } = {
    prompt: [],
    createSession: 0,
    history: [],
    interrupt: [],
  };

  const client = {
    location: {
      get: async () => ({
        directory: "/workspace",
        project: { id: "proj_1", directory: "/workspace", canonical: "/workspace" },
      }),
    },
    session: {
      list: async () => ({ data: options.sessions ?? [], cursor: {} }),
      create: async () => {
        calls.createSession += 1;
        return {
          id: sessionId,
          projectID: "proj_1",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: "/workspace" },
        };
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        calls.prompt.push({ sessionID: input.sessionID, text: input.text });
        if (pendingPromptError) {
          const error = pendingPromptError;
          pendingPromptError = undefined;
          throw error;
        }
        return {
          id: options.promptResultId ?? "msg_user1",
          sessionID: input.sessionID,
          time: { created: 1 },
          type: "user" as const,
          payload: { text: input.text },
          delivery: "steer" as const,
        };
      },
      interrupt: async (input: { sessionID: string }) => {
        calls.interrupt.push(input.sessionID);
        return { interrupted: options.interruptResult ?? true };
      },
    },
    message: {
      list: async (input: { sessionID: string }) => {
        calls.history.push(input.sessionID);
        return { data: options.historyMessages ?? [], cursor: {} };
      },
    },
    model: {
      list: async () => ({ data: [] }),
      default: async () => ({ data: options.defaultModel ?? null }),
    },
    event: { subscribe: () => ({}) },
  };

  return { client, calls };
}

export function makeFakeStream() {
  const listeners: ((event: BridgeStreamEvent) => void)[] = [];
  const stream = {
    onEvent: (listener: (event: BridgeStreamEvent) => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
    start: () => undefined,
    stop: () => undefined,
  };
  return {
    stream: stream as unknown as EventStream,
    emit: (event: BridgeStreamEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

export function makeFakeConnection(client: unknown, secrets: string[] = []) {
  const connection = {
    snapshot: () => ({
      status: "connected" as const,
      baseUrl: "http://127.0.0.1:45000",
      version: "2.0.30",
      source: "service-state",
    }),
    client: () => client,
    connect: async () => undefined,
    reset: () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    redactableSecrets: () => secrets,
  };
  return connection as unknown as ConnectionManager;
}

/** Minimal stored messages matching the real OpenCode shapes. */
export const storedUserMessage = (id: string, text: string) => ({
  id,
  time: { created: 1 },
  type: "user" as const,
  text,
});

export const storedAssistantMessage = (id: string, text: string, overrides: Record<string, unknown> = {}) => ({
  id,
  time: { created: 2, completed: 3 },
  type: "assistant" as const,
  agent: "build",
  model: { id: "test-model", providerID: "test-provider" },
  content: [{ type: "text" as const, text }],
  ...overrides,
});
