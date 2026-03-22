import { describe, expect, it } from "vitest";
import {
  buildAgentToAgentAnnounceContext,
  isAnnounceSkip,
  isReplySkip,
  resolveRequireAnnounce,
} from "./sessions-send-helpers.js";

describe("sessions-send helper silent suppression", () => {
  it("treats NO_REPLY as announce skip", () => {
    expect(isAnnounceSkip("NO_REPLY")).toBe(true);
    expect(isAnnounceSkip("  NO_REPLY  ")).toBe(true);
  });

  it("treats NO_REPLY as reply skip", () => {
    expect(isReplySkip("NO_REPLY")).toBe(true);
    expect(isReplySkip("\nNO_REPLY\n")).toBe(true);
  });

  it("still honors explicit skip tokens", () => {
    expect(isAnnounceSkip("ANNOUNCE_SKIP")).toBe(true);
    expect(isReplySkip("REPLY_SKIP")).toBe(true);
  });

  it("does not suppress normal text", () => {
    expect(isAnnounceSkip("Got it — starting now.")).toBe(false);
    expect(isReplySkip("Working on it")).toBe(false);
  });

  it("builds a required announce prompt that forbids silent tokens", () => {
    const prompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: "agent:main:main",
      requesterChannel: "telegram",
      targetSessionKey: "agent:forge:main",
      targetChannel: "telegram",
      originalMessage: "Start the work.",
      roundOneReply: "Working on it.",
      latestReply: "Working on it.",
      requireAnnounce: true,
    });
    expect(prompt).toContain("A visible acknowledgement or handoff message is required");
    expect(prompt).toContain('Do not reply with "ANNOUNCE_SKIP" or "NO_REPLY"');
  });

  it("resolves requireAnnounce from config", () => {
    expect(resolveRequireAnnounce({ session: { agentToAgent: { requireAnnounce: true } } })).toBe(
      true,
    );
    expect(resolveRequireAnnounce({ session: { agentToAgent: {} } })).toBe(false);
    expect(resolveRequireAnnounce({})).toBe(false);
  });
});
