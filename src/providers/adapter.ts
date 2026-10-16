/**
 * Boundary for a future planning assistant (ChatGPT, Claude, ...) that sits between
 * the user and OpenCode:  User <-> Planning assistant <-> Bridge <-> OpenCode.
 *
 * Nothing here talks to a planning assistant yet. The interface exists so a real,
 * authorized integration can be added without touching the OpenCode connection.
 * Adding one means implementing this interface; Bridge code stays unchanged.
 */

/** How a request entered Bridge. OpenCode drives the first case today. */
export type RequestOrigin = "user" | "opencode";

/**
 * OpenCode needs two different things from a human, and they must not be confused:
 * an ordinary technical question is answerable by a planning assistant, while an
 * approval request is a permission decision that must stay with the human.
 */
export type PlanningRequest =
  | {
      readonly kind: "technical-question";
      readonly question: string;
      readonly sessionID: string;
      readonly context?: string;
    }
  | {
      readonly kind: "approval-request";
      readonly summary: string;
      readonly sessionID: string;
      /** Exact command, path or diff the human is approving. */
      readonly detail: string;
    };

export type PlanningResponse =
  | { readonly kind: "answered"; readonly text: string; readonly by: string }
  | { readonly kind: "deferred-to-human"; readonly reason: string };

export interface PlanningAssistant {
  readonly id: string;
  readonly label: string;
  /** False when the assistant has no valid, user-authorized credentials. */
  isConfigured(): boolean;
  respond(request: PlanningRequest): Promise<PlanningResponse>;
}

/**
 * The only assistant available today: the human in the chat.
 * Bridge therefore always routes requests to the user, and approval requests
 * are never auto-answered.
 */
export const humanAssistant: PlanningAssistant = {
  id: "human",
  label: "You",
  isConfigured: () => true,
  respond: async (request) => ({
    kind: "deferred-to-human",
    reason:
      request.kind === "approval-request"
        ? "Approval requests always go to the user."
        : "No planning assistant is configured.",
  }),
};

export interface PlanningAssistantRegistry {
  active(): PlanningAssistant;
  list(): readonly PlanningAssistant[];
}

export function createRegistry(assistants: readonly PlanningAssistant[] = []): PlanningAssistantRegistry {
  const available = [humanAssistant, ...assistants];
  return {
    active: () => available.find((a) => a.id !== humanAssistant.id && a.isConfigured()) ?? humanAssistant,
    list: () => available,
  };
}

/**
 * Route a request to whichever assistant is active. Approval requests never leave
 * the human, regardless of what is registered.
 */
export async function dispatch(
  registry: PlanningAssistantRegistry,
  request: PlanningRequest,
): Promise<PlanningResponse> {
  if (request.kind === "approval-request") return humanAssistant.respond(request);
  return registry.active().respond(request);
}
