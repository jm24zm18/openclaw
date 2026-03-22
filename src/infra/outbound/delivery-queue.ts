import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { fetchRemoteMedia, MediaFetchError } from "../../media/fetch.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { SafeOpenError, readLocalFileSafely } from "../fs-safe.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_DIRNAME = "delivery-queue";
const FAILED_DIRNAME = "failed";
const MAX_RETRIES = 5;
const log = createSubsystemLogger("outbound/delivery-queue");
const BLOCKED_QUEUE_PREVIEW_LIMIT = 160;
const BLOCKED_LOW_ENTROPY_MESSAGE = "Blocked glitched outbound payload before queue persistence.";

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: OutboundMirror;
};

type QueueSanitizationReasonCode =
  | "leaked_reply_tag"
  | "repeated_dot_token"
  | "repeated_word_run"
  | "low_entropy_block"
  | "empty_after_sanitize";

type QueueSanitizationReason = {
  code: QueueSanitizationReasonCode;
  payloadIndex: number;
  preview: string;
};

type QueueSanitizationResult = {
  payloads: ReplyPayload[];
  reasons: QueueSanitizationReason[];
  blockedPayloadCount: number;
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
}

type MediaDeliveryFailureClass = "media_missing_local_file" | "media_fetch_failed";

export class MediaDeliveryPreparationError extends Error {
  readonly code: MediaDeliveryFailureClass;
  readonly details: Record<string, unknown>;

  constructor(
    code: MediaDeliveryFailureClass,
    message: string,
    details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaDeliveryPreparationError";
    this.code = code;
    this.details = details;
  }
}

export type RecoverySummary = {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
};

function buildQueuePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= BLOCKED_QUEUE_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, BLOCKED_QUEUE_PREVIEW_LIMIT - 1)}…`;
}

function detectBlockedQueuedTextReason(text: string): QueueSanitizationReasonCode | null {
  const testsCount = (text.match(/\btests\b/gi) || []).length;
  if (testsCount > 40) {
    return "low_entropy_block";
  }
  if (text.length <= 4_000) {
    return null;
  }
  const prefix = text.slice(0, 4_000);
  const unique = new Set(
    prefix
      .split(/\W+/)
      .filter(Boolean)
      .map((part) => part.toLowerCase()),
  );
  return unique.size < 80 ? "low_entropy_block" : null;
}

function sanitizeQueuedText(text: string): {
  text: string | null;
  reasonCodes: QueueSanitizationReasonCode[];
} {
  let sanitized = text;
  const reasonCodes: QueueSanitizationReasonCode[] = [];
  const leakedReplyTag = /^\s*\[\[(?!\s*(?:reply_to_current|reply_to\s*:))/i;
  if (leakedReplyTag.test(sanitized)) {
    sanitized = sanitized.replace(/^\s*\[\[[^\n]*?(?:\n|$)/, "").trimStart();
    reasonCodes.push("leaked_reply_tag");
  }
  const blockedReason = detectBlockedQueuedTextReason(sanitized);
  if (blockedReason) {
    reasonCodes.push(blockedReason);
    return { text: null, reasonCodes };
  }
  const repeatedDotToken = /(?:\b([A-Za-z_]{4,})\b)(?:\.\1\b){8,}/g;
  if (repeatedDotToken.test(sanitized)) {
    repeatedDotToken.lastIndex = 0;
    sanitized = sanitized.replace(repeatedDotToken, "$1");
    reasonCodes.push("repeated_dot_token");
  }
  const repeatedWordRun = /\b([A-Za-z_]{4,})\b(?:[.\s]+\1\b){12,}/g;
  if (repeatedWordRun.test(sanitized)) {
    repeatedWordRun.lastIndex = 0;
    sanitized = sanitized.replace(repeatedWordRun, "$1");
    reasonCodes.push("repeated_word_run");
  }
  if (sanitized.trim().length === 0) {
    reasonCodes.push("empty_after_sanitize");
    return { text: null, reasonCodes };
  }
  return { text: sanitized, reasonCodes };
}

function sanitizeQueuedPayloads(payloads: ReplyPayload[]): QueueSanitizationResult {
  const sanitizedPayloads: ReplyPayload[] = [];
  const reasons: QueueSanitizationReason[] = [];
  let blockedPayloadCount = 0;

  payloads.forEach((payload, payloadIndex) => {
    if (typeof payload.text !== "string") {
      sanitizedPayloads.push(payload);
      return;
    }

    const result = sanitizeQueuedText(payload.text);
    for (const code of result.reasonCodes) {
      reasons.push({
        code,
        payloadIndex,
        preview: buildQueuePreview(payload.text),
      });
    }

    if (result.text === null) {
      blockedPayloadCount += 1;
      return;
    }

    sanitizedPayloads.push({
      ...payload,
      text: result.text,
    });
  });

  return {
    payloads: sanitizedPayloads,
    reasons,
    blockedPayloadCount,
  };
}

function logQueueSanitizationEvent(
  params: Pick<QueuedDeliveryPayload, "channel" | "to" | "accountId">,
  result: QueueSanitizationResult,
): void {
  if (result.reasons.length === 0) {
    return;
  }

  const reasonCodes = Array.from(new Set(result.reasons.map((reason) => reason.code)));
  const previews = Array.from(new Set(result.reasons.map((reason) => reason.preview))).slice(0, 3);
  const payloadIndexes = Array.from(
    new Set(result.reasons.map((reason) => reason.payloadIndex)),
  ).toSorted((left, right) => left - right);
  const meta = {
    channel: params.channel,
    to: params.to,
    accountId: params.accountId ?? "default",
    reasonCodes,
    payloadIndexes,
    blockedPayloadCount: result.blockedPayloadCount,
    previewSamples: previews,
  };

  if (result.payloads.length === 0) {
    log.warn(BLOCKED_LOW_ENTROPY_MESSAGE, meta);
    return;
  }

  log.warn("Sanitized outbound payloads before queue persistence.", meta);
}

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), FAILED_DIRNAME);
}

function resolveQueueMediaDir(stateDir?: string): string {
  return path.join(resolveQueueDir(stateDir), "media");
}

function resolveQueueEntryPaths(
  id: string,
  stateDir?: string,
): {
  jsonPath: string;
  deliveredPath: string;
} {
  const queueDir = resolveQueueDir(stateDir);
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
  };
}

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function isRemoteMediaUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveMediaUrls(payload: ReplyPayload): string[] {
  if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) {
    return payload.mediaUrls;
  }
  return payload.mediaUrl ? [payload.mediaUrl] : [];
}

async function writeStagedMedia(params: {
  queueMediaDir: string;
  originalSource: string;
  buffer: Buffer;
  fileNameHint?: string;
}): Promise<string> {
  const ext = path.extname(params.fileNameHint ?? params.originalSource);
  const safeBase = path
    .basename(params.fileNameHint ?? params.originalSource, ext)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 80);
  const fileName = `${safeBase || "media"}---${generateSecureUuid()}${ext || ""}`;
  const stagedPath = path.join(params.queueMediaDir, fileName);
  await fs.promises.mkdir(params.queueMediaDir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(stagedPath, params.buffer, { mode: 0o600 });
  return stagedPath;
}

async function stageSingleMediaSource(source: string, stateDir?: string): Promise<string> {
  const queueMediaDir = resolveQueueMediaDir(stateDir);
  if (source.startsWith(`${queueMediaDir}${path.sep}`)) {
    return source;
  }
  if (isRemoteMediaUrl(source)) {
    try {
      const fetched = await fetchRemoteMedia({
        url: source,
        maxBytes: MEDIA_MAX_BYTES,
        filePathHint: source,
      });
      return await writeStagedMedia({
        queueMediaDir,
        originalSource: source,
        buffer: fetched.buffer,
        fileNameHint: fetched.fileName,
      });
    } catch (err) {
      if (err instanceof MediaFetchError) {
        throw new MediaDeliveryPreparationError(
          "media_fetch_failed",
          `media fetch failed for ${source}: ${err.message}`,
          {
            sourcePath: source,
            stagedPath: null,
            producingSubsystem: "outbound-delivery",
            sourceType: "fetched_remote_media",
          },
          { cause: err },
        );
      }
      throw err;
    }
  }

  try {
    const local = await readLocalFileSafely({ filePath: source, maxBytes: MEDIA_MAX_BYTES });
    return await writeStagedMedia({
      queueMediaDir,
      originalSource: source,
      buffer: local.buffer,
      fileNameHint: path.basename(local.realPath),
    });
  } catch (err) {
    if (err instanceof SafeOpenError) {
      throw new MediaDeliveryPreparationError(
        "media_missing_local_file",
        `media local file is missing or unreadable: ${source}`,
        {
          sourcePath: source,
          stagedPath: null,
          producingSubsystem: "outbound-delivery",
          sourceType: "local_file",
        },
        { cause: err },
      );
    }
    throw err;
  }
}

export async function preparePayloadsForDelivery(
  payloads: readonly ReplyPayload[],
  stateDir?: string,
): Promise<ReplyPayload[]> {
  const prepared: ReplyPayload[] = [];
  for (const payload of payloads) {
    const mediaUrls = resolveMediaUrls(payload);
    if (mediaUrls.length === 0) {
      prepared.push(payload);
      continue;
    }
    const stagedMediaUrls: string[] = [];
    for (const mediaUrl of mediaUrls) {
      stagedMediaUrls.push(await stageSingleMediaSource(mediaUrl, stateDir));
    }
    prepared.push({
      ...payload,
      mediaUrls: stagedMediaUrls,
      mediaUrl: stagedMediaUrls.length === 1 ? stagedMediaUrls[0] : undefined,
    });
  }
  return prepared;
}

async function cleanupStagedMediaFiles(
  payloads: readonly ReplyPayload[] | undefined,
  stateDir?: string,
) {
  const queueMediaDir = resolveQueueMediaDir(stateDir);
  const queueMediaDirPrefix = `${queueMediaDir}${path.sep}`;
  for (const payload of payloads ?? []) {
    for (const mediaUrl of resolveMediaUrls(payload)) {
      const trimmed = mediaUrl.trim();
      if (!trimmed.startsWith(queueMediaDirPrefix)) {
        continue;
      }
      await unlinkBestEffort(trimmed);
    }
  }
}

async function unlinkBestEffort(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

/** Ensure the queue directory (and failed/ subdirectory) exist. */
export async function ensureQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveQueueMediaDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
type QueuedDeliveryParams = QueuedDeliveryPayload;

export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureQueueDir(stateDir);
  const id = generateSecureUuid();
  const sanitization = sanitizeQueuedPayloads(params.payloads);
  logQueueSanitizationEvent(params, sanitization);
  if (sanitization.payloads.length === 0) {
    return id;
  }
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: sanitization.payloads,
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mirror: params.mirror,
    retryCount: 0,
  };
  const filePath = path.join(queueDir, `${id}.json`);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const json = JSON.stringify(entry, null, 2);
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
  return id;
}

/** Remove a successfully delivered entry from the queue.
 *
 * Uses a two-phase approach so that a crash between delivery and cleanup
 * does not cause the message to be replayed on the next recovery scan:
 *   Phase 1: atomic rename  {id}.json → {id}.delivered
 *   Phase 2: unlink the .delivered marker
 * If the process dies between phase 1 and phase 2 the marker is cleaned up
 * by {@link loadPendingDeliveries} on the next startup without re-sending.
 */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
  let payloadsForCleanup: ReplyPayload[] | undefined;
  try {
    const raw = await fs.promises.readFile(jsonPath, "utf-8");
    payloadsForCleanup = (JSON.parse(raw) as QueuedDelivery).payloads;
  } catch {
    // Best-effort cleanup only.
  }
  try {
    // Phase 1: atomic rename marks the delivery as complete.
    await fs.promises.rename(jsonPath, deliveredPath);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      // .json already gone — may have been renamed by a previous ack attempt.
      // Try to clean up a leftover .delivered marker if present.
      await unlinkBestEffort(deliveredPath);
      return;
    }
    throw err;
  }
  // Phase 2: remove the marker file.
  await unlinkBestEffort(deliveredPath);
  await cleanupStagedMediaFiles(payloadsForCleanup, stateDir);
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), `${id}.json`);
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const entry: QueuedDelivery = JSON.parse(raw);
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const queueDir = resolveQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  // Clean up .delivered markers left by ackDelivery if the process crashed
  // between the rename and the unlink.
  for (const file of files) {
    if (!file.endsWith(".delivered")) {
      continue;
    }
    await unlinkBestEffort(path.join(queueDir, file));
  }

  const entries: QueuedDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as QueuedDelivery;
      const { entry, migrated } = normalizeLegacyQueuedDeliveryEntry(parsed);
      if (migrated) {
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        await fs.promises.rename(tmp, filePath);
      }
      entries.push(entry);
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }
  return entries;
}

/** Move a queue entry to the failed/ subdirectory. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  const src = path.join(queueDir, `${id}.json`);
  const dest = path.join(failedDir, `${id}.json`);
  let payloadsForCleanup: ReplyPayload[] | undefined;
  try {
    const raw = await fs.promises.readFile(src, "utf-8");
    payloadsForCleanup = (JSON.parse(raw) as QueuedDelivery).payloads;
  } catch {
    // Best-effort cleanup only.
  }
  await fs.promises.rename(src, dest);
  await cleanupStagedMediaFiles(payloadsForCleanup, stateDir);
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export function isEntryEligibleForRecoveryRetry(
  entry: QueuedDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeBackoffMs(entry.retryCount + 1);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
    Number.isFinite(entry.lastAttemptAt) &&
    entry.lastAttemptAt > 0;
  const baseAttemptAt = hasAttemptTimestamp
    ? (entry.lastAttemptAt ?? entry.enqueuedAt)
    : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
}

function normalizeLegacyQueuedDeliveryEntry(entry: QueuedDelivery): {
  entry: QueuedDelivery;
  migrated: boolean;
} {
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
    Number.isFinite(entry.lastAttemptAt) &&
    entry.lastAttemptAt > 0;
  if (hasAttemptTimestamp || entry.retryCount <= 0) {
    return { entry, migrated: false };
  }
  const hasEnqueuedTimestamp =
    typeof entry.enqueuedAt === "number" &&
    Number.isFinite(entry.enqueuedAt) &&
    entry.enqueuedAt > 0;
  if (!hasEnqueuedTimestamp) {
    return { entry, migrated: false };
  }
  return {
    entry: {
      ...entry,
      lastAttemptAt: entry.enqueuedAt,
    },
    migrated: true,
  };
}

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryParams & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next restart. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<RecoverySummary> {
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
  }

  // Process oldest first.
  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);

  let recovered = 0;
  let failed = 0;
  let skippedMaxRetries = 0;
  let deferredBackoff = 0;

  for (const entry of pending) {
    const now = Date.now();
    if (now >= deadline) {
      const deferred = pending.length - recovered - failed - skippedMaxRetries - deferredBackoff;
      opts.log.warn(`Recovery time budget exceeded — ${deferred} entries deferred to next restart`);
      break;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — moving to failed/`,
      );
      try {
        await moveToFailed(entry.id, opts.stateDir);
      } catch (err) {
        opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
      }
      skippedMaxRetries += 1;
      continue;
    }

    const retryEligibility = isEntryEligibleForRecoveryRetry(entry, now);
    if (!retryEligibility.eligible) {
      deferredBackoff += 1;
      opts.log.info(
        `Delivery ${entry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
      );
      continue;
    }

    try {
      await opts.deliver({
        cfg: opts.cfg,
        channel: entry.channel,
        to: entry.to,
        accountId: entry.accountId,
        payloads: entry.payloads,
        threadId: entry.threadId,
        replyToId: entry.replyToId,
        bestEffort: entry.bestEffort,
        gifPlayback: entry.gifPlayback,
        forceDocument: entry.forceDocument,
        silent: entry.silent,
        mirror: entry.mirror,
        skipQueue: true, // Prevent re-enqueueing during recovery
      });
      await ackDelivery(entry.id, opts.stateDir);
      recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isPermanentDeliveryError(errMsg)) {
        opts.log.warn(`Delivery ${entry.id} hit permanent error — moving to failed/: ${errMsg}`);
        try {
          await moveToFailed(entry.id, opts.stateDir);
        } catch (moveErr) {
          opts.log.error(`Failed to move entry ${entry.id} to failed/: ${String(moveErr)}`);
        }
        failed += 1;
        continue;
      }
      try {
        await failDelivery(entry.id, errMsg, opts.stateDir);
      } catch {
        // Best-effort update.
      }
      failed += 1;
      opts.log.warn(`Retry failed for delivery ${entry.id}: ${errMsg}`);
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${recovered} recovered, ${failed} failed, ${skippedMaxRetries} skipped (max retries), ${deferredBackoff} deferred (backoff)`,
  );
  return { recovered, failed, skippedMaxRetries, deferredBackoff };
}

export { MAX_RETRIES };

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous discord recipient/i,
  /media local file is missing or unreadable/i,
  /media fetch failed/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}
