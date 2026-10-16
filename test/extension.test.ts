import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { FakeWebviewView } from "./stubs/vscode";
import type { UiState } from "../src/webview/protocol";

const { testApi } = vscode as unknown as typeof import("./stubs/vscode");

// Keep tests hermetic: never read the machine's real OpenCode state directory.
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return { ...actual, discoverServiceState: () => undefined };
});

const { activate, deactivate } = await import("../src/extension");

const COMMANDS = [
  "bridge.connect",
  "bridge.disconnect",
  "bridge.newSession",
  "bridge.openChat",
  "bridge.stopGeneration",
];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function activateExtension(): void {
  activate({
    extensionUri: { toString: () => "file:///extension", fsPath: "/extension" },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext);
}

function postedStates(view: FakeWebviewView): UiState[] {
  return view.webview.posted
    .filter((message): message is { type: "state"; state: UiState } =>
      (message as { type?: string }).type === "state")
    .map((message) => message.state);
}

const runCommand = async (name: string): Promise<void> => {
  await testApi.commands.get(name)?.();
};

beforeEach(() => {
  testApi.reset();
});

describe("activation", () => {
  it("registers the commands and the chat view", () => {
    activateExtension();

    expect([...testApi.commands.keys()].sort()).toEqual([...COMMANDS].sort());
    expect(testApi.viewProviders.map((registration) => registration.viewType)).toEqual(["bridge.chat"]);
    expect(testApi.output).toContain("Bridge activated.");
  });

  it("is safe to deactivate", () => {
    activateExtension();

    expect(() => deactivate()).not.toThrow();
  });
});

describe("the chat webview", () => {
  it("posts state and explains the setup when no server is found", async () => {
    activateExtension();
    const view = testApi.resolveView("bridge.chat");

    view.webview.send({ type: "ready" });
    await flush();

    const state = postedStates(view).at(-1);
    expect(state?.setup?.message).toContain("No OpenCode server found");
    expect(state?.setup?.guidance).toContain("opencode service start");
  });

  it("rejects malformed messages and refuses to chat before connecting", async () => {
    activateExtension();
    const view = testApi.resolveView("bridge.chat");

    view.webview.send({ type: "send", text: "   ", requestID: "r1" });
    view.webview.send({ type: "not-a-real-type" });
    view.webview.send({ type: "send", text: "hello", requestID: "r2" });
    await flush();

    expect(testApi.output.filter((line) => line.includes("rejected webview message"))).toHaveLength(2);
    expect(postedStates(view).at(-1)?.error?.message).toContain("not connected");
  });

  it("opens the view without a crash when the Open Chat command runs", async () => {
    activateExtension();

    await runCommand("bridge.openChat");

    expect(testApi.executedCommands.map((entry) => entry.command)).toContain("bridge.chat.focus");
  });
});

describe("commands", () => {
  it("warns instead of claiming success when Connect finds no server", async () => {
    activateExtension();

    await runCommand("bridge.connect");
    await flush();

    expect(testApi.warningMessages.some((message) => message.includes("No OpenCode server found"))).toBe(true);
    expect(testApi.infoMessages).toHaveLength(0);
  });

  it("returns the UI to disconnected when Disconnect runs", async () => {
    activateExtension();
    const view = testApi.resolveView("bridge.chat");

    await runCommand("bridge.disconnect");

    expect(postedStates(view).at(-1)?.connection.status).toBe("disconnected");
  });

  it("surfaces an unexpected command failure as an error message", async () => {
    activateExtension();
    // Break the handler's collaborator to prove the wrapper reports instead of swallowing.
    const controller = (await import("../src/controller")).BridgeController;
    const spy = vi.spyOn(controller.prototype, "newSession").mockRejectedValue(new Error("boom"));

    await runCommand("bridge.newSession");

    expect(testApi.errorMessages.some((message) => message.includes("boom"))).toBe(true);
    spy.mockRestore();
  });
});
