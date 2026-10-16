import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { parseInboundMessage, type InboundMessage, type OutboundMessage, type UiState } from "./protocol";

export interface ChatViewHandlers {
  /** The webview finished loading: the user opened Bridge. */
  ready(): void | Promise<void>;
  connect(): void | Promise<void>;
  disconnect(): void | Promise<void>;
  newSession(): void | Promise<void>;
  refreshSessions(): void | Promise<void>;
  selectSession(sessionID: string): void | Promise<void>;
  send(text: string): void | Promise<void>;
  stop(): void | Promise<void>;
  retry(): void | Promise<void>;
  openSettings(): void | Promise<void>;
  log(message: string): void;
}

/**
 * Hosts the chat webview.
 *
 * The webview is treated as untrusted: every message is validated before it
 * reaches the controller, it can only load resources from this extension's
 * `media` directory, and no credentials are ever posted into it.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "bridge.chat";

  private view: vscode.WebviewView | undefined;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: {
      snapshot(): UiState;
      onDidChange(listener: (state: UiState) => void): { dispose(): void };
      onDidDelta(listener: (messageID: string, text: string) => void): { dispose(): void };
    },
    private readonly handlers: ChatViewHandlers,
  ) {}

  /** Reveal the Bridge view, opening the container if needed. */
  async show(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;

    view.webview.options = {
      enableScripts: true,
      // Only this extension's media directory may be loaded into the webview.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((raw: unknown) => {
      const type = (raw as { type?: unknown } | null | undefined)?.type;
      this.handlers.log(`webview -> ${typeof type === "string" ? type : "unknown"}`);
      const parsed = parseInboundMessage(raw);
      if (!parsed.ok) {
        this.handlers.log(`rejected webview message: ${parsed.error}`);
        return;
      }
      void this.dispatch(parsed.message);
    });

    this.controllerDisposables.push(
      this.controller.onDidChange((state) => this.post({ type: "state", state })),
      this.controller.onDidDelta((messageID, text) => this.post({ type: "delta", messageID, text })),
    );

    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
      this.disposeControllerSubscriptions();
    });
  }

  private controllerDisposables: { dispose(): void }[] = [];

  private disposeControllerSubscriptions(): void {
    for (const disposable of this.controllerDisposables) disposable.dispose();
    this.controllerDisposables = [];
  }

  private async dispatch(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.post({ type: "state", state: this.controller.snapshot() });
        await this.handlers.ready();
        return;
      case "connect":
        await this.handlers.connect();
        return;
      case "disconnect":
        await this.handlers.disconnect();
        return;
      case "newSession":
        await this.handlers.newSession();
        return;
      case "refreshSessions":
        await this.handlers.refreshSessions();
        return;
      case "selectSession":
        await this.handlers.selectSession(message.sessionID);
        return;
      case "send":
        await this.handlers.send(message.text);
        return;
      case "stop":
        await this.handlers.stop();
        return;
      case "retry":
        await this.handlers.retry();
        return;
      case "openSettings":
        await this.handlers.openSettings();
        return;
    }
  }

  post(message: OutboundMessage): void {
    if (!this.view) {
      this.handlers.log(`host -> webview: ${message.type} (dropped: no view)`);
      return;
    }
    // Deltas before the webview is ready would be lost; full state always follows a ready.
    if (!this.ready && message.type === "delta") {
      this.handlers.log("host -> webview: delta (dropped: webview not ready)");
      return;
    }
    this.handlers.log(`host -> webview: ${message.type}`);
    void this.view.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "webview", name)).toString();

    // No remote origins, no inline script, no connections out of the webview.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${asset("main.css")}" />
    <title>Bridge</title>
  </head>
  <body>
    <div class="app">
      <header class="bar">
        <span class="dot" id="dot" aria-hidden="true"></span>
        <span class="bar-status" id="statusText" role="status" aria-live="polite">Not connected</span>
        <span class="bar-workspace" id="workspace" title=""></span>
      </header>

      <section
        class="panel hidden"
        id="setup"
        aria-labelledby="setupHeading"
      >
        <h2 class="panel-heading" id="setupHeading">Connect to OpenCode</h2>
        <p class="panel-text" id="setupMessage"></p>
        <pre class="panel-pre hidden" id="setupGuidance"></pre>
        <div class="panel-actions">
          <button class="btn primary" id="setupConnect" type="button">Connect</button>
          <button class="btn" id="setupSettings" type="button">Open Settings</button>
        </div>
      </section>

      <main class="chat" id="chat">
        <div class="session-bar" id="sessionBar">
          <label class="sr-only" for="sessionSelect">OpenCode session</label>
          <select class="select" id="sessionSelect">
            <option value="">No session selected</option>
          </select>
          <button class="btn slim" id="newSession" type="button" title="Start a new OpenCode session">
            New
          </button>
        </div>

        <div class="messages" id="messages" role="log" aria-live="polite" aria-relevant="additions text"></div>
      </main>

      <section class="error hidden" id="errorBox" role="alert">
        <span class="error-text" id="errorText"></span>
        <button class="btn slim" id="retry" type="button">Retry</button>
      </section>

      <footer class="composer">
        <label class="sr-only" for="input">Message</label>
        <textarea
          id="input"
          class="input"
          rows="3"
          placeholder="Message OpenCode"
          spellcheck="false"
        ></textarea>
        <div class="composer-actions">
          <button class="btn primary" id="send" type="button">Send</button>
          <button class="btn" id="stop" type="button" disabled>Stop</button>
        </div>
        <p class="hint">Enter to send, Shift+Enter for a new line.</p>
      </footer>
    </div>
    <script nonce="${nonce}" src="${asset("main.js")}"></script>
  </body>
</html>`;
  }
}
