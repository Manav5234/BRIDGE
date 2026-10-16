import type {
  ModelInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionInboxUser,
  SessionInterruptResponse,
} from "@opencode/client";
import type { OpenCodeClient } from "./connection";
import type { UiMessage, UiSessionSummary, UiToolCall } from "../webview/protocol";

/** The slice of the SDK that session handling needs, so tests can stub it narrowly. */
export type SessionApi = Pick<OpenCodeClient, "session" | "message" | "location" | "model">;

export interface WorkspaceInfo {
  readonly directory: string;
  readonly projectID: string;
}

export interface HistoryResult {
  readonly messages: UiMessage[];
  /** From the stored `idle` message, which is where OpenCode records the turn result. */
  readonly outcome?: "succeeded" | "failed" | "interrupted";
  readonly error?: string;
}

function toolStatus(tool: SessionMessageAssistantTool): UiToolCall["status"] {
  switch (tool.state.status) {
    case "completed":
      return "ok";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

function assistantToUi(message: SessionMessageAssistant): UiMessage {
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

  const tools = message.content
    .filter((part): part is SessionMessageAssistantTool => part.type === "tool")
    .map((part): UiToolCall => ({ name: part.name, status: toolStatus(part) }));

  return {
    id: message.id,
    role: "assistant",
    text,
    pending: message.time.completed === undefined,
    failed: message.finish === "error" || message.error !== undefined,
    model: { providerID: message.model.providerID, id: message.model.id },
    tools: tools.length > 0 ? tools : undefined,
  };
}

/**
 * Convert stored OpenCode messages into chat entries.
 * System, compaction, shell and switch messages carry no chat text and are dropped.
 */
export function toUiMessages(messages: readonly SessionMessageInfo[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      if (message.text.trim() === "") continue;
      out.push({
        id: message.id,
        role: "user",
        text: message.text,
        pending: false,
        failed: false,
      });
    } else if (message.type === "assistant") {
      out.push(assistantToUi(message));
    }
  }
  return out;
}

export function toSessionSummary(session: SessionInfo): UiSessionSummary {
  return {
    id: session.id,
    title: session.title?.trim() || "Untitled session",
    updated: session.time.updated,
  };
}

export class SessionGateway {
  constructor(private readonly api: SessionApi) {}

  async describeWorkspace(directory: string, signal?: AbortSignal): Promise<WorkspaceInfo> {
    const info = await this.api.location.get({ location: { directory } }, { signal });
    return { directory: info.directory, projectID: info.project.id };
  }

  /** Sessions scoped to a workspace, most recently updated first. */
  async listSessions(directory: string, signal?: AbortSignal): Promise<UiSessionSummary[]> {
    const response = await this.api.session.list({ directory, limit: 50 }, { signal });
    return response.data.map(toSessionSummary).sort((a, b) => b.updated - a.updated);
  }

  /**
   * Create a new session. No title is set: OpenCode generates one from the first
   * prompt, so Bridge shows the same title the OpenCode TUI shows.
   */
  async createSession(directory: string, signal?: AbortSignal): Promise<UiSessionSummary> {
    const session = await this.api.session.create({ location: { directory } }, { signal });
    return toSessionSummary(session);
  }

  async loadHistory(sessionID: string, signal?: AbortSignal): Promise<HistoryResult> {
    const response = await this.api.message.list({ sessionID, order: "asc" }, { signal });
    const lastIdle = [...response.data].reverse().find((message) => message.type === "idle");
    return {
      messages: toUiMessages(response.data),
      outcome: lastIdle?.type === "idle" ? lastIdle.outcome : undefined,
      error: lastIdle?.type === "idle" ? lastIdle.error?.message : undefined,
    };
  }

  /** Enqueue a prompt. Returns as soon as OpenCode accepts it; output arrives on the event stream. */
  async sendPrompt(
    sessionID: string,
    text: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<SessionInboxUser> {
    return this.api.session.prompt(
      {
        sessionID,
        text,
        metadata: { source: "bridge", directory },
      },
      { signal },
    );
  }

  async interrupt(sessionID: string, signal?: AbortSignal): Promise<SessionInterruptResponse> {
    return this.api.session.interrupt({ sessionID }, { signal });
  }

  /** Models OpenCode has configured. Bridge never invents or hardcodes a model. */
  async listModels(directory: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.api.model.list({ location: { directory } }, { signal });
    return response.data;
  }

  async defaultModel(directory: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
    const response = await this.api.model.default({ location: { directory } }, { signal });
    return response.data ?? undefined;
  }
}
