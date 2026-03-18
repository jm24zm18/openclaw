import { describe, expect, it } from "vitest";
import { isAnnounceSkip, isReplySkip } from "./sessions-send-helpers.js";

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
});
