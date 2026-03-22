import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import quartermasterIngestPlugin from "./index.js";

function createLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "quartermaster-ingest",
    name: "Quartermaster Ingest",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: {
      baseUrl: "https://qmflow.test",
      token: "token",
      accountId: "quartermaster",
      timeoutMs: 8000,
    },
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: createLogger(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    resolvePath: vi.fn((input: string) => input),
    on: vi.fn(),
    ...overrides,
  };
}

function resolveSingleTool(tool: ReturnType<ReturnType<typeof registerPlugin>["toolFactory"]>): {
  execute: (toolCallId: string, input: Record<string, unknown>) => Promise<unknown>;
} {
  if (!tool || Array.isArray(tool)) {
    throw new Error("quartermaster_ingest expected a single registered tool");
  }
  return tool as unknown as {
    execute: (toolCallId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
}

async function createAgentDir(): Promise<{ root: string; agentDir: string; sessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "quartermaster-ingest-"));
  const agentDir = path.join(root, "agents", "quartermaster", "agent");
  const sessionsDir = path.join(root, "agents", "quartermaster", "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  return {
    root,
    agentDir,
    sessionId: "session-1",
  };
}

async function writeSessionFixtures(params: {
  agentDir: string;
  sessionId: string;
  transcriptText: string;
  sessionStoreTo?: string;
}): Promise<void> {
  const sessionsDir = path.join(path.dirname(params.agentDir), "sessions");
  const sessionFile = path.join(sessionsDir, `${params.sessionId}.jsonl`);
  const sessionsStore = path.join(sessionsDir, "sessions.json");
  const transcriptLines = [
    JSON.stringify({ type: "session", id: params.sessionId }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: params.transcriptText }],
      },
    }),
  ].join("\n");
  await writeFile(sessionFile, transcriptLines, "utf8");
  await writeFile(
    sessionsStore,
    JSON.stringify({
      "agent:quartermaster:main": {
        sessionId: params.sessionId,
        origin: { to: params.sessionStoreTo },
        deliveryContext: { to: params.sessionStoreTo },
        lastTo: params.sessionStoreTo,
      },
    }),
    "utf8",
  );
}

function registerPlugin(api: OpenClawPluginApi) {
  quartermasterIngestPlugin.register?.(api);
  const registerTool = vi.mocked(api.registerTool);
  const toolFactory = registerTool.mock.calls[0]?.[0];
  if (typeof toolFactory !== "function") {
    throw new Error("quartermaster_ingest tool factory was not registered");
  }
  const inboundClaimHandler = vi
    .mocked(api.on)
    .mock.calls.find(([name]) => name === "inbound_claim")?.[1];
  return {
    toolFactory,
    inboundClaimHandler,
  };
}

describe("quartermaster ingest", () => {
  it("resolves the current telegram request from the transcript when no capture exists", async () => {
    const api = createApi();
    const { toolFactory } = registerPlugin(api);
    const { agentDir, sessionId } = await createAgentDir();

    await writeSessionFixtures({
      agentDir,
      sessionId,
      sessionStoreTo: "telegram:7900032257",
      transcriptText: `[media attached: /tmp/paper-towels.jpg (image/jpeg) | /tmp/paper-towels.jpg]
Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "232",
  "sender_id": "7900032257",
  "sender": "Justin"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "id": "7900032257",
  "name": "Justin",
  "username": "jm24zm18"
}
\`\`\`

add paper towels to autumn woods shopping list`,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true, replyText: "Added paper towels." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = toolFactory({
      agentId: "quartermaster",
      messageChannel: "telegram",
      agentAccountId: "quartermaster",
      requesterSenderId: "7900032257",
      agentDir,
      sessionId,
    });
    const result = (await resolveSingleTool(tool).execute("tool-call-1", {})) as {
      details: Record<string, unknown>;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      accountId: "quartermaster",
      chatId: "7900032257",
      messageId: "232",
      text: "add paper towels to autumn woods shopping list",
      user: {
        id: "7900032257",
        firstName: "Justin",
        username: "jm24zm18",
      },
      mediaReferences: [{ filePath: "/tmp/paper-towels.jpg" }],
    });
    expect(result.details).toMatchObject({ accepted: true, replyText: "Added paper towels." });
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("quartermaster_ingest resolution=transcript"),
    );
  });

  it("falls back to the capture map when transcript parsing fails", async () => {
    const api = createApi();
    const { toolFactory, inboundClaimHandler } = registerPlugin(api);
    const { agentDir, sessionId } = await createAgentDir();

    await writeSessionFixtures({
      agentDir,
      sessionId,
      sessionStoreTo: "telegram:7900032258",
      transcriptText: "plain text without injected metadata",
    });

    await inboundClaimHandler?.(
      {
        content: "ignored",
        body: "ignored",
        bodyForAgent: "add paper towels to autumn woods shopping list",
        prompt: "",
        channel: "telegram",
        senderName: "Justin",
        senderUsername: "jm24zm18",
        metadata: { mediaPath: "/tmp/capture.jpg" },
      } as never,
      {
        channelId: "telegram",
        accountId: "quartermaster",
        conversationId: "7900032258",
        senderId: "7900032258",
        messageId: "232",
      } as never,
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true, replyText: "Added paper towels." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = toolFactory({
      agentId: "quartermaster",
      messageChannel: "telegram",
      agentAccountId: "quartermaster",
      requesterSenderId: "7900032258",
      agentDir,
      sessionId,
    });
    await resolveSingleTool(tool).execute("tool-call-2", {});

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      chatId: "7900032258",
      messageId: "232",
      text: "add paper towels to autumn woods shopping list",
      mediaReferences: [{ filePath: "/tmp/capture.jpg" }],
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("quartermaster_ingest resolution=capture_fallback"),
    );
  });

  it("returns a clear failure when neither transcript nor capture can resolve the request", async () => {
    const api = createApi();
    const { toolFactory } = registerPlugin(api);
    const { agentDir, sessionId } = await createAgentDir();

    await writeSessionFixtures({
      agentDir,
      sessionId,
      sessionStoreTo: "telegram:7900032259",
      transcriptText: "plain text without injected metadata",
    });

    const tool = toolFactory({
      agentId: "quartermaster",
      messageChannel: "telegram",
      agentAccountId: "quartermaster",
      requesterSenderId: "7900032259",
      agentDir,
      sessionId,
    });

    await expect(resolveSingleTool(tool).execute("tool-call-3", {})).rejects.toThrow(
      "Quartermaster request resolution failed: transcript metadata is missing required Telegram identifiers, and no cached inbound capture was found.",
    );
  });
});
