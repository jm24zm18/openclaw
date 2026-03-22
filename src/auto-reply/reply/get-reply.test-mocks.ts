import { vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { CommandAuthorization } from "../command-auth.js";
import type { FinalizedMsgContext } from "../templating.js";

type DefaultModelResult = {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
};

type ResetModelResult = {
  selection?: unknown;
  cleanedBody?: string;
};

function createEmptyAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map(),
    byKey: new Map(),
  };
}

function createCommandAuthorization(): CommandAuthorization {
  return {
    isAuthorizedSender: true,
    ownerList: [],
    senderIsOwner: false,
  };
}

function finalizeMockContext<T extends Record<string, unknown>>(ctx: T): T & FinalizedMsgContext {
  return {
    ...ctx,
    CommandAuthorized: ctx.CommandAuthorized === true,
  } as T & FinalizedMsgContext;
}

const getReplyCommonMocks = vi.hoisted(() => {
  const resolveDefaultModel = (): DefaultModelResult => ({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: createEmptyAliasIndex(),
  });

  return {
    resolveAgentDir: vi.fn(() => "/tmp/agent"),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    resolveSessionAgentId: vi.fn(() => "main"),
    resolveAgentSkillsFilter: vi.fn(() => undefined),
    resolveModelRefFromString: vi.fn(() => null),
    resolveAgentTimeoutMs: vi.fn(() => 60000),
    ensureAgentWorkspace: vi.fn(async () => ({ dir: "/tmp/workspace" })),
    resolveChannelModelOverride: vi.fn(() => null),
    loadConfig: vi.fn(() => ({})),
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    resolveCommandAuthorization: vi.fn(() => createCommandAuthorization()),
    resolveDefaultModel: vi.fn(resolveDefaultModel),
    runPreparedReply: vi.fn(async () => undefined),
    finalizeInboundContext: vi.fn(<T extends Record<string, unknown>>(ctx: T) =>
      finalizeMockContext(ctx),
    ),
    applyResetModelOverride: vi.fn(async (): Promise<ResetModelResult> => ({})),
    stageSandboxMedia: vi.fn(async () => undefined),
    createTypingController: vi.fn(() => ({
      onReplyStart: async () => undefined,
      startTypingLoop: async () => undefined,
      startTypingOnText: async () => undefined,
      refreshTypingTtl: () => undefined,
      isActive: () => false,
      markRunComplete: () => undefined,
      markDispatchIdle: () => undefined,
      cleanup: () => undefined,
    })),
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: getReplyCommonMocks.resolveAgentDir,
  resolveAgentWorkspaceDir: getReplyCommonMocks.resolveAgentWorkspaceDir,
  resolveSessionAgentId: getReplyCommonMocks.resolveSessionAgentId,
  resolveAgentSkillsFilter: getReplyCommonMocks.resolveAgentSkillsFilter,
}));
vi.mock("../../agents/model-selection.js", () => ({
  resolveModelRefFromString: getReplyCommonMocks.resolveModelRefFromString,
}));
vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: getReplyCommonMocks.resolveAgentTimeoutMs,
}));
vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
  ensureAgentWorkspace: getReplyCommonMocks.ensureAgentWorkspace,
}));
vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: getReplyCommonMocks.resolveChannelModelOverride,
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: getReplyCommonMocks.loadConfig,
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: getReplyCommonMocks.log,
    error: getReplyCommonMocks.error,
    exit: getReplyCommonMocks.exit,
  },
}));
vi.mock("../command-auth.js", () => ({
  resolveCommandAuthorization: getReplyCommonMocks.resolveCommandAuthorization,
}));
vi.mock("./directive-handling.js", () => ({
  resolveDefaultModel: getReplyCommonMocks.resolveDefaultModel,
}));
vi.mock("./get-reply-run.js", () => ({
  runPreparedReply: getReplyCommonMocks.runPreparedReply,
}));
vi.mock("./inbound-context.js", () => ({
  finalizeInboundContext: getReplyCommonMocks.finalizeInboundContext,
}));
vi.mock("./session-reset-model.js", () => ({
  applyResetModelOverride: getReplyCommonMocks.applyResetModelOverride,
}));
vi.mock("./stage-sandbox-media.js", () => ({
  stageSandboxMedia: getReplyCommonMocks.stageSandboxMedia,
}));
vi.mock("./typing.js", () => ({
  createTypingController: getReplyCommonMocks.createTypingController,
}));

export function registerGetReplyCommonMocks(): void {
  return;
}
