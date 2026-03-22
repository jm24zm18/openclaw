import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveDefaultSessionStorePath,
  resolveSessionStoreEntry,
} from "../../config/sessions.js";
import { hasInteractiveReplyBlocks, hasReplyPayloadContent } from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { hasPollCreationParams } from "../../poll-params.js";
import { resolvePollMaxSelections } from "../../polls.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { type GatewayClientMode, type GatewayClientName } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import type { OutboundSendDeps } from "./deliver.js";
import { normalizeMessageActionInput } from "./message-action-normalization.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  parseButtonsParam,
  parseCardParam,
  parseComponentsParam,
  parseInteractiveParam,
  readBooleanParam,
  resolveAttachmentMediaPolicy,
} from "./message-action-params.js";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  type CrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import { executePollAction, executeSendAction } from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import { extractToolPayload } from "./tool-payload.js";

const log = createSubsystemLogger("outbound/message");
const QUARTERMASTER_AGENT_ID = "quartermaster";
const SCREENSHOT_MEDIA_SEGMENT = `${path.sep}media${path.sep}browser${path.sep}`;
const SCREENSHOT_REQUEST_RE =
  /\b(screenshot|screen ?shot|screen ?grab|page capture|page shot|capture the page|context image)\b/i;
const IMAGE_REQUEST_RE = /\b(pic|pics|picture|pictures|photo|photos|image|images)\b/i;
const SHOPPING_REQUEST_RE =
  /\b(find|need|looking for|buy|source|shop|shopping|lookup|look up|options|price|prices|link|links|product|products|part|parts|model|match|compatible)\b/i;
const DIRECT_URL_RE = /https?:\/\/\S+/i;
const PRICE_RE = /(?:\$|usd\s*)\d[\d,]*(?:\.\d{2})?/i;
const TITLE_RE = /[a-z0-9][a-z0-9 ."'()/#:+-]{8,}/i;
const BLOCKED_SHOPPING_REPLY =
  "I couldn't verify a shopping option with a clean product image, price, and direct link yet. Need review.";

type QuartermasterShoppingContext = {
  isShoppingRequest: boolean;
  explicitScreenshotRequest: boolean;
  explicitImageRequest: boolean;
};

function extractTextBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    if (type === "text" && typeof text === "string" && text.trim()) {
      texts.push(text);
    }
  }
  return texts;
}

function buildQuartermasterPromptContext(userTexts: string[]): QuartermasterShoppingContext {
  const combined = userTexts
    .filter((text) => !/A new session was started via \/new or \/reset/i.test(text))
    .join("\n");
  return {
    isShoppingRequest: SHOPPING_REQUEST_RE.test(combined),
    explicitScreenshotRequest: SCREENSHOT_REQUEST_RE.test(combined),
    explicitImageRequest: IMAGE_REQUEST_RE.test(combined),
  };
}

async function resolveQuartermasterShoppingContext(params: {
  agentId?: string;
  sessionKey?: string;
}): Promise<QuartermasterShoppingContext> {
  if (!params.sessionKey || normalizeAgentId(params.agentId) !== QUARTERMASTER_AGENT_ID) {
    return {
      isShoppingRequest: false,
      explicitScreenshotRequest: false,
      explicitImageRequest: false,
    };
  }

  try {
    const storePath = resolveDefaultSessionStorePath(params.agentId);
    const store = loadSessionStore(storePath, { skipCache: true });
    const { existing } = resolveSessionStoreEntry({
      store,
      sessionKey: params.sessionKey,
    });
    if (!existing?.sessionId) {
      return {
        isShoppingRequest: false,
        explicitScreenshotRequest: false,
        explicitImageRequest: false,
      };
    }

    const sessionFile =
      existing.sessionFile || path.join(path.dirname(storePath), `${existing.sessionId}.jsonl`);
    const raw = await fs.promises.readFile(sessionFile, "utf-8");
    const userTexts: string[] = [];
    for (const line of raw.split(/\r?\n/).toReversed()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (parsed.type !== "message" || parsed.message?.role !== "user") {
          continue;
        }
        const text = extractTextBlocks(parsed.message.content).join("\n").trim();
        if (!text) {
          continue;
        }
        userTexts.push(text);
        if (userTexts.length >= 3) {
          break;
        }
      } catch {
        continue;
      }
    }
    return buildQuartermasterPromptContext(userTexts.toReversed());
  } catch (err) {
    log.warn(`quartermaster shopping context resolution failed: ${String(err)}`);
    return {
      isShoppingRequest: false,
      explicitScreenshotRequest: false,
      explicitImageRequest: false,
    };
  }
}

