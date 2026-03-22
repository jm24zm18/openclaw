import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  buildAgentToAgentAnnounceContext,
  isAnnounceSkip,
  isReplySkip,
  resolveAnnounceTargetFromKey,
  resolveRequireAnnounce,
} from "./sessions-send-helpers.js";

describe("resolveAnnounceTargetFromKey", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            id: "discord",
            meta: {
              id: "discord",
              label: "Discord",
              selectionLabel: "Discord",
              docsPath: "/channels/discord",
              blurb: "Discord test stub.",
            },
            capabilities: { chatTypes: ["direct", "channel", "thread"] },
            messaging: {
              resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            id: "slack",
            meta: {
              id: "slack",
              label: "Slack",
              selectionLabel: "Slack",
              docsPath: "/channels/slack",
              blurb: "Slack test stub.",
            },
            capabilities: { chatTypes: ["direct", "channel", "thread"] },
            messaging: {
              resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: {
              id: "telegram",
              label: "Telegram",
              selectionLabel: "Telegram",
              docsPath: "/channels/telegram",
              blurb: "Telegram test stub.",
            },
            capabilities: { chatTypes: ["direct", "group", "thread"] },
            messaging: {
              normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );
  });

  it("lets plugins own session-derived target shapes", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:discord:group:dev")).toEqual({
      channel: "discord",
      to: "channel:dev",
      threadId: undefined,
    });
    expect(resolveAnnounceTargetFromKey("agent:main:slack:group:C123")).toEqual({
      channel: "slack",
      to: "channel:C123",
      threadId: undefined,
    });
  });

  it("keeps generic topic extraction and plugin normalization for other channels", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:telegram:group:-100123:topic:99")).toEqual({
      channel: "telegram",
      to: "-100123",
      threadId: "99",
    });
  });
});

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
