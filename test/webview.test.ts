/**
 * The webview script is plain browser JavaScript (no imports, no exports), so it is
 * run unchanged in a `node:vm` context with a minimal fake DOM. That keeps the test
 * dependency-free while still exercising the real rendering code.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../media/webview/main.js", import.meta.url)),
  "utf8",
);

const ELEMENT_IDS = [
  "dot",
  "statusText",
  "workspace",
  "setup",
  "setupMessage",
  "setupGuidance",
  "setupConnect",
  "setupSettings",
  "chat",
  "sessionSelect",
  "newSession",
  "messages",
  "errorBox",
  "errorText",
  "retry",
  "input",
  "send",
  "stop",
];

interface FakeElement {
  className: string;
  dataset: Record<string, string>;
  children: FakeElement[];
  parentNode: FakeElement | null;
  textContent: string;
  value: string;
  disabled: boolean;
  placeholder: string;
  title: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  classList: { toggle(name: string, force?: boolean): void };
  hasClass(name: string): boolean;
  appendChild(child: FakeElement): void;
  remove(): void;
  addEventListener(type: string, listener: unknown): void;
}

function fakeElement(): FakeElement {
  const children: FakeElement[] = [];
  const classes = new Set<string>();
  let text = "";
  const element: FakeElement = {
    className: "",
    dataset: {},
    children,
    parentNode: null,
    get textContent() {
      return text;
    },
    // Matches the real DOM closely enough for this script: writing text drops children.
    set textContent(value: string) {
      text = value;
      for (const child of children) child.parentNode = null;
      children.length = 0;
    },
    value: "",
    disabled: false,
    placeholder: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    hasClass: (name) => classes.has(name),
    appendChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      child.parentNode = element;
      children.push(child);
    },
    remove() {
      const parent = element.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(element);
      if (index >= 0) parent.children.splice(index, 1);
      element.parentNode = null;
    },
    // Buttons and the composer wire handlers here; this test drives the host messages.
    addEventListener: () => undefined,
  };
  return element;
}

interface LoadedWebview {
  elements: Map<string, FakeElement>;
  posted: { type?: unknown }[];
  /** Deliver a message as if the extension host had posted it. */
  send(data: unknown): void;
}

function loadWebview(): LoadedWebview {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, fakeElement()]));
  const posted: { type?: unknown }[] = [];
  const messageListeners: ((event: { data: unknown }) => void)[] = [];

  const context = createContext({
    acquireVsCodeApi: () => ({ postMessage: (message: { type?: unknown }) => posted.push(message) }),
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => fakeElement(),
    },
    window: {
      addEventListener: (type: string, listener: unknown) => {
        if (type === "message") messageListeners.push(listener as (event: { data: unknown }) => void);
      },
    },
  });

  runInContext(source, context, { filename: "media/webview/main.js" });

  return {
    elements,
    posted,
    send: (data) => {
      for (const listener of messageListeners) listener({ data });
    },
  };
}

function element(webview: LoadedWebview, id: string): FakeElement {
  const found = webview.elements.get(id);
  if (!found) throw new Error(`the webview has no #${id} element`);
  return found;
}

/** The rendered transcript: one <article> per message. */
function transcript(webview: LoadedWebview): FakeElement[] {
  return element(webview, "messages").children;
}

function articleAt(webview: LoadedWebview, index: number): FakeElement {
  const article = transcript(webview)[index];
  if (!article) throw new Error(`no transcript article at index ${index}`);
  return article;
}

/** createMessageElement appends head, body, tools in that order. */
const bodyText = (article: FakeElement): string => article.children[1]?.textContent ?? "";

const userMessage = (id: string, text: string) => ({
  id,
  role: "user",
  text,
  pending: false,
  failed: false,
});

const assistantMessage = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: "assistant",
  text,
  pending: false,
  failed: false,
  ...extra,
});

const stateMessage = (messages: unknown[], connection: Record<string, unknown> = { status: "connected" }) => ({
  type: "state",
  state: {
    connection,
    workspace: { directory: "C:\\work" },
    sessions: [],
    messages,
    busy: false,
    status: "Ready",
  },
});

describe("webview transcript rendering", () => {
  it("renders every message carried by a state message", () => {
    const webview = loadWebview();
    expect(webview.posted).toEqual([{ type: "ready" }]);

    webview.send(
      stateMessage([
        userMessage("msg_u1", "hello"),
        assistantMessage("msg_a1", "bridge-ok", {
          model: { providerID: "opencode", id: "ll-alpha-free" },
        }),
      ]),
    );

    const articles = transcript(webview);
    expect(articles.map((article) => article.dataset.id)).toEqual(["msg_u1", "msg_a1"]);
    expect(articles.map((article) => article.className)).toEqual(["msg msg-user", "msg msg-assistant"]);
    expect(articles.map(bodyText)).toEqual(["hello", "bridge-ok"]);
  });

  it("marks a pending assistant message so the streaming cursor shows", () => {
    const webview = loadWebview();

    webview.send(stateMessage([assistantMessage("msg_a1", "bridge-", { pending: true })]));

    expect(articleAt(webview, 0).hasClass("is-pending")).toBe(true);
  });

  it("appends deltas to the bubble renderMessages created", () => {
    const webview = loadWebview();
    webview.send(stateMessage([assistantMessage("msg_a1", "bridge-", { pending: true })]));

    webview.send({ type: "delta", messageID: "msg_a1", text: "ok" });

    expect(transcript(webview)).toHaveLength(1);
    expect(bodyText(articleAt(webview, 0))).toBe("bridge-ok");
  });

  it("keeps the transcript pinned to the bottom when new content arrives", () => {
    const webview = loadWebview();
    const messages = element(webview, "messages");
    messages.scrollHeight = 500;
    messages.clientHeight = 100;
    messages.scrollTop = 460;

    webview.send(stateMessage([userMessage("msg_u1", "hello")]));
    expect(messages.scrollTop).toBe(500);

    messages.scrollTop = 460;
    webview.send({ type: "delta", messageID: "msg_u1", text: " again" });
    expect(messages.scrollTop).toBe(500);
  });

  it("removes messages that are gone and clears the transcript when disconnected", () => {
    const webview = loadWebview();
    webview.send(stateMessage([userMessage("msg_u1", "hello"), assistantMessage("msg_a1", "hi")]));
    expect(transcript(webview)).toHaveLength(2);

    webview.send(stateMessage([userMessage("msg_u1", "hello")]));
    expect(transcript(webview).map((article) => article.dataset.id)).toEqual(["msg_u1"]);

    webview.send(stateMessage([userMessage("msg_u1", "hello")], { status: "disconnected" }));
    expect(transcript(webview)).toHaveLength(0);
  });
});
