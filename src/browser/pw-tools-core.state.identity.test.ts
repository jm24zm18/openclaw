import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  ensurePageState: vi.fn(),
  getPageForTargetId: vi.fn(async () => ({
    setViewportSize: vi.fn(async () => {}),
  })),
}));

const sendMock = vi.hoisted(() => vi.fn(async () => ({})));

const pageCdpMocks = vi.hoisted(() => ({
  withPageScopedCdpClient: vi.fn(
    async ({ fn }: { fn: (send: typeof sendMock) => Promise<void> }) => {
      await fn(sendMock);
    },
  ),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./pw-session.page-cdp.js", () => pageCdpMocks);

let applyManagedIdentityViaPlaywright: typeof import("./pw-tools-core.state.js").applyManagedIdentityViaPlaywright;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ applyManagedIdentityViaPlaywright } = await import("./pw-tools-core.state.js"));
});

describe("applyManagedIdentityViaPlaywright", () => {
  it("applies configured identity overrides deterministically", async () => {
    await applyManagedIdentityViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "target-1",
      identity: {
        mode: "custom",
        userAgent: "Mozilla/5.0 Test",
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
        acceptLanguage: "en-US,en",
        windowSize: { width: 1440, height: 900 },
      },
    });

    const page = await sessionMocks.getPageForTargetId.mock.results[0]?.value;
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1440, height: 900 });
    expect(sendMock).toHaveBeenCalledWith("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 Test",
      acceptLanguage: "en-US,en",
    });
    expect(sendMock).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-US" });
    expect(sendMock).toHaveBeenCalledWith("Emulation.setTimezoneOverride", {
      timezoneId: "America/Los_Angeles",
    });
  });

  it("installs stealth script when stealth mode is enabled", async () => {
    await applyManagedIdentityViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "target-1",
      identity: {
        mode: "stealth",
        acceptLanguage: "en-US,en",
      },
    });

    expect(sendMock).toHaveBeenCalledWith(
      "Page.addScriptToEvaluateOnNewDocument",
      expect.objectContaining({
        source: expect.stringContaining("navigator"),
      }),
    );
    expect(sendMock).toHaveBeenCalledWith("Emulation.setUserAgentOverride", {
      userAgent: "",
      acceptLanguage: "en-US,en",
    });
  });
});