function looksLikeScreenshotMedia(value?: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.includes(SCREENSHOT_MEDIA_SEGMENT) || /\/media\/browser\//i.test(trimmed);
}

function looksLikeShoppingResult(params: {
  message: string;
  caption: string;
  mediaUrls: string[];
}): boolean {
  const combined = [params.message, params.caption].filter(Boolean).join("\n");
  return Boolean(
    params.mediaUrls.length > 0 ||
    DIRECT_URL_RE.test(combined) ||
    PRICE_RE.test(combined) ||
    /\b(product image|price|option|match|vendor)\b/i.test(combined),
  );
}

function hasShoppingContract(text: string, mediaUrls: string[]): boolean {
  return (
    mediaUrls.length > 0 && DIRECT_URL_RE.test(text) && PRICE_RE.test(text) && TITLE_RE.test(text)
  );
}

async function applyQuartermasterShoppingPolicy(params: {
  agentId?: string;
  channel: ChannelId;
  sessionKey?: string;
  message: string;
  caption: string;
  mergedMediaUrls: string[];
  rawParams: Record<string, unknown>;
}): Promise<{
  message: string;
  mergedMediaUrls: string[];
}> {
  if (
    normalizeAgentId(params.agentId) !== QUARTERMASTER_AGENT_ID ||
    params.channel !== "telegram"
  ) {
    return {
      message: params.message,
      mergedMediaUrls: params.mergedMediaUrls,
    };
  }

  const promptContext = await resolveQuartermasterShoppingContext({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!promptContext.isShoppingRequest) {
    return {
      message: params.message,
      mergedMediaUrls: params.mergedMediaUrls,
    };
  }

  const hasScreenshotMedia = params.mergedMediaUrls.some((url) => looksLikeScreenshotMedia(url));
  let message = params.message;
  const combinedText = [params.message, params.caption].filter(Boolean).join("\n").trim();

  if (hasScreenshotMedia) {
    if (!promptContext.explicitScreenshotRequest) {
      log.warn(
        "blocked quartermaster screenshot shopping reply without explicit screenshot request",
      );
      delete params.rawParams.media;
      delete params.rawParams.path;
      delete params.rawParams.filePath;
      delete params.rawParams.caption;
      return {
        message: BLOCKED_SHOPPING_REPLY,
        mergedMediaUrls: [],
      };
    }
    if (!/\bscreenshot\b/i.test(combinedText)) {
      message = combinedText
        ? `Screenshot — ${combinedText}`
        : "Screenshot — requested page capture.";
    }
    return {
      message,
      mergedMediaUrls: params.mergedMediaUrls,
    };
  }

  if (
    !looksLikeShoppingResult({
      message: params.message,
      caption: params.caption,
      mediaUrls: params.mergedMediaUrls,
    })
  ) {
    return {
      message: params.message,
      mergedMediaUrls: params.mergedMediaUrls,
    };
  }

  if (!hasShoppingContract(combinedText, params.mergedMediaUrls)) {
    log.warn("blocked quartermaster incomplete shopping reply missing image/price/link contract");
    delete params.rawParams.media;
    delete params.rawParams.path;
    delete params.rawParams.filePath;
    delete params.rawParams.caption;
    return {
      message: BLOCKED_SHOPPING_REPLY,
      mergedMediaUrls: [],
    };
  }

  return {
    message: params.message,
    mergedMediaUrls: params.mergedMediaUrls,
  };
}

export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type RunMessageActionParams = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  requesterSenderId?: string | null;
  sessionId?: string;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  agentId?: string;
  sandboxRoot?: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
};

