import * as vscode from "vscode";
import { DEFAULT_SETTINGS, discoverServiceState, type BridgeSettings } from "./config";
import { BridgeController } from "./controller";
import { ConnectionManager } from "./opencode/connection";
import { EventStream } from "./opencode/stream";
import { createRegistry } from "./providers/adapter";
import { ChatViewProvider } from "./webview/view";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Bridge");
  context.subscriptions.push(output);

  const readSettings = (): BridgeSettings => {
    const config = vscode.workspace.getConfiguration("bridge");
    return {
      serverUrl: config.get<string>("serverUrl", DEFAULT_SETTINGS.serverUrl),
      allowRemoteServer: config.get<boolean>("allowRemoteServer", DEFAULT_SETTINGS.allowRemoteServer),
      username: config.get<string>("username", DEFAULT_SETTINGS.username),
      password: config.get<string>("password", DEFAULT_SETTINGS.password),
      directory: config.get<string>("directory", DEFAULT_SETTINGS.directory),
      requestTimeoutMs: config.get<number>("requestTimeoutMs", DEFAULT_SETTINGS.requestTimeoutMs),
    };
  };

  const resolveDirectory = (): string | undefined => {
    const configured = readSettings().directory.trim();
    if (configured !== "") return configured;
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  };

  const connection = new ConnectionManager(readSettings, () => discoverServiceState());
  const stream = new EventStream((message) => output.appendLine(message));
  const controller = new BridgeController({
    connection,
    stream,
    settings: readSettings,
    directory: resolveDirectory,
    log: (message) => output.appendLine(message),
  });
  controller.start();
  context.subscriptions.push({ dispose: () => controller.dispose() });

  // Planning assistants are a future integration; today every request goes to the user.
  const assistants = createRegistry();
  output.appendLine(`planning assistant: ${assistants.active().label}`);
  let autoConnectAttempted = false;

  const provider = new ChatViewProvider(context.extensionUri, controller, {
    // The user opening Bridge is the first reachability check.
    ready: () => {
      if (autoConnectAttempted) return;
      autoConnectAttempted = true;
      if (connection.snapshot().status !== "connected") void controller.connect();
    },
    connect: () => controller.connect(),
    disconnect: () => controller.disconnect(),
    newSession: () => controller.newSession(),
    refreshSessions: () => controller.refreshSessions(),
    selectSession: (sessionID) => controller.selectSession(sessionID),
    send: (text) => controller.send(text),
    stop: () => controller.stop(),
    retry: () => controller.retry(),
    openSettings: async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:bridge-local.bridge");
    },
    log: (message) => output.appendLine(message),
  });

  // The user opening Bridge is the first reachability check.
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));

  const run = (name: string, action: () => Promise<unknown> | unknown) =>
    vscode.commands.registerCommand(name, async () => {
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`${name} failed: ${message}`);
        void vscode.window.showErrorMessage(`Bridge: ${message}`);
      }
    });

  context.subscriptions.push(
    run("bridge.openChat", async () => {
      await provider.show();
      if (connection.snapshot().status !== "connected") await controller.connect();
    }),
    run("bridge.connect", async () => {
      await controller.connect();
      const snapshot = connection.snapshot();
      if (snapshot.status === "connected") {
        void vscode.window.showInformationMessage(
          `Bridge connected to OpenCode ${snapshot.version ?? ""} at ${snapshot.baseUrl ?? ""}`.trim(),
        );
      } else if (snapshot.message) {
        void vscode.window.showWarningMessage(`Bridge: ${snapshot.message}`);
      }
    }),
    run("bridge.disconnect", () => controller.disconnect()),
    run("bridge.newSession", async () => {
      await provider.show();
      await controller.newSession();
    }),
    run("bridge.stopGeneration", () => controller.stop()),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("bridge")) return;
      output.appendLine("Bridge settings changed; reconnect to apply them.");
    }),
  );

  output.appendLine("Bridge activated.");
}

export function deactivate(): void {
  // Disposables registered on the extension context handle teardown.
}
