/**
 * Test double for the `vscode` module, wired in through the vitest alias in
 * vitest.config.ts. It records what the extension registers so tests can assert
 * on real activation behaviour without an Extension Development Host.
 */

export interface DisposableLike {
  dispose(): void;
}

interface RegisteredViewProvider {
  resolveWebviewView(view: unknown, context?: unknown, token?: unknown): void;
}

interface ViewProviderRegistration {
  viewType: string;
  provider: RegisteredViewProvider;
}

export interface FakeWebview {
  html: string;
  options: unknown;
  posted: unknown[];
  cspSource: string;
  asWebviewUri(uri: { toString(): string }): { toString(): string };
  onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike;
  /** Deliver a raw message as if the webview posted it. */
  send(message: unknown): void;
  postMessage(message: unknown): Promise<boolean>;
}

export interface FakeWebviewView {
  webview: FakeWebview;
  visible: boolean;
  show(preserveFocus?: boolean): void;
  onDidDispose(listener: () => void): DisposableLike;
  dispose(): void;
}

export const testApi = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  viewProviders: [] as ViewProviderRegistration[],
  output: [] as string[],
  infoMessages: [] as string[],
  warningMessages: [] as string[],
  errorMessages: [] as string[],
  executedCommands: [] as { command: string; args: unknown[] }[],
  configuration: {} as Record<string, unknown>,
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  reset(): void {
    this.commands.clear();
    this.viewProviders.length = 0;
    this.output.length = 0;
    this.infoMessages.length = 0;
    this.warningMessages.length = 0;
    this.errorMessages.length = 0;
    this.executedCommands.length = 0;
    this.configuration = {};
    this.workspaceFolders = undefined;
  },
  /** Create a webview view and resolve it against the most recently registered provider. */
  resolveView(viewType: string): FakeWebviewView {
    const registration = this.viewProviders.find((entry) => entry.viewType === viewType);
    if (!registration) throw new Error(`no view provider registered for ${viewType}`);
    const view = createFakeView();
    registration.provider.resolveWebviewView(view);
    return view;
  },
};

function createFakeView(): FakeWebviewView {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disposeListeners: (() => void)[] = [];
  const webview: FakeWebview = {
    html: "",
    options: {},
    posted: [],
    cspSource: "vscode-webview://test-csp-source",
    asWebviewUri: (uri) => ({ toString: () => `https://test-webview/${uri.toString()}` }),
    onDidReceiveMessage: (listener) => {
      messageListeners.push(listener);
      return { dispose: () => undefined };
    },
    send: (message) => {
      for (const listener of messageListeners) listener(message);
    },
    postMessage: async (message) => {
      webview.posted.push(message);
      return true;
    },
  };
  return {
    webview,
    visible: true,
    show: () => undefined,
    onDidDispose: (listener) => {
      disposeListeners.push(listener);
      return { dispose: () => undefined };
    },
    dispose: () => {
      for (const listener of disposeListeners) listener();
    },
  };
}

export const commands = {
  registerCommand(name: string, handler: (...args: unknown[]) => unknown): DisposableLike {
    testApi.commands.set(name, handler);
    return { dispose: () => testApi.commands.delete(name) };
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<void> {
    testApi.executedCommands.push({ command, args });
  },
};

export const window = {
  createOutputChannel(): DisposableLike & { appendLine(line: string): void } {
    return {
      appendLine: (line: string) => testApi.output.push(line),
      dispose: () => undefined,
    };
  },
  registerWebviewViewProvider(viewType: string, provider: RegisteredViewProvider): DisposableLike {
    testApi.viewProviders.push({ viewType, provider });
    return { dispose: () => undefined };
  },
  async showInformationMessage(message: string): Promise<void> {
    testApi.infoMessages.push(message);
  },
  async showWarningMessage(message: string): Promise<void> {
    testApi.warningMessages.push(message);
  },
  async showErrorMessage(message: string): Promise<void> {
    testApi.errorMessages.push(message);
  },
};

export const workspace = {
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = testApi.configuration[`${section}.${key}`];
        return value === undefined ? fallback : (value as T);
      },
    };
  },
  get workspaceFolders() {
    return testApi.workspaceFolders;
  },
  onDidChangeConfiguration(): DisposableLike {
    return { dispose: () => undefined };
  },
};

export const Uri = {
  joinPath(base: { toString(): string }, ...parts: string[]) {
    const joined = [base.toString().replace(/\/+$/, ""), ...parts].join("/");
    return { toString: () => joined, fsPath: joined };
  },
};
