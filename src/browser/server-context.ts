import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import { BrowserProfileNotFoundError, toBrowserErrorResponse } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export function listKnownProfileNames(state: BrowserServerState): string[] {
  const names = new Set(Object.keys(state.resolved.profiles));
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    if (!profileState) {
      profileState = {
        profile,
        running: null,
        lastTargetId: null,
        managedTabs: new Map(),
        pendingOpens: new Map(),
        reconcile: null,
      };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  const getLiveProfile = (): ResolvedBrowserProfile => {
    const current = state();
    const resolvedProfile = resolveProfile(current.resolved, profile.name);
    const profileState = getProfileState();
    if (resolvedProfile) {
      profileState.profile = resolvedProfile;
      return resolvedProfile;
    }
    return profileState.profile;
  };

  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  const applyManagedIdentity = async (targetId?: string) => {
    const liveProfile = getLiveProfile();
    const capabilities = getBrowserProfileCapabilities(liveProfile);
    if (capabilities.mode !== "local-managed") {
      return;
    }
    const identity = state().resolved.identity ?? { mode: "default" };
    if (
      identity.mode === "default" &&
      !identity.userAgent &&
      !identity.locale &&
      !identity.timezoneId &&
      !identity.acceptLanguage &&
      !identity.windowSize
    ) {
      return;
    }
    const profileState = getProfileState();
    const resolvedTargetId = targetId ?? profileState.lastTargetId ?? undefined;
    if (!resolvedTargetId) {
      return;
    }
    const mod = await getPwAiModule({ mode: "strict" });
    const applyIdentity = (mod as Partial<PwAiModule> | null)?.applyManagedIdentityViaPlaywright;
    const resolvePolicyKey = (mod as Partial<PwAiModule> | null)?.resolveManagedIdentityPolicyKey;
    if (typeof applyIdentity !== "function" || typeof resolvePolicyKey !== "function") {
      return;
    }
    const policyKey = resolvePolicyKey(identity);
    const identityApplied = profileState.identityApplied ?? new Map<string, string>();
    profileState.identityApplied = identityApplied;
    if (identityApplied.get(resolvedTargetId) === policyKey) {
      return;
    }
    await applyIdentity({
      cdpUrl: liveProfile.cdpUrl,
      targetId: resolvedTargetId,
      identity,
    });
    identityApplied.set(resolvedTargetId, policyKey);
  };

  const createLiveOps = () => {
    const liveProfile = getLiveProfile();
    const tabOps = createProfileTabOps({
      profile: liveProfile,
      state,
      getProfileState,
    });

    const availabilityOps = createProfileAvailability({
      opts,
      profile: liveProfile,
      state,
      getProfileState,
      setProfileRunning,
    });

    const selectionOps = createProfileSelectionOps({
      profile: liveProfile,
      getProfileState,
      ensureBrowserAvailable: availabilityOps.ensureBrowserAvailable,
      listTabs: tabOps.listTabs,
      openTab: tabOps.openTab,
    });

    const resetOps = createProfileResetOps({
      profile: liveProfile,
      getProfileState,
      stopRunningBrowser: availabilityOps.stopRunningBrowser,
      isHttpReachable: availabilityOps.isHttpReachable,
      resolveOpenClawUserDataDir,
    });

    return {
      profile: liveProfile,
      ...tabOps,
      ...availabilityOps,
      ...selectionOps,
      ...resetOps,
    };
  };

  return {
    get profile() {
      return getLiveProfile();
    },
    ensureBrowserAvailable: async () => await createLiveOps().ensureBrowserAvailable(),
    ensureTabAvailable: async (targetId) => {
      const tab = await createLiveOps().ensureTabAvailable(targetId);
      await applyManagedIdentity(tab.targetId);
      return tab;
    },
    isHttpReachable: async (timeoutMs) => await createLiveOps().isHttpReachable(timeoutMs),
    isReachable: async (timeoutMs) => await createLiveOps().isReachable(timeoutMs),
    listTabs: async () => await createLiveOps().listTabs(),
    openTab: async (url) => {
      const tab = await createLiveOps().openTab(url);
      await applyManagedIdentity(tab.targetId);
      return tab;
    },
    focusTab: async (targetId) => await createLiveOps().focusTab(targetId),
    closeTab: async (targetId) => {
      const result = await createLiveOps().closeTab(targetId);
      getProfileState().identityApplied?.delete(targetId);
      return result;
    },
    stopRunningBrowser: async () => {
      const result = await createLiveOps().stopRunningBrowser();
      getProfileState().identityApplied?.clear();
      return result;
    },
    resetProfile: async () => {
      const result = await createLiveOps().resetProfile();
      getProfileState().identityApplied?.clear();
      return result;
    },
  };
}

export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const forProfile = (profileName?: string): ProfileContext => {
    const current = state();
    const name = profileName ?? current.resolved.defaultProfile;
    const profile = resolveBrowserProfileWithHotReload({
      current,
      refreshConfigFromDisk,
      name,
    });

    if (!profile) {
      const available = Object.keys(current.resolved.profiles).join(", ");
      throw new BrowserProfileNotFoundError(
        `Profile "${name}" not found. Available profiles: ${available || "(none)"}`,
      );
    }
    return createProfileContext(opts, profile);
  };

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    refreshResolvedBrowserConfigFromDisk({
      current,
      refreshConfigFromDisk,
      mode: "cached",
    });
    const result: ProfileStatus[] = [];

    for (const name of listKnownProfileNames(current)) {
      const profileState = current.profiles.get(name);
      const profile = resolveProfile(current.resolved, name) ?? profileState?.profile;
      if (!profile) {
        continue;
      }
      const capabilities = getBrowserProfileCapabilities(profile);

      let tabCount = 0;
      let running = false;
      const profileCtx = createProfileContext(opts, profile);

      if (capabilities.usesChromeMcp) {
        try {
          running = await profileCtx.isReachable(300);
          if (running) {
            const tabs = await profileCtx.listTabs();
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Chrome MCP not available
        }
      } else if (profileState?.running) {
        running = true;
        try {
          const tabs = await profileCtx.listTabs();
          tabCount = tabs.filter((t) => t.type === "page").length;
        } catch {
          // Browser might not be responsive
        }
      } else {
        // Check if something is listening on the port
        try {
          const reachable = await isChromeReachable(
            profile.cdpUrl,
            200,
            current.resolved.ssrfPolicy,
          );
          if (reachable) {
            running = true;
            const tabs = await profileCtx.listTabs().catch(() => []);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Not reachable
        }
      }

      result.push({
        name,
        transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
        cdpPort: capabilities.usesChromeMcp ? null : profile.cdpPort,
        cdpUrl: capabilities.usesChromeMcp ? null : profile.cdpUrl,
        color: profile.color,
        driver: profile.driver,
        running,
        tabCount,
        isDefault: name === current.resolved.defaultProfile,
        isRemote: !profile.cdpIsLoopback,
        missingFromConfig: !(name in current.resolved.profiles) || undefined,
        reconcileReason: profileState?.reconcile?.reason ?? null,
      });
    }

    return result;
  };

  // Create default profile context for backward compatibility
  const getDefaultContext = () => forProfile();

  const mapTabError = (err: unknown) => {
    const browserMapped = toBrowserErrorResponse(err);
    if (browserMapped) {
      return browserMapped;
    }
    if (err instanceof SsrFBlockedError) {
      return { status: 400, message: err.message };
    }
    if (err instanceof InvalidBrowserNavigationUrlError) {
      return { status: 400, message: err.message };
    }
    return null;
  };

  return {
    state,
    forProfile,
    listProfiles,
    // Legacy methods delegate to default profile
    ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
    ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url) => getDefaultContext().openTab(url),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
