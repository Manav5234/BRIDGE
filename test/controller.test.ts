import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/config";
import { BridgeController } from "../src/controller";
import type { UiMessage, UiState } from "../src/webview/protocol";
import {
  makeFakeClient,
  makeFakeConnection,
  makeFakeStream,
  storedAssistantMessage,
  storedUserMessage,
} from "./helpers/fakes";

const SESSION = "ses_test1";
/** Let promise chains started by stream events finish. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface HarnessOptions {
  readonly client?: Parameters<typeof makeFakeClient>[0];
  readonly directory?: string | undefined;
  readonly secrets?: string[];
}

function harness(options: HarnessOptions = {}) {
  const { client, calls } = makeFakeClient(options.client);
  const { stream, emit } = makeFakeStream();
  const controller = new BridgeController({
    connection: makeFakeConnection(client, options.secrets ?? []),
    stream,
    settings: () => DEFAULT_SETTINGS,
    directory: () => ("directory" in options ? options.directory : "/workspace"),
  });
  controller.start();

  const deltas: { messageID: string; text: string }[] = [];
  controller.onDidDelta((messageID, text) => deltas.push({ messageID, text }));
  return { controller, calls, emit, deltas };
}

const last = (messages: readonly UiMessage[]) => messages[messages.length - 1];
const state = (harnessed: ReturnType<typeof harness>): UiState => harnessed.controller.snapshot();

describe("connecting", () => {
  it("keeps chat unavailable and explains why when no workspace folder is open", async () => {
    const h = harness({ directory: undefined });

    await h.controller.connect();
    await h.controller.send("hello");

    expect(state(h).setup?.message).toContain("No workspace folder");
    expect(h.calls.prompt).toHaveLength(0);
    expect(state(h).error?.message).toContain("not connected");
  });

  it("shows the model OpenCode itself will use", async () => {
    const h = harness({ client: { defaultModel: { modelID: "alpha-free", providerID: "opencode" } } });

    await h.controller.connect();

    expect(state(h).model).toEqual({ providerID: "opencode", id: "alpha-free" });
  });

  it("lists existing sessions from OpenCode", async () => {
    const h = harness({
      client: {
        sessions: [{ id: "ses_old", title: "Earlier work", time: { updated: 5 } }],
      },
    });

    await h.controller.connect();

    expect(state(h).sessions).toEqual([{ id: "ses_old", title: "Earlier work", updated: 5 }]);
    expect(state(h).status).toBe("Connected");
  });
});

describe("sending", () => {
  it("reuses one session for consecutive messages", async () => {
    const h = harness();
    await h.controller.connect();

    await h.controller.send("first");
    h.emit({ kind: "settled", sessionID: SESSION, outcome: "succeeded" });
    await flush();
    await h.controller.send("second");

    expect(h.calls.createSession).toBe(1);
    expect(h.calls.prompt.map((call) => call.sessionID)).toEqual([SESSION, SESSION]);
  });

  it("refuses a second message while the first is still streaming", async () => {
    const h = harness();
    await h.controller.connect();

    await h.controller.send("first");
    await h.controller.send("second");

    expect(h.calls.prompt).toHaveLength(1);
    expect(state(h).status).toContain("still streaming");
  });

  it("marks a failed message and only resends it when the user retries", async () => {
    const h = harness({ client: { promptError: new Error("OpenCode rejected the prompt") } });
    await h.controller.connect();

    await h.controller.send("hello");

    expect(last(state(h).messages)).toMatchObject({ role: "user", text: "hello", failed: true });
    expect(state(h).busy).toBe(false);
    expect(state(h).error?.retryable).toBe(true);

    await h.controller.retry();

    const users = state(h).messages.filter((message) => message.role === "user");
    expect(h.calls.prompt).toHaveLength(2);
    expect(users).toHaveLength(1);
    expect(users[0]?.failed).toBe(false);
  });

  it("never shows a credential in an error message", async () => {
    const password = "hunter2-secret-value";
    const h = harness({
      client: { promptError: new Error(`request failed using password ${password}`) },
      secrets: [password],
    });
    await h.controller.connect();

    await h.controller.send("hello");

    expect(state(h).error?.message).not.toContain(password);
    expect(state(h).error?.message).toContain("[redacted]");
  });
});

describe("stopping", () => {
  it("interrupts the active session and clears busy when nothing was running", async () => {
    const h = harness({ client: { interruptResult: false } });
    await h.controller.connect();
    await h.controller.send("hello");
    expect(state(h).busy).toBe(true);

    await h.controller.stop();

    expect(h.calls.interrupt).toEqual([SESSION]);
    expect(state(h).busy).toBe(false);
    expect(state(h).status).toBe("Nothing was running.");
  });
});

describe("live updates", () => {
  it("streams text into one assistant message, then settles into the stored transcript", async () => {
    const h = harness({
      client: {
        historyMessages: [
          storedUserMessage("msg_user1", "hi"),
          storedAssistantMessage("msg_asst1", "bridge-ok"),
        ],
      },
    });
    await h.controller.connect();
    await h.controller.send("hi");

    h.emit({ kind: "delta", sessionID: SESSION, messageID: "msg_asst1", text: "bridge-" });
    h.emit({ kind: "delta", sessionID: SESSION, messageID: "msg_asst1", text: "ok" });

    expect(state(h).messages.find((message) => message.id === "msg_asst1")?.text).toBe("bridge-ok");
    // The first chunk arrives as full state; the rest reuse the delta channel.
    expect(h.deltas).toEqual([{ messageID: "msg_asst1", text: "ok" }]);

    h.emit({ kind: "settled", sessionID: SESSION, outcome: "succeeded" });
    await flush();

    expect(state(h).busy).toBe(false);
    expect(state(h).status).toBe("Ready");
    expect(state(h).messages).toHaveLength(2);
    expect(state(h).model).toEqual({ providerID: "test-provider", id: "test-model" });
  });

  it("reads the outcome from stored messages when the stream event has none", async () => {
    const h = harness({
      client: {
        historyMessages: [
          storedUserMessage("msg_user1", "hi"),
          { id: "msg_idle1", time: { created: 4 }, type: "idle", outcome: "interrupted" },
        ],
      },
    });
    await h.controller.connect();
    await h.controller.send("hi");

    h.emit({ kind: "settled", sessionID: SESSION });
    await flush();

    expect(state(h).status).toBe("Stopped");
    expect(state(h).busy).toBe(false);
  });

  it("ignores events from sessions other than the active one", async () => {
    const h = harness();
    await h.controller.connect();
    await h.controller.send("hi");

    h.emit({ kind: "delta", sessionID: "ses_other", messageID: "msg_x", text: "not mine" });

    expect(state(h).messages.map((message) => message.text)).toEqual(["hi"]);
    expect(h.deltas).toHaveLength(0);
  });

  it("tracks a tool call from running to done", async () => {
    const h = harness();
    await h.controller.connect();
    await h.controller.send("hi");

    const tool = { kind: "tool" as const, sessionID: SESSION, messageID: "msg_asst1", toolID: "call_1" };
    h.emit({ ...tool, name: "read", status: "running" });
    expect(state(h).messages.find((message) => message.id === "msg_asst1")?.tools).toEqual([
      { name: "read", status: "running" },
    ]);

    h.emit({ ...tool, name: "read", status: "ok" });

    expect(state(h).messages.find((message) => message.id === "msg_asst1")?.tools).toEqual([
      { name: "read", status: "ok" },
    ]);
  });

  it("does not leave the UI busy when the event stream drops", async () => {
    const h = harness();
    await h.controller.connect();
    await h.controller.send("hi");

    h.emit({ kind: "dropped", message: "stream closed" });

    expect(state(h).busy).toBe(false);
    expect(state(h).status).toContain("Reconnecting");
  });
});
