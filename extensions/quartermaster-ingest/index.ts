import { Type } from "@sinclair/typebox";
import {
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveTelegramRequestFromTranscript,
  type ResolvedTranscriptRequest,
} from "./transcript-parser.js";

type QuartermasterIngestConfig = {
  baseUrl?: string;
  token?: string;
  accountId?: string;
  timeoutMs?: number;
};

type InboundClaimContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  messageId?: string;
};

type InboundClaimEvent = {
  content?: string;
  body?: string;
  bodyForAgent?: string;
  senderName?: string;
  senderUsername?: string;
  metadata?: {
    mediaPath?: string;
    mediaType?: string;
  };
};

type CapturedInboundClaim = {
  accountId: string;
  chatId: string;
  messageId: string;
  text: string;
  userId: string;
  senderName?: string;
  senderUsername?: string;
  mediaPath?: string;
  mediaType?: string;
  capturedAt: number;
};

type ResolvedRequestContext = {
  claim: CapturedInboundClaim;
  resolutionPath: "transcript" | "capture_fallback";
};

type QuartermasterIngestResponse = {
  accepted: boolean;
  replyText: string;
  requestId?: number;
  shoppingItemIds?: number[];
  installId?: number;
  needsFollowup?: boolean;
  rejectionReason?: string;
  rejectionNote?: string;
};

const CAPTURE_TTL_MS = 30 * 60 * 1000;
const capturedInboundBySender = new Map<string, CapturedInboundClaim>();

function now() {
  return Date.now();
}

function cleanupExpiredCaptures(referenceTime = now()): void {
  for (const [key, value] of capturedInboundBySender) {
    if (referenceTime - value.capturedAt > CAPTURE_TTL_MS) {
      capturedInboundBySender.delete(key);
    }
  }
}

function buildSenderKey(accountId: string, senderId: string): string {
  return `${accountId}:${senderId}`;
}

function resolvePluginConfig(api: OpenClawPluginApi): Required<QuartermasterIngestConfig> | null {
  const pluginCfg = (api.pluginConfig ?? {}) as QuartermasterIngestConfig;
  const baseUrl = (pluginCfg.baseUrl ?? process.env.QUARTERMASTER_FORWARD_BASE_URL ?? "").trim();
  const token = (pluginCfg.token ?? process.env.QUARTERMASTER_FORWARD_TOKEN ?? "").trim();
  const accountId = (
    pluginCfg.accountId ??
    process.env.QUARTERMASTER_FORWARD_ACCOUNT_ID ??
    "quartermaster"
  ).trim();
  const timeoutMs =
    typeof pluginCfg.timeoutMs === "number" && Number.isFinite(pluginCfg.timeoutMs)
      ? pluginCfg.timeoutMs
      : 8_000;

  if (!baseUrl || !token || !accountId) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token,
    accountId,
    timeoutMs,
  };
}

function captureInboundClaim(event: InboundClaimEvent, ctx: InboundClaimContext): void {
  if (ctx.channelId !== "telegram") {
    return;
  }
  if (!ctx.accountId || !ctx.senderId || !ctx.conversationId || !ctx.messageId) {
    return;
  }

  cleanupExpiredCaptures();

  capturedInboundBySender.set(buildSenderKey(ctx.accountId, ctx.senderId), {
    accountId: ctx.accountId,
    chatId: ctx.conversationId,
    messageId: ctx.messageId,
    text: (event.bodyForAgent ?? event.body ?? event.content ?? "").trim(),
    userId: ctx.senderId,
    senderName: event.senderName,
    senderUsername: event.senderUsername,
    mediaPath:
      typeof event.metadata?.mediaPath === "string" && event.metadata.mediaPath.trim()
        ? event.metadata.mediaPath.trim()
        : undefined,
    mediaType:
      typeof event.metadata?.mediaType === "string" && event.metadata.mediaType.trim()
        ? event.metadata.mediaType.trim()
        : undefined,
    capturedAt: now(),
  });
}

