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
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  emitResetCommandHooks: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyCommonMocks();

vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: vi.fn(
    async (): Promise<ApplyLinkUnderstandingResult> => ({
      outputs: [],
      urls: [],
    }),
  ),
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: vi.fn(
    async (): Promise<ApplyMediaUnderstandingResult> => ({
      outputs: [],
      decisions: [],
      appliedImage: false,
      appliedAudio: false,
      appliedVideo: false,
      appliedFile: false,
    }),
  ),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

const commandsCoreModule = await import("./commands-core.js");
const getReplyDirectivesModule = await import("./get-reply-directives.js");
const getReplyInlineActionsModule = await import("./get-reply-inline-actions.js");
const getReplyRunModule = await import("./get-reply-run.js");
const sessionModule = await import("./session.js");
const { getReplyFromConfig } = await import("./get-reply.js");

async function collectCommandEvents(run: () => Promise<unknown>): Promise<InternalHookEvent[]> {
  const events: InternalHookEvent[] = [];
  registerInternalHook("command", (event) => {
    events.push(event);
  });
  await run();
  await Promise.resolve();
  return events;
}

function buildNativeResetContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "/new",
    RawBody: "/new",
    CommandBody: "/new",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "telegram:slash:123",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    To: "slash:123",
  };
}

function createContinueDirectivesResult(resetHookTriggered: boolean) {
  return {
    kind: "continue" as const,
    result: {
      commandSource: "/new",
      command: {
        surface: "telegram",
        channel: "telegram",
        channelId: "telegram",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        senderId: "123",
        abortKey: "telegram:slash:123",
        rawBodyNormalized: "/new",
        commandBodyNormalized: "/new",
        from: "telegram:123",
        to: "slash:123",
        resetHookTriggered,
      },
      allowTextCommands: true,
      skillCommands: [],
      directives: {},
      cleanedBody: "/new",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      execOverrides: undefined,
      blockStreamingEnabled: false,
      blockReplyChunking: undefined,
      resolvedBlockStreamingBreak: undefined,
      provider: "openai",
      model: "gpt-4o-mini",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
      },
      contextTokens: 0,
      inlineStatusRequested: false,
      directiveAck: undefined,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
    },
  };
}

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearInternalHooks();
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.initSessionState.mockReset();

    mocks.initSessionState.mockResolvedValue({
      sessionCtx: buildNativeResetContext(),
      sessionEntry: {},
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      isNewSession: true,
      resetTriggered: true,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-sender",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "/new",
      bodyStripped: "",
    });

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(false));

    vi.spyOn(commandsCoreModule, "emitResetCommandHooks").mockImplementation(
      mocks.emitResetCommandHooks,
    );
    vi.spyOn(getReplyDirectivesModule, "resolveReplyDirectives").mockImplementation(
      mocks.resolveReplyDirectives,
    );
    vi.spyOn(getReplyInlineActionsModule, "handleInlineActions").mockImplementation(
      mocks.handleInlineActions,
    );
    vi.spyOn(getReplyRunModule, "runPreparedReply").mockResolvedValue(undefined);
    vi.spyOn(sessionModule, "initSessionState").mockImplementation(mocks.initSessionState);
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    const events = await collectCommandEvents(() =>
      getReplyFromConfig(buildNativeResetContext(), undefined, {}),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "command",
        action: "new",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    ]);
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    const events = await collectCommandEvents(() =>
      getReplyFromConfig(buildNativeResetContext(), undefined, {}),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "command",
        action: "new",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    ]);
  });
});