export type MessageActionRunResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "broadcast";
      channel: ChannelId;
      action: "broadcast";
      handledBy: "core" | "dry-run";
      payload: {
        results: Array<{
          channel: ChannelId;
          to: string;
          ok: boolean;
          error?: string;
          result?: MessageSendResult;
        }>;
      };
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
    };

export function getToolResult(
  result: MessageActionRunResult,
): AgentToolResult<unknown> | undefined {
  return "toolResult" in result ? result.toolResult : undefined;
}

function applyCrossContextMessageDecoration({
  params,
  message,
  decoration,
  preferComponents,
}: {
  params: Record<string, unknown>;
  message: string;
  decoration: CrossContextDecoration;
  preferComponents: boolean;
}): string {
  const applied = applyCrossContextDecoration({
    message,
    decoration,
    preferComponents,
  });
  params.message = applied.message;
  if (applied.componentsBuilder) {
    params.components = applied.componentsBuilder;
  }
  return applied.message;
}

async function maybeApplyCrossContextMarker(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  args: Record<string, unknown>;
  message: string;
  preferComponents: boolean;
}): Promise<string> {
  if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
    return params.message;
  }
  const decoration = await buildCrossContextDecoration({
    cfg: params.cfg,
    channel: params.channel,
    target: params.target,
    toolContext: params.toolContext,
    accountId: params.accountId ?? undefined,
  });
  if (!decoration) {
    return params.message;
  }
  return applyCrossContextMessageDecoration({
    params: params.args,
    message: params.message,
    decoration,
    preferComponents: params.preferComponents,
  });
}

async function resolveChannel(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  toolContext?: { currentChannelProvider?: string },
) {
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel: readStringParam(params, "channel"),
    fallbackChannel: toolContext?.currentChannelProvider,
  });
  if (selection.source === "tool-context-fallback") {
    params.channel = selection.channel;
  }
  return selection.channel;
}

async function resolveActionTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  const toRaw = typeof params.args.to === "string" ? params.args.to.trim() : "";
  if (toRaw) {
    const resolved = await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
    });
    if (resolved.ok) {
      params.args.to = resolved.target.to;
      resolvedTarget = resolved.target;
    } else {
      throw resolved.error;
    }
  }
  const channelIdRaw =
    typeof params.args.channelId === "string" ? params.args.channelId.trim() : "";
  if (channelIdRaw) {
    const resolved = await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: channelIdRaw,
      accountId: params.accountId ?? undefined,
      preferredKind: "group",
    });
    if (resolved.ok) {
      if (resolved.target.kind === "user") {
        throw new Error(`Channel id "${channelIdRaw}" resolved to a user target.`);
      }
      params.args.channelId = resolved.target.to.replace(/^(channel|group):/i, "");
    } else {
      throw resolved.error;
    }
  }
  return resolvedTarget;
}

type ResolvedActionContext = {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  channel: ChannelId;
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionRunnerGateway;
  input: RunMessageActionParams;
  agentId?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  abortSignal?: AbortSignal;
};
function resolveGateway(input: RunMessageActionParams): MessageActionRunnerGateway | undefined {
  if (!input.gateway) {
    return undefined;
  }
  return {
    url: input.gateway.url,
    token: input.gateway.token,
    timeoutMs: input.gateway.timeoutMs,
    clientName: input.gateway.clientName,
    clientDisplayName: input.gateway.clientDisplayName,
    mode: input.gateway.mode,
  };
}