async function postStructuredIntake(
  cfg: Required<QuartermasterIngestConfig>,
  claim: CapturedInboundClaim,
): Promise<QuartermasterIngestResponse> {
  const mediaReferences =
    typeof claim.mediaPath === "string" && claim.mediaPath
      ? [
          {
            filePath: claim.mediaPath,
            caption: claim.text || undefined,
          },
        ]
      : undefined;

  const response = await fetch(`${cfg.baseUrl}/ingest/telegram`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      accountId: cfg.accountId,
      chatId: claim.chatId,
      messageId: claim.messageId,
      text: claim.text,
      user: {
        id: claim.userId,
        firstName: claim.senderName,
        username: claim.senderUsername,
      },
      mediaReferences,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  const body = (await response.json().catch(() => null)) as
    | (Partial<QuartermasterIngestResponse> & { error?: string })
    | null;

  if (!response.ok) {
    const errorMessage =
      body && typeof body === "object" && typeof body.error === "string"
        ? body.error
        : `Quartermaster ingest failed with ${response.status}`;
    throw new Error(errorMessage);
  }

  if (!body || typeof body !== "object" || typeof body.replyText !== "string") {
    throw new Error("Quartermaster ingest returned an invalid response payload.");
  }

  return body as QuartermasterIngestResponse;
}

function buildCapturedClaimFromTranscript(
  accountId: string,
  request: ResolvedTranscriptRequest,
): CapturedInboundClaim {
  return {
    accountId,
    chatId: request.chatId,
    messageId: request.messageId,
    text: request.text,
    userId: request.userId,
    senderName: request.senderName,
    senderUsername: request.senderUsername,
    mediaPath: request.mediaPath,
    capturedAt: now(),
  };
}

async function resolveRequestContext(params: {
  api: OpenClawPluginApi;
  accountId: string;
  senderId: string;
  agentDir?: string;
  sessionId?: string;
}): Promise<ResolvedRequestContext> {
  const agentDir = params.agentDir?.trim();
  const sessionId = params.sessionId?.trim();

  if (agentDir && sessionId) {
    try {
      const transcriptRequest = await resolveTelegramRequestFromTranscript({
        agentDir,
        sessionId,
      });
      return {
        claim: buildCapturedClaimFromTranscript(params.accountId, transcriptRequest),
        resolutionPath: "transcript",
      };
    } catch (error) {
      cleanupExpiredCaptures();
      const captured = capturedInboundBySender.get(
        buildSenderKey(params.accountId, params.senderId),
      );
      if (captured) {
        params.api.logger.info(
          `quartermaster_ingest transcript resolution failed; using capture_fallback (${String(error)})`,
        );
        return {
          claim: captured,
          resolutionPath: "capture_fallback",
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      if (/missing required Telegram identifiers/i.test(message)) {
        throw new Error(
          "Quartermaster request resolution failed: transcript metadata is missing required Telegram identifiers, and no cached inbound capture was found.",
        );
      }
      if (/no current user message/i.test(message)) {
        throw new Error(
          "Quartermaster request resolution failed: transcript had no current user message, and no cached inbound capture was found.",
        );
      }
      if (/transcript unreadable/i.test(message)) {
        throw new Error(
          `Quartermaster request resolution failed: ${message}, and no cached inbound capture was found.`,
        );
      }
      throw new Error(
        `Quartermaster request resolution failed: ${message}, and no cached inbound capture was found.`,
      );
    }
  }

  cleanupExpiredCaptures();
  const captured = capturedInboundBySender.get(buildSenderKey(params.accountId, params.senderId));
  if (!captured) {
    throw new Error(
      "Quartermaster request resolution failed: transcript context was unavailable and no cached inbound capture was found.",
    );
  }
  return {
    claim: captured,
    resolutionPath: "capture_fallback",
  };
}

function createQuartermasterIngestTool(
  api: OpenClawPluginApi,
  toolContext: {
    agentId?: string;
    messageChannel?: string;
    agentAccountId?: string;
    requesterSenderId?: string;
    agentDir?: string;
    sessionId?: string;
  },
): AnyAgentTool {
  return {
    name: "quartermaster_ingest",
    label: "Quartermaster Ingest",
    description:
      "Forward the current Telegram Quartermaster request to the public qmflow.com ingest API and return the authoritative reply contract. Use this before claiming a record was added, updated, closed, or corrected.",
    parameters: Type.Object({}),
    async execute() {
      const pluginCfg = resolvePluginConfig(api);
      if (!pluginCfg) {
        throw new Error("Quartermaster ingest plugin is missing baseUrl/token/accountId config.");
      }

      if (toolContext?.messageChannel !== "telegram") {
        throw new Error(
          "quartermaster_ingest is only available for Telegram-bound Quartermaster turns.",
        );
      }

      if (toolContext?.agentId !== "quartermaster") {
        throw new Error("quartermaster_ingest is restricted to the quartermaster agent.");
      }

      const senderId = toolContext?.requesterSenderId?.trim();
      const accountId = toolContext?.agentAccountId?.trim();
      if (!senderId || !accountId) {
        throw new Error("Missing Telegram sender/account context for Quartermaster ingest.");
      }

      const resolved = await resolveRequestContext({
        api,
        accountId,
        senderId,
        agentDir: toolContext.agentDir,
        sessionId: toolContext.sessionId,
      });
      api.logger.info(
        `quartermaster_ingest resolution=${resolved.resolutionPath} sender=${senderId}`,
      );

      let result: QuartermasterIngestResponse;
      try {
        result = await postStructuredIntake(pluginCfg, resolved.claim);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Quartermaster public ingest API failure: ${message}`);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: result,
      };
    },
  };
}

export default definePluginEntry({
  id: "quartermaster-ingest",
  name: "Quartermaster Ingest",
  description:
    "Optional tool that forwards Quartermaster Telegram intake to the public dashboard API.",
  register(api: OpenClawPluginApi) {
    api.on("inbound_claim", async (event, ctx) => {
      captureInboundClaim(event, ctx);
    });

    api.registerTool(
      ((ctx) => {
        if (ctx.agentId !== "quartermaster") {
          return null;
        }
        if (ctx.messageChannel !== "telegram") {
          return null;
        }
        return createQuartermasterIngestTool(api, ctx);
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );
  },
});
