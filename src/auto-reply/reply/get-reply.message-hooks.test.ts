import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import type { ApplyLinkUnderstandingResult } from "../../link-understanding/apply.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import type { MsgContext } from "../templating.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(
    async (..._args: unknown[]): Promise<ApplyMediaUnderstandingResult> => ({
      outputs: [],
      decisions: [],
      appliedImage: false,
      appliedAudio: false,
      appliedVideo: false,
      appliedFile: false,
    }),
  ),
  applyLinkUnderstanding: vi.fn(
    async (..._args: unknown[]): Promise<ApplyLinkUnderstandingResult> => ({
      outputs: [],
      urls: [],
    }),
  ),
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyCommonMocks();

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));
vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: mocks.resolveReplyDirectives,
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(async () => ({ kind: "reply" as const, reply: { text: "ok" } })),
}));
vi.mock("./session.js", () => ({
  initSessionState: mocks.initSessionState,
}));

const linkUnderstandingModule = await import("../../link-understanding/apply.js");
const mediaUnderstandingModule = await import("../../media-understanding/apply.js");
const getReplyDirectivesModule = await import("./get-reply-directives.js");
const getReplyInlineActionsModule = await import("./get-reply-inline-actions.js");
const getReplyRunModule = await import("./get-reply-run.js");
const sessionModule = await import("./session.js");
const { getReplyFromConfig } = await import("./get-reply.js");

async function collectMessageEvents(run: () => Promise<unknown>): Promise<InternalHookEvent[]> {
  const events: InternalHookEvent[] = [];
  registerInternalHook("message", (event) => {
    events.push(event);
  });
  await run();
  await Promise.resolve();
  return events;
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-100123",
    ChatType: "group",
    Body: "<media:audio>",
    BodyForAgent: "<media:audio>",
    RawBody: "<media:audio>",
    CommandBody: "<media:audio>",
    SessionKey: "agent:main:telegram:-100123",
    From: "telegram:user:42",
    To: "telegram:-100123",
    GroupChannel: "ops",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

describe("getReplyFromConfig message hooks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearInternalHooks();
    delete process.env.OPENCLAW_TEST_FAST;
    mocks.applyMediaUnderstanding.mockReset();
    mocks.applyLinkUnderstanding.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();

    mocks.applyMediaUnderstanding.mockImplementation(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Transcript = "voice transcript";
      ctx.Body = "[Audio]\nTranscript:\nvoice transcript";
      ctx.BodyForAgent = "[Audio]\nTranscript:\nvoice transcript";
      return {
        outputs: [],
        decisions: [],
        appliedImage: false,
        appliedAudio: true,
        appliedVideo: false,
        appliedFile: false,
      };
    });
    mocks.applyLinkUnderstanding.mockResolvedValue({ outputs: [], urls: [] });
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:-100123",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: true,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });

    vi.spyOn(mediaUnderstandingModule, "applyMediaUnderstanding").mockImplementation(
      mocks.applyMediaUnderstanding,
    );
    vi.spyOn(linkUnderstandingModule, "applyLinkUnderstanding").mockImplementation(
      mocks.applyLinkUnderstanding,
    );
    vi.spyOn(getReplyDirectivesModule, "resolveReplyDirectives").mockImplementation(
      mocks.resolveReplyDirectives,
    );
    vi.spyOn(getReplyInlineActionsModule, "handleInlineActions").mockResolvedValue({
      kind: "reply",
      reply: { text: "ok" },
    });
    vi.spyOn(getReplyRunModule, "runPreparedReply").mockResolvedValue(undefined);
    vi.spyOn(sessionModule, "initSessionState").mockImplementation(mocks.initSessionState);
  });

  it("emits transcribed + preprocessed hooks with enriched context", async () => {
    const events = await collectMessageEvents(() =>
      getReplyFromConfig(
        buildCtx({
          Transcript: "voice transcript",
          Body: "[Audio]\nTranscript:\nvoice transcript",
          BodyForAgent: "[Audio]\nTranscript:\nvoice transcript",
        }),
        undefined,
        {},
      ),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "message",
        action: "transcribed",
        sessionKey: "agent:main:telegram:-100123",
        context: expect.objectContaining({
          transcript: "voice transcript",
          channelId: "telegram",
          conversationId: "telegram:-100123",
        }),
      }),
    );
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "message",
        action: "preprocessed",
        sessionKey: "agent:main:telegram:-100123",
        context: expect.objectContaining({
          transcript: "voice transcript",
          isGroup: true,
          groupId: "telegram:-100123",
        }),
      }),
    );
  });

  it("emits only preprocessed when no transcript is produced", async () => {
    const events = await collectMessageEvents(() =>
      getReplyFromConfig(
        buildCtx({
          Transcript: undefined,
          Body: "plain inbound text",
          BodyForAgent: "plain inbound text",
        }),
        undefined,
        {},
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "message",
        action: "preprocessed",
        sessionKey: "agent:main:telegram:-100123",
      }),
    );
  });

  it("skips message hooks in fast test mode", async () => {
    process.env.OPENCLAW_TEST_FAST = "1";

    const events = await collectMessageEvents(() => getReplyFromConfig(buildCtx(), undefined, {}));

    expect(events).toHaveLength(0);
  });

  it("skips message hooks when SessionKey is unavailable", async () => {
    const events = await collectMessageEvents(() =>
      getReplyFromConfig(buildCtx({ SessionKey: undefined }), undefined, {}),
    );

    expect(events).toHaveLength(0);
  });
});
