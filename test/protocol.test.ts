import { describe, expect, it } from "vitest";
import { MAX_PROMPT_LENGTH, parseInboundMessage } from "../src/webview/protocol";

describe("webview message validation", () => {
  it("accepts every supported no-argument message", () => {
    for (const type of [
      "ready",
      "connect",
      "disconnect",
      "newSession",
      "refreshSessions",
      "stop",
      "retry",
      "openSettings",
    ]) {
      const result = parseInboundMessage({ type });
      expect(result.ok, type).toBe(true);
    }
  });

  it("accepts a session selection with a real session id", () => {
    const result = parseInboundMessage({ type: "selectSession", sessionID: "ses_ebba23af5ffe" });
    expect(result).toEqual({ ok: true, message: { type: "selectSession", sessionID: "ses_ebba23af5ffe" } });
  });

  it("accepts a send with text and a request id", () => {
    const result = parseInboundMessage({ type: "send", text: "hello", requestID: "r1" });
    expect(result).toEqual({ ok: true, message: { type: "send", text: "hello", requestID: "r1" } });
  });

  it("accepts text at exactly the length limit", () => {
    const result = parseInboundMessage({
      type: "send",
      text: "a".repeat(MAX_PROMPT_LENGTH),
      requestID: "r1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects values that are not objects", () => {
    for (const value of [null, undefined, 42, "ready", true, [], () => undefined]) {
      expect(parseInboundMessage(value).ok).toBe(false);
    }
  });

  it("rejects a missing or non-string type", () => {
    expect(parseInboundMessage({}).ok).toBe(false);
    expect(parseInboundMessage({ type: 7 }).ok).toBe(false);
    expect(parseInboundMessage({ type: null }).ok).toBe(false);
  });

  it("rejects unknown message types", () => {
    const result = parseInboundMessage({ type: "runShellCommand" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown message type");
  });

  it("rejects a malformed session id", () => {
    for (const sessionID of ["", "1", "ses_", "msg_abc", "../../etc/passwd", "ses_ok;rm -rf /"]) {
      expect(parseInboundMessage({ type: "selectSession", sessionID }).ok, sessionID).toBe(false);
    }
  });

  it("rejects sends without usable text", () => {
    expect(parseInboundMessage({ type: "send", requestID: "r1" }).ok).toBe(false);
    expect(parseInboundMessage({ type: "send", text: 12, requestID: "r1" }).ok).toBe(false);
    expect(parseInboundMessage({ type: "send", text: "   \n\t ", requestID: "r1" }).ok).toBe(false);
    expect(parseInboundMessage({ type: "send", text: "ok" }).ok).toBe(false);
  });

  it("rejects oversized prompts", () => {
    const result = parseInboundMessage({
      type: "send",
      text: "a".repeat(MAX_PROMPT_LENGTH + 1),
      requestID: "r1",
    });
    expect(result.ok).toBe(false);
  });

  it("ignores extra fields rather than trusting them", () => {
    const result = parseInboundMessage({ type: "send", text: "hi", requestID: "r1", __proto__: { bad: true } });
    expect(result).toEqual({ ok: true, message: { type: "send", text: "hi", requestID: "r1" } });
  });
});
