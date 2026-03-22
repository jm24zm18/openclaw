import { devices as playwrightDevices } from "./automation.js";
import type { ResolvedBrowserIdentity } from "./config.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import { withPageScopedCdpClient } from "./pw-session.page-cdp.js";

function buildManagedStealthScript(identity: ResolvedBrowserIdentity): string {
  const languages = (() => {
    const raw = identity.acceptLanguage ?? identity.locale ?? "en-US,en";
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => JSON.stringify(part.split(";")[0]?.trim() || part))
      .join(", ");
  })();

  return `(() => {
  const define = (obj, key, getter) => {
    try {
      Object.defineProperty(obj, key, { configurable: true, enumerable: true, get: getter });
    } catch {}
  };
  define(navigator, "webdriver", () => undefined);
  define(navigator, "languages", () => [${languages}]);
  define(navigator, "deviceMemory", () => 8);
  define(navigator, "hardwareConcurrency", () => 4);
  define(navigator, "plugins", () => [1, 2, 3, 4, 5]);
  if (!window.chrome) {
    Object.defineProperty(window, "chrome", {
      configurable: true,
      enumerable: true,
      value: { runtime: {}, app: {}, csi() {}, loadTimes() {} },
    });
  }
  if (navigator.permissions?.query) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {
      if (parameters?.name === "notifications") {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery(parameters);
    };
  }
})();`;
}

export function resolveManagedIdentityPolicyKey(identity: ResolvedBrowserIdentity): string {
  return JSON.stringify({
    mode: identity.mode,
    userAgent: identity.userAgent ?? "",
    locale: identity.locale ?? "",
    timezoneId: identity.timezoneId ?? "",
    acceptLanguage: identity.acceptLanguage ?? "",
    windowSize: identity.windowSize ?? null,
  });
}

export async function applyManagedIdentityViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  identity: ResolvedBrowserIdentity;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);

  if (opts.identity.windowSize) {
    await page.setViewportSize({
      width: opts.identity.windowSize.width,
      height: opts.identity.windowSize.height,
    });
  }

  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      if (opts.identity.userAgent || opts.identity.acceptLanguage || opts.identity.locale) {
        await send("Emulation.setUserAgentOverride", {
          userAgent: opts.identity.userAgent ?? "",
          acceptLanguage: opts.identity.acceptLanguage ?? opts.identity.locale ?? undefined,
        });
      }
      if (opts.identity.locale) {
        await send("Emulation.setLocaleOverride", { locale: opts.identity.locale }).catch((err) => {
          if (!String(err).includes("Another locale override is already in effect")) {
            throw err;
          }
        });
      }
      if (opts.identity.timezoneId) {
        await send("Emulation.setTimezoneOverride", {
          timezoneId: opts.identity.timezoneId,
        }).catch((err) => {
          const msg = String(err);
          if (
            !msg.includes("Timezone override is already in effect") &&
            !msg.includes("Invalid timezone")
          ) {
            throw err;
          }
          if (msg.includes("Invalid timezone")) {
            throw new Error(`Invalid timezone ID: ${opts.identity.timezoneId}`, { cause: err });
          }
        });
      }
      if (opts.identity.windowSize) {
        await send("Emulation.setDeviceMetricsOverride", {
          mobile: false,
          width: opts.identity.windowSize.width,
          height: opts.identity.windowSize.height,
          deviceScaleFactor: 1,
          screenWidth: opts.identity.windowSize.width,
          screenHeight: opts.identity.windowSize.height,
        });
      }
      if (opts.identity.mode === "stealth") {
        await send("Page.addScriptToEvaluateOnNewDocument", {
          source: buildManagedStealthScript(opts.identity),
        });
      }
    },
  });
}

export async function setOfflineViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  offline: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().setOffline(Boolean(opts.offline));
}

export async function setExtraHTTPHeadersViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  headers: Record<string, string>;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().setExtraHTTPHeaders(opts.headers);
}

export async function setHttpCredentialsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  username?: string;
  password?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.clear) {
    await page.context().setHTTPCredentials(null);
    return;
  }
  const username = String(opts.username ?? "");
  const password = String(opts.password ?? "");
  if (!username) {
    throw new Error("username is required (or set clear=true)");
  }
  await page.context().setHTTPCredentials({ username, password });
}

export async function setGeolocationViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const context = page.context();
  if (opts.clear) {
    await context.setGeolocation(null);
    await context.clearPermissions().catch(() => {});
    return;
  }
  if (typeof opts.latitude !== "number" || typeof opts.longitude !== "number") {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  await context.setGeolocation({
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: typeof opts.accuracy === "number" ? opts.accuracy : undefined,
  });
  const origin =
    opts.origin?.trim() ||
    (() => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return "";
      }
    })();
  if (origin) {
    await context.grantPermissions(["geolocation"], { origin }).catch(() => {});
  }
}

export async function emulateMediaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  colorScheme: "dark" | "light" | "no-preference" | null;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.emulateMedia({ colorScheme: opts.colorScheme });
}

export async function setLocaleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  locale: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const locale = String(opts.locale ?? "").trim();
  if (!locale) {
    throw new Error("locale is required");
  }
  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      try {
        await send("Emulation.setLocaleOverride", { locale });
      } catch (err) {
        if (String(err).includes("Another locale override is already in effect")) {
          return;
        }
        throw err;
      }
    },
  });
}

export async function setTimezoneViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timezoneId: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const timezoneId = String(opts.timezoneId ?? "").trim();
  if (!timezoneId) {
    throw new Error("timezoneId is required");
  }
  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      try {
        await send("Emulation.setTimezoneOverride", { timezoneId });
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Timezone override is already in effect")) {
          return;
        }
        if (msg.includes("Invalid timezone")) {
          throw new Error(`Invalid timezone ID: ${timezoneId}`, { cause: err });
        }
        throw err;
      }
    },
  });
}

export async function setDeviceViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  name: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const name = String(opts.name ?? "").trim();
  if (!name) {
    throw new Error("device name is required");
  }
  const descriptor = (playwrightDevices as Record<string, unknown>)[name] as
    | {
        userAgent?: string;
        viewport?: { width: number; height: number };
        deviceScaleFactor?: number;
        isMobile?: boolean;
        hasTouch?: boolean;
        locale?: string;
      }
    | undefined;
  if (!descriptor) {
    throw new Error(`Unknown device "${name}".`);
  }

  if (descriptor.viewport) {
    await page.setViewportSize({
      width: descriptor.viewport.width,
      height: descriptor.viewport.height,
    });
  }

  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      if (descriptor.userAgent || descriptor.locale) {
        await send("Emulation.setUserAgentOverride", {
          userAgent: descriptor.userAgent ?? "",
          acceptLanguage: descriptor.locale ?? undefined,
        });
      }
      if (descriptor.viewport) {
        await send("Emulation.setDeviceMetricsOverride", {
          mobile: Boolean(descriptor.isMobile),
          width: descriptor.viewport.width,
          height: descriptor.viewport.height,
          deviceScaleFactor: descriptor.deviceScaleFactor ?? 1,
          screenWidth: descriptor.viewport.width,
          screenHeight: descriptor.viewport.height,
        });
      }
      if (descriptor.hasTouch) {
        await send("Emulation.setTouchEmulationEnabled", {
          enabled: true,
        });
      }
    },
  });
}
