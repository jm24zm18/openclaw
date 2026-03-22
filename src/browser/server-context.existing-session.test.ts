import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chromeMcpMocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => true),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", url: "https://example.com", type: "page" },
  ]),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  openChromeMcpTab: vi.fn(async () => ({
    targetId: "8",
    title: "",
    url: "https://openclaw.ai",
    type: "page",
  })),
  closeChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
}));

vi.mock("./chrome-mcp.js", () => ({ ...chromeMcpMocks }));

import type { BrowserServerState } from "./server-context.js";
let createBrowserRouteContext: typeof import("./server-context.js").createBrowserRouteContext;
let chromeMcp: typeof import("./chrome-mcp.js");

function makeState(): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      evaluateEnabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      color: "#FF4500",
      headless: false,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome-live",
      identity: { mode: "default" },
      tabPolicy: { mode: "single" },
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
          userDataDir: "/tmp/brave-profile",
        },
      },
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    profiles: new Map(),
  };
}

beforeEach(async () => {
  vi.resetModules();
  ({ createBrowserRouteContext } = await import("./server-context.js"));
  chromeMcp = await import("./chrome-mcp.js");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("browser server-context existing-session profile", () => {
  it("routes tab operations through the Chrome MCP backend", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://openclaw.ai", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://openclaw.ai", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://openclaw.ai", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://openclaw.ai", type: "page" },
      ]);

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["7"]);

    const opened = await live.openTab("https://openclaw.ai");
    expect(opened.targetId).toBe("7");
    expect(chromeMcp.navigateChromeMcpPage).toHaveBeenCalledWith({
      profileName: "chrome-live",
      userDataDir: "/tmp/brave-profile",
      targetId: "7",
      url: "https://openclaw.ai",
    });

    const selected = await live.ensureTabAvailable();
    expect(selected.targetId).toBe("7");

    await live.focusTab("7");
    await live.stopRunningBrowser();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith("chrome-live", "/tmp/brave-profile");
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "7",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledWith("chrome-live");
  });

  it("reuses refreshed existing-session userDataDir after runtime state already exists", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    fs.mkdirSync("/tmp/brave-profile-updated", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    await live.ensureBrowserAvailable();
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenLastCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
    );

    state.resolved.profiles["chrome-live"] = {
      ...state.resolved.profiles["chrome-live"],
      userDataDir: "/tmp/brave-profile-updated",
    };

    await live.ensureBrowserAvailable();
    await live.listTabs();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenLastCalledWith(
      "chrome-live",
      "/tmp/brave-profile-updated",
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenLastCalledWith(
      "chrome-live",
      "/tmp/brave-profile-updated",
    );

    const runtime = state.profiles.get("chrome-live");
    expect(runtime?.lastTargetId).toBeNull();
  });
});
