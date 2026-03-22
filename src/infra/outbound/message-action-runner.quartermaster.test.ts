import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executeSendAction: mocks.executeSendAction,
  };
});

type MessageActionRunnerModule = typeof import("./message-action-runner.js");
type MessageActionRunnerTestHelpersModule =
  typeof import("./message-action-runner.test-helpers.js");

let runMessageAction: MessageActionRunnerModule["runMessageAction"];
let installMessageActionRunnerTestRegistry: MessageActionRunnerTestHelpersModule["installMessageActionRunnerTestRegistry"];
let resetMessageActionRunnerTestRegistry: MessageActionRunnerTestHelpersModule["resetMessageActionRunnerTestRegistry"];
let telegramConfig: MessageActionRunnerTestHelpersModule["telegramConfig"];

let stateDir: string;

function mockHandledSendAction() {
  mocks.executeSendAction.mockResolvedValue({
    handledBy: "plugin",
    payload: {},
  });
}

async function writeQuartermasterSession(params: { sessionKey: string; userTexts: string[] }) {
  const sessionsDir = path.join(stateDir, "agents", "quartermaster", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionId = "quartermaster-test-session";
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  const storePath = path.join(sessionsDir, "sessions.json");
  const now = Date.now();

  await fs.writeFile(
    storePath,
    JSON.stringify({
      [params.sessionKey]: {
        sessionId,
        updatedAt: now,
        sessionFile,
      },
    }),
    "utf-8",
  );

  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(now).toISOString(),
      cwd: "/tmp",
    }),
    ...params.userTexts.map((text, index) =>
      JSON.stringify({
        type: "message",
        id: `user-${index}`,
        timestamp: new Date(now + index).toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      }),
    ),
  ];
  await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");
}

async function runQuartermasterSend(params: {
  sessionKey: string;
  actionParams: Record<string, unknown>;
}) {
  await runMessageAction({
    cfg: telegramConfig,
    action: "send",
    params: params.actionParams as never,
    agentId: "quartermaster",
    sessionKey: params.sessionKey,
  });
  return mocks.executeSendAction.mock.calls[0]?.[0] as {
    message: string;
    mediaUrl?: string;
    mediaUrls?: string[];
  };
}

describe("Quartermaster shopping send policy", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ runMessageAction } = await import("./message-action-runner.js"));
    ({
      installMessageActionRunnerTestRegistry,
      resetMessageActionRunnerTestRegistry,
      telegramConfig,
    } = await import("./message-action-runner.test-helpers.js"));
    installMessageActionRunnerTestRegistry();
    mockHandledSendAction();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qm-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    resetMessageActionRunnerTestRegistry?.();
    mocks.executeSendAction.mockClear();
    delete process.env.OPENCLAW_STATE_DIR;
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rewrites image-only shopping sends to a blocked review response", async () => {
    const sessionKey = "agent:quartermaster:telegram:direct:7900032257";
    await writeQuartermasterSession({
      sessionKey,
      userTexts: ["Need Goodman pressure switch options with pics."],
    });

    const call = await runQuartermasterSend({
      sessionKey,
      actionParams: {
        channel: "telegram",
        target: "telegram:7900032257",
        media: "https://images.example.com/goodman-switch.jpg",
        caption: "Product image - Goodman pressure switch 0130F00479",
      },
    });

    expect(call.message).toContain("clean product image, price, and direct link");
    expect(call.mediaUrl).toBeUndefined();
    expect(call.mediaUrls).toBeUndefined();
  });

  it("blocks browser screenshots for shopping unless explicitly requested", async () => {
    const sessionKey = "agent:quartermaster:telegram:direct:7900032257";
    await writeQuartermasterSession({
      sessionKey,
      userTexts: ["Need Delta faucet options with pictures."],
    });

    const call = await runQuartermasterSend({
      sessionKey,
      actionParams: {
        channel: "telegram",
        target: "telegram:7900032257",
        media: "/home/justin/.openclaw/media/browser/delta-faucet.jpg",
        caption: "Page capture - Delta faucet option",
      },
    });

    expect(call.message).toContain("clean product image, price, and direct link");
    expect(call.mediaUrl).toBeUndefined();
    expect(call.mediaUrls).toBeUndefined();
  });

  it("allows explicit screenshot requests and labels them as screenshots", async () => {
    const sessionKey = "agent:quartermaster:telegram:direct:7900032257";
    await writeQuartermasterSession({
      sessionKey,
      userTexts: ["Send a screenshot of the product page for the Delta faucet."],
    });

    const call = await runQuartermasterSend({
      sessionKey,
      actionParams: {
        channel: "telegram",
        target: "telegram:7900032257",
        media: "/home/justin/.openclaw/media/browser/delta-faucet.jpg",
        caption: "Delta faucet page",
      },
    });

    expect(call.message).toMatch(/^Screenshot -|^Screenshot —/);
    expect(call.message).not.toContain("clean product image, price, and direct link");
  });

  it("passes through complete shopping replies with product image, price, and link", async () => {
    const sessionKey = "agent:quartermaster:telegram:direct:7900032257";
    await writeQuartermasterSession({
      sessionKey,
      userTexts: ["Need Goodman pressure switch options with pics."],
    });

    const call = await runQuartermasterSend({
      sessionKey,
      actionParams: {
        channel: "telegram",
        target: "telegram:7900032257",
        media: "https://images.example.com/goodman-switch.jpg",
        message:
          "Product image - Goodman pressure switch 0130F00479, HD Supply, $54.99 https://hdsupplysolutions.com/p/goodman-pressure-switch-0130f00479-p352012",
      },
    });

    expect(call.message).toContain("$54.99");
    expect(call.message).toContain(
      "https://hdsupplysolutions.com/p/goodman-pressure-switch-0130f00479-p352012",
    );
    expect(call.message).not.toContain("clean product image, price, and direct link");
  });
});
