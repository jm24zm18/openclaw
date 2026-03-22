import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { BrowserServerState } from "./server-context.js";

const chromeMocks = vi.hoisted(() => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async (): Promise<RunningChrome> => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

vi.mock("./chrome.js", () => ({
  ...chromeMocks,
}));

let createBrowserRouteContext: typeof import("./server-context.js").createBrowserRouteContext;

function makeBrowserState(): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18810,
      evaluateEnabled: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      defaultProfile: "openclaw",
      identity: { mode: "default" },
      tabPolicy: { mode: "single" },
      profiles: {
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

function mockLaunchedChrome(
  launchOpenClawChrome: typeof chromeMocks.launchOpenClawChrome,
  pid: number,
) {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  launchOpenClawChrome.mockResolvedValue({
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: "/tmp/openclaw-test",
    cdpPort: 18800,
    startedAt: Date.now(),
    proc,
  });
}

function setupEnsureBrowserAvailableHarness() {
  vi.useFakeTimers();
  chromeMocks.isChromeReachable.mockResolvedValue(false);

  const state = makeBrowserState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("openclaw");

  return {
    launchOpenClawChrome: chromeMocks.launchOpenClawChrome,
    stopOpenClawChrome: chromeMocks.stopOpenClawChrome,
    isChromeReachable: chromeMocks.isChromeReachable,
    isChromeCdpReady: chromeMocks.isChromeCdpReady,
    profile,
  };
}

beforeEach(async () => {
  vi.resetModules();
  chromeMocks.isChromeCdpReady.mockReset().mockResolvedValue(true);
  chromeMocks.isChromeReachable.mockReset().mockResolvedValue(true);
  chromeMocks.launchOpenClawChrome.mockReset().mockImplementation(async () => {
    throw new Error("unexpected launch");
  });
  chromeMocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
  ({ createBrowserRouteContext } = await import("./server-context.js"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("waits for CDP readiness after launching to avoid follow-up PortInUseError races (#21149)", async () => {
    const {
      launchOpenClawChrome,
      stopOpenClawChrome,
      isChromeReachable,
      isChromeCdpReady,
      profile,
    } = setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockLaunchedChrome(launchOpenClawChrome, 123);

    const promise = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();

    expect(isChromeReachable).toHaveBeenCalled();
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const {
      launchOpenClawChrome,
      stopOpenClawChrome,
      isChromeReachable,
      isChromeCdpReady,
      profile,
    } = setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(false);
    mockLaunchedChrome(launchOpenClawChrome, 321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    await vi.advanceTimersByTimeAsync(8100);
    await rejected;

    expect(isChromeReachable).toHaveBeenCalled();
    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
  });
});