async function handleBroadcastAction(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): Promise<MessageActionRunResult> {
  throwIfAborted(input.abortSignal);
  const broadcastEnabled = input.cfg.tools?.message?.broadcast?.enabled !== false;
  if (!broadcastEnabled) {
    throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
  }
  const rawTargets = readStringArrayParam(params, "targets", { required: true });
  if (rawTargets.length === 0) {
    throw new Error("Broadcast requires at least one target in --targets.");
  }
  const channelHint = readStringParam(params, "channel");
  const targetChannels =
    channelHint && channelHint.trim().toLowerCase() !== "all"
      ? [await resolveChannel(input.cfg, { channel: channelHint }, input.toolContext)]
      : await (async () => {
          const configured = await listConfiguredMessageChannels(input.cfg);
          if (configured.length === 0) {
            throw new Error("Broadcast requires at least one configured channel.");
          }
          return configured;
        })();
  const results: Array<{
    channel: ChannelId;
    to: string;
    ok: boolean;
    error?: string;
    result?: MessageSendResult;
  }> = [];
  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
  for (const targetChannel of targetChannels) {
    throwIfAborted(input.abortSignal);
    for (const target of rawTargets) {
      throwIfAborted(input.abortSignal);
      try {
        const resolved = await resolveChannelTarget({
          cfg: input.cfg,
          channel: targetChannel,
          input: target,
        });
        if (!resolved.ok) {
          throw resolved.error;
        }
        const sendResult = await runMessageAction({
          ...input,
          action: "send",
          params: {
            ...params,
            channel: targetChannel,
            target: resolved.target.to,
          },
        });
        results.push({
          channel: targetChannel,
          to: resolved.target.to,
          ok: true,
          result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        results.push({
          channel: targetChannel,
          to: target,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return {
    kind: "broadcast",
    channel: targetChannels[0] ?? "discord",
    action: "broadcast",
    handledBy: input.dryRun ? "dry-run" : "core",
    payload: { results },
    dryRun: Boolean(input.dryRun),
  };
}

async function handleSendAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const {
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    resolvedTarget,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "send";
  const to = readStringParam(params, "to", { required: true });
  // Support media, path, and filePath parameters for attachments
  const mediaHint =
    readStringParam(params, "media", { trim: false }) ??
    readStringParam(params, "path", { trim: false }) ??
    readStringParam(params, "filePath", { trim: false });
  const hasButtons = Array.isArray(params.buttons) && params.buttons.length > 0;
  const hasCard = params.card != null && typeof params.card === "object";
  const hasComponents = params.components != null && typeof params.components === "object";
  const hasInteractive = hasInteractiveReplyBlocks(params.interactive);
  const hasBlocks =
    (Array.isArray(params.blocks) && params.blocks.length > 0) ||
    (typeof params.blocks === "string" && params.blocks.trim().length > 0);
  const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
  let message =
    readStringParam(params, "message", {
      required:
        !mediaHint && !hasButtons && !hasCard && !hasComponents && !hasInteractive && !hasBlocks,
      allowEmpty: true,
    }) ?? "";
  if (message.includes("\\n")) {
    message = message.replaceAll("\\n", "\n");
  }
  if (!message.trim() && caption.trim()) {
    message = caption;
  }

  const parsed = parseReplyDirectives(message);
  const mergedMediaUrls: string[] = [];
  const seenMedia = new Set<string>();
  const pushMedia = (value?: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    if (seenMedia.has(trimmed)) {
      return;
    }
    seenMedia.add(trimmed);
    mergedMediaUrls.push(trimmed);
  };
  pushMedia(mediaHint);
  for (const url of parsed.mediaUrls ?? []) {
    pushMedia(url);
  }
  pushMedia(parsed.mediaUrl);

  const normalizedMediaUrls = await normalizeSandboxMediaList({
    values: mergedMediaUrls,
    sandboxRoot: input.sandboxRoot,
  });
  mergedMediaUrls.length = 0;
  mergedMediaUrls.push(...normalizedMediaUrls);

  message = parsed.text;
  params.message = message;
  if (!params.replyTo && parsed.replyToId) {
    params.replyTo = parsed.replyToId;
  }
  if (!params.media) {
    // Use path/filePath if media not set, then fall back to parsed directives
    params.media = mergedMediaUrls[0] || undefined;
  }

  const quartermasterPolicy = await applyQuartermasterShoppingPolicy({
    agentId,
    channel,
    sessionKey: input.sessionKey,
    message: parsed.text,
    caption,
    mergedMediaUrls,
    rawParams: params,
  });
  message = quartermasterPolicy.message;
  mergedMediaUrls.length = 0;
  mergedMediaUrls.push(...quartermasterPolicy.mergedMediaUrls);
  params.media = mergedMediaUrls[0] || undefined;
  message = await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    args: params,
    message,
    preferComponents: true,
  });

  const mediaUrl = readStringParam(params, "media", { trim: false });
  if (
    !hasReplyPayloadContent(
      {
        text: message,
        mediaUrl,
        mediaUrls: mergedMediaUrls,
        interactive: params.interactive,
      },
      {
        extraContent: hasButtons || hasCard || hasComponents || hasBlocks,
      },
    )
  ) {
    throw new Error("send requires text or media");
  }
  params.message = message;
  const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
  const forceDocument = readBooleanParam(params, "forceDocument") ?? false;
  const bestEffort = readBooleanParam(params, "bestEffort");
  const silent = readBooleanParam(params, "silent");

  const replyToId = readStringParam(params, "replyTo");
  const { resolvedThreadId, outboundRoute } = await prepareOutboundMirrorRoute({
    cfg,
    channel,
    to,
    actionParams: params,
    accountId,
    toolContext: input.toolContext,
    agentId,
    dryRun,
    resolvedTarget,
    resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
    resolveOutboundSessionRoute,
    ensureOutboundSessionEntry,
  });
  const mirrorMediaUrls =
    mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
  throwIfAborted(abortSignal);
  const send = await executeSendAction({
    ctx: {
      cfg,
      channel,
      params,
      agentId,
      accountId: accountId ?? undefined,
      gateway,
      toolContext: input.toolContext,
      deps: input.deps,
      dryRun,
      mirror:
        outboundRoute && !dryRun
          ? {
              sessionKey: outboundRoute.sessionKey,
              agentId,
              text: message,
              mediaUrls: mirrorMediaUrls,
            }
          : undefined,
      abortSignal,
      silent: silent ?? undefined,
    },
    to,
    message,
    mediaUrl: mediaUrl || undefined,
    mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
    gifPlayback,
    forceDocument,
    bestEffort: bestEffort ?? undefined,
    replyToId: replyToId ?? undefined,
    threadId: resolvedThreadId ?? undefined,
  });

  return {
    kind: "send",
    channel,
    action,
    to,
    handledBy: send.handledBy,
    payload: send.payload,
    toolResult: send.toolResult,
    sendResult: send.sendResult,
    dryRun,
  };
}

async function handlePollAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "poll";
  const to = readStringParam(params, "to", { required: true });
  const silent = readBooleanParam(params, "silent");

  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    cfg,
    to,
    accountId,
    toolContext: input.toolContext,
    resolveAutoThreadId: getChannelPlugin(channel)?.threading?.resolveAutoThreadId,
  });

  const base = typeof params.message === "string" ? params.message : "";
  await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    args: params,
    message: base,
    preferComponents: false,
  });

  const poll = await executePollAction({
    ctx: {
      cfg,
      channel,
      params,
      accountId: accountId ?? undefined,
      gateway,
      toolContext: input.toolContext,
      dryRun,
      silent: silent ?? undefined,
    },
    resolveCorePoll: () => {
      const question = readStringParam(params, "pollQuestion", {
        required: true,
      });
      const options = readStringArrayParam(params, "pollOption", { required: true });
      if (options.length < 2) {
        throw new Error("pollOption requires at least two values");
      }
      const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
      const durationHours = readNumberParam(params, "pollDurationHours", {
        integer: true,
        strict: true,
      });

      return {
        to,
        question,
        options,
        maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
        durationHours: durationHours ?? undefined,
        threadId: resolvedThreadId ?? undefined,
      };
    },
  });

  return {
    kind: "poll",
    channel,
    action,
    to,
    handledBy: poll.handledBy,
    payload: poll.payload,
    toolResult: poll.toolResult,
    pollResult: poll.pollResult,
    dryRun,
  };
}

