import { describe, expect, it, vi } from "vitest";
import {
  createRegistry,
  dispatch,
  humanAssistant,
  type PlanningAssistant,
  type PlanningRequest,
} from "../src/providers/adapter";

function assistant(id: string, overrides: Partial<PlanningAssistant> = {}): PlanningAssistant {
  return {
    id,
    label: id,
    isConfigured: () => true,
    respond: async () => ({ kind: "deferred-to-human", reason: "not needed" }),
    ...overrides,
  };
}

const approval: PlanningRequest = {
  kind: "approval-request",
  summary: "Run the test suite?",
  sessionID: "ses_test1",
  detail: "npm test",
};

const question: PlanningRequest = {
  kind: "technical-question",
  question: "Which file should change?",
  sessionID: "ses_test1",
};

describe("planning assistant boundary", () => {
  it("delegates to the human when no planning assistant is configured", async () => {
    const response = await dispatch(createRegistry(), question);

    expect(response).toEqual({ kind: "deferred-to-human", reason: "No planning assistant is configured." });
  });

  it("never auto-answers an approval request, even with a configured assistant", async () => {
    const respond = vi.fn(async () => ({ kind: "answered", text: "yes, go ahead", by: "planner" }) as const);
    const registry = createRegistry([assistant("planner", { respond })]);

    const response = await dispatch(registry, approval);

    expect(respond).not.toHaveBeenCalled();
    expect(response).toEqual({ kind: "deferred-to-human", reason: "Approval requests always go to the user." });
  });

  it("routes a question to a configured assistant and skips unconfigured ones", async () => {
    const respond = vi.fn(async () => ({ kind: "answered", text: "use X", by: "planner" }) as const);
    const registry = createRegistry([
      assistant("no-credentials", { isConfigured: () => false, respond: vi.fn() }),
      assistant("planner", { respond }),
    ]);

    expect(registry.active().id).toBe("planner");
    const response = await dispatch(registry, question);

    expect(respond).toHaveBeenCalledWith(question);
    expect(response).toEqual({ kind: "answered", text: "use X", by: "planner" });
  });

  it("falls back to the human when every registered assistant lacks credentials", () => {
    const registry = createRegistry([assistant("no-credentials", { isConfigured: () => false })]);

    expect(registry.active()).toBe(humanAssistant);
    expect(registry.list()).toHaveLength(2);
  });
});
