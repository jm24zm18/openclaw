import { readFile } from "node:fs/promises";
import path from "node:path";

type SessionTranscriptLine = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
    }>;
  };
};

type SessionStoreEntry = {
  sessionId?: unknown;
  origin?: {
    to?: unknown;
  };
  deliveryContext?: {
    to?: unknown;
  };
  lastTo?: unknown;
};

type ParsedConversationInfo = {
  message_id?: unknown;
  sender_id?: unknown;
  sender?: unknown;
  chat_id?: unknown;
};

type ParsedSenderInfo = {
  id?: unknown;
  name?: unknown;
  username?: unknown;
};

const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

const SENTINEL_FAST_RE = new RegExp(
  INBOUND_META_SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

export type ResolvedTranscriptRequest = {
  chatId: string;
  messageId: string;
  text: string;
  userId: string;
  senderName?: string;
  senderUsername?: string;
  mediaPath?: string;
};

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function stripInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }

  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) {
    return withoutTimestamp;
  }

  const lines = withoutTimestamp.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (const line of lines) {
    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      if (line.trim() === "") {
        continue;
      }
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function parseJsonBlock(text: string, sentinel: string): Record<string, unknown> | null {
  const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escapedSentinel}\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractMediaPath(text: string): string | undefined {
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\[media attached(?: \d+\/\d+)?: ([^\]|]+?)(?: \([^)]+\))?(?: \| [^\]]+)?\]$/,
    );
    const mediaPath = asTrimmedString(match?.[1]);
    if (mediaPath) {
      return mediaPath;
    }
  }
  return undefined;
}

function stripLeadingMediaNotes(text: string): string {
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (/^\[media attached(?::| \d+\/\d+:)/.test(line)) {
      index += 1;
      continue;
    }
    if (!line) {
      index += 1;
      continue;
    }
    break;
  }

  return lines.slice(index).join("\n").trim();
}

function parseTelegramTarget(value: unknown): string | undefined {
  const raw = asTrimmedString(value);
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/^telegram:(.+)$/i);
  return asTrimmedString(match?.[1] ?? raw);
}

function resolveSessionStoresPath(agentDir: string): string {
  return path.join(path.dirname(agentDir), "sessions", "sessions.json");
}

function resolveSessionTranscriptPath(agentDir: string, sessionId: string): string {
  return path.join(path.dirname(agentDir), "sessions", `${sessionId}.jsonl`);
}

async function readSessionEntry(
  agentDir: string,
  sessionId: string,
): Promise<SessionStoreEntry | null> {
  const storePath = resolveSessionStoresPath(agentDir);
  const raw = await readFile(storePath, "utf8");
  const parsed = JSON.parse(raw) as
    | Record<string, SessionStoreEntry>
    | { sessions?: SessionStoreEntry[] };
  if (Array.isArray((parsed as { sessions?: SessionStoreEntry[] }).sessions)) {
    return (
      (parsed as { sessions?: SessionStoreEntry[] }).sessions?.find(
        (entry) => asTrimmedString(entry?.sessionId) === sessionId,
      ) ?? null
    );
  }
  for (const entry of Object.values(parsed)) {
    if (asTrimmedString(entry?.sessionId) === sessionId) {
      return entry;
    }
  }
  return null;
}

function findLatestUserText(transcript: string): string | null {
  const lines = transcript.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    let parsed: SessionTranscriptLine;
    try {
      parsed = JSON.parse(line) as SessionTranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type !== "message" || parsed.message?.role !== "user") {
      continue;
    }
    const textPart = parsed.message.content?.find(
      (part) => part?.type === "text" && typeof part.text === "string",
    );
    const text = asTrimmedString(textPart?.text);
    if (text) {
      return text;
    }
  }
  return null;
}

export async function resolveTelegramRequestFromTranscript(params: {
  agentDir: string;
  sessionId: string;
}): Promise<ResolvedTranscriptRequest> {
  const transcriptPath = resolveSessionTranscriptPath(params.agentDir, params.sessionId);
  let transcriptRaw: string;
  try {
    transcriptRaw = await readFile(transcriptPath, "utf8");
  } catch (error) {
    throw new Error(`Quartermaster transcript unreadable: ${String(error)}`);
  }

  const latestUserText = findLatestUserText(transcriptRaw);
  if (!latestUserText) {
    throw new Error("Quartermaster transcript had no current user message.");
  }

  const conversationInfo = parseJsonBlock(
    latestUserText,
    "Conversation info (untrusted metadata):",
  ) as ParsedConversationInfo | null;
  const senderInfo = parseJsonBlock(
    latestUserText,
    "Sender (untrusted metadata):",
  ) as ParsedSenderInfo | null;

  const messageId = asTrimmedString(conversationInfo?.message_id);
  const userId = asTrimmedString(senderInfo?.id ?? conversationInfo?.sender_id);
  if (!messageId || !userId) {
    throw new Error("Quartermaster transcript metadata is missing required Telegram identifiers.");
  }

  const sessionEntry = await readSessionEntry(params.agentDir, params.sessionId).catch(() => null);
  const chatId =
    asTrimmedString(conversationInfo?.chat_id) ??
    parseTelegramTarget(sessionEntry?.origin?.to) ??
    parseTelegramTarget(sessionEntry?.deliveryContext?.to) ??
    parseTelegramTarget(sessionEntry?.lastTo) ??
    userId;

  const strippedText = stripLeadingMediaNotes(stripInboundMetadata(latestUserText));
  return {
    chatId,
    messageId,
    text: strippedText,
    userId,
    senderName: asTrimmedString(senderInfo?.name) ?? asTrimmedString(conversationInfo?.sender),
    senderUsername: asTrimmedString(senderInfo?.username),
    mediaPath: extractMediaPath(latestUserText),
  };
}