async function handlePluginAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal, agentId } = ctx;
  throwIfAborted(abortSignal);
  const action = input.action as Exclude<ChannelMessageActionName, "send" | "poll" | "broadcast">;
  if (dryRun) {
    return {
      kind: "action",
      channel,
      action,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
      dryRun: true,
    };
  }

  const plugin = resolveOutboundChannelPlugin({ channel, cfg });
  if (!plugin?.actions?.handleAction) {
    throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
  }

  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    accountId: accountId ?? undefined,
    requesterSenderId: input.requesterSenderId ?? undefined,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    agentId,
    gateway,
    toolContext: input.toolContext,
    dryRun,
  });
  if (!handled) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  return {
    kind: "action",
    channel,
    action,
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
    dryRun,
  };
}

export async function runMessageAction(
  input: RunMessageActionParams,
): Promise<MessageActionRunResult> {
  const cfg = input.cfg;
  let params = { ...input.params };
  const resolvedAgentId =
    input.agentId ??
    (input.sessionKey
      ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
      : undefined);
  parseButtonsParam(params);
  parseCardParam(params);
  parseComponentsParam(params);
  parseInteractiveParam(params);

  const action = input.action;
  if (action === "broadcast") {
    return handleBroadcastAction(input, params);
  }
  params = normalizeMessageActionInput({
    action,
    args: params,
    toolContext: input.toolContext,
  });

  const channel = await resolveChannel(cfg, params, input.toolContext);
  let accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
  if (!accountId && resolvedAgentId) {
    const byAgent = buildChannelAccountBindings(cfg).get(channel);
    const boundAccountIds = byAgent?.get(normalizeAgentId(resolvedAgentId));
    if (boundAccountIds && boundAccountIds.length > 0) {
      accountId = boundAccountIds[0];
    }
  }
  if (accountId) {
    params.accountId = accountId;
  }
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, resolvedAgentId);
  const mediaPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    mediaLocalRoots,
  });

  await normalizeSandboxMediaParams({
    args: params,
    mediaPolicy,
  });

  await hydrateAttachmentParamsForAction({
    cfg,
    channel,
    accountId,
    args: params,
    action,
    dryRun,
    mediaPolicy,
  });

  const resolvedTarget = await resolveActionTarget({
    cfg,
    channel,
    action,
    args: params,
    accountId,
  });

  enforceCrossContextPolicy({
    channel,
    action,
    args: params,
    toolContext: input.toolContext,
    cfg,
  });

  if (action === "send" && hasPollCreationParams(params)) {
    throw new Error('Poll fields require action "poll"; use action "poll" instead of "send".');
  }

  const gateway = resolveGateway(input);

  if (action === "send") {
    return handleSendAction({
      cfg,
      params,
      channel,
      accountId,
      dryRun,
      gateway,
      input,
      agentId: resolvedAgentId,
      resolvedTarget,
      abortSignal: input.abortSignal,
    });
  }

  if (action === "poll") {
    return handlePollAction({
      cfg,
      params,
      channel,
      accountId,
      dryRun,
      gateway,
      input,
      abortSignal: input.abortSignal,
    });
  }

  return handlePluginAction({
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    agentId: resolvedAgentId,
    abortSignal: input.abortSignal,
  });
}
