import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import { fetchJson, fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath, createTargetViaCdp, normalizeCdpWsUrl } from "./cdp.js";
import {
  closeChromeMcpTab,
  listChromeMcpTabs,
  navigateChromeMcpPage,
  openChromeMcpTab,
} from "./chrome-mcp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserOpenUnconfirmedError } from "./errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirects,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  MANAGED_BROWSER_PAGE_TAB_LIMIT,
  MANAGED_BROWSER_PENDING_OPEN_TTL_MS,
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserTabFailureClass,
  BrowserServerState,
  BrowserTab,
  ManagedBrowserTabRecord,
  PendingBrowserTabOpen,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { filterRealPageTargets } from "./target-filter.js";

type TabOpsDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  getProfileState: () => ProfileRuntimeState;
};

type ProfileTabOps = {
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string, opts?: { openDisposition?: "current" | "new" }) => Promise<BrowserTab>;
};

/**
 * Normalize a CDP WebSocket URL to use the correct base URL.
 */
function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

type CdpTarget = {
  id?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

function getDomain(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function toManagedTab(tab: BrowserTab, record?: ManagedBrowserTabRecord): BrowserTab {
  if (!record) {
    return tab;
  }
  return {
    ...tab,
    lifecycleState: record.lifecycleState,
    failureClass: record.failureClass,
    requestedUrl: record.requestedUrl,
    previousTargetIds: [...record.previousTargetIds],
    profile: record.profile,
    driver: record.driver,
    domain: record.domain,
    openedAt: record.openedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

export function createProfileTabOps({
  profile,
  state,
  getProfileState,
}: TabOpsDeps): ProfileTabOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);
  const readProfileState = () => getProfileState();

  const pruneExpiredPendingOpens = () => {
    const now = Date.now();
    const profileState = readProfileState();
    for (const [targetId, pending] of profileState.pendingOpens.entries()) {
      if (pending.expiresAt <= now) {
        profileState.pendingOpens.delete(targetId);
      }
    }
  };

  const upsertManagedTabRecord = (params: {
    targetId: string;
    requestedUrl: string;
    currentUrl: string;
    lifecycleState: ManagedBrowserTabRecord["lifecycleState"];
    failureClass?: BrowserTabFailureClass;
    previousTargetId?: string;
  }): ManagedBrowserTabRecord => {
    const now = Date.now();
    const profileState = readProfileState();
    const existing =
      profileState.managedTabs.get(params.targetId) ??
      [...profileState.managedTabs.values()].find((record) =>
        record.previousTargetIds.includes(params.targetId),
      );
    const previousTargetIds = existing ? [...existing.previousTargetIds] : [];
    if (params.previousTargetId && params.previousTargetId !== params.targetId) {
      previousTargetIds.push(params.previousTargetId);
    }
    const record: ManagedBrowserTabRecord = {
      profile: profile.name,
      driver: profile.driver,
      requestedUrl: existing?.requestedUrl ?? params.requestedUrl,
      currentUrl: params.currentUrl,
      targetId: params.targetId,
      previousTargetIds: [...new Set(previousTargetIds)],
      openedAt: existing?.openedAt ?? now,
      lastUsedAt: now,
      lifecycleState: params.lifecycleState,
      ...(params.failureClass ? { failureClass: params.failureClass } : {}),
      domain: getDomain(params.currentUrl || params.requestedUrl),
    };
    if (existing && existing.targetId !== params.targetId) {
      profileState.managedTabs.delete(existing.targetId);
    }
    profileState.managedTabs.set(record.targetId, record);
    return record;
  };

  const registerPendingOpen = (targetId: string, requestedUrl: string): PendingBrowserTabOpen => {
    const pending: PendingBrowserTabOpen = {
      targetId,
      requestedUrl,
      domain: getDomain(requestedUrl),
      openedAt: Date.now(),
      expiresAt: Date.now() + MANAGED_BROWSER_PENDING_OPEN_TTL_MS,
    };
    const profileState = readProfileState();
    profileState.pendingOpens.set(targetId, pending);
    return pending;
  };

  const clearPendingOpen = (targetId: string) => {
    readProfileState().pendingOpens.delete(targetId);
  };

  const findReusableTabForUrl = async (url: string): Promise<BrowserTab | null> => {
    const requestedDomain = getDomain(url);
    if (!requestedDomain) {
      return null;
    }
    const tabs = await listTabs().catch(() => [] as BrowserTab[]);
    const match = filterRealPageTargets(tabs).find((tab) => getDomain(tab.url) === requestedDomain);
    if (!match) {
      return null;
    }
    const record = upsertManagedTabRecord({
      targetId: match.targetId,
      requestedUrl: url,
      currentUrl: match.url,
      lifecycleState: "ready",
    });
    const profileState = readProfileState();
    profileState.lastTargetId = match.targetId;
    return toManagedTab(match, record);
  };

  const shouldUseSinglePagePolicy = (opts?: { openDisposition?: "current" | "new" }): boolean =>
    (state().resolved.tabPolicy?.mode ?? "single") !== "multi" && opts?.openDisposition !== "new";

  const pickActivePage = async (): Promise<BrowserTab | null> => {
    const profileState = readProfileState();
    const tabs = await listTabs().catch(() => [] as BrowserTab[]);
    const pageTabs = filterRealPageTargets(tabs);
    if (pageTabs.length === 0) {
      return null;
    }
    const last = profileState.lastTargetId?.trim();
    if (last) {
      const byLast = pageTabs.find((tab) => tab.targetId === last);
      if (byLast) {
        return byLast;
      }
    }
    return pageTabs[0] ?? null;
  };

  const closeOtherManagedPages = async (keepTargetId: string): Promise<void> => {
    const pageTabs = await listTabs()
      .then((tabs) => filterRealPageTargets(tabs))
      .catch(() => [] as BrowserTab[]);
    const candidates = pageTabs.filter((tab) => tab.targetId !== keepTargetId);
    for (const tab of candidates) {
      try {
        if (capabilities.usesChromeMcp) {
          await closeChromeMcpTab(profile.name, tab.targetId, profile.userDataDir);
          continue;
        }
        if (capabilities.usesPersistentPlaywright) {
          const mod = await getPwAiModule({ mode: "strict" });
          const closePage = (mod as Partial<PwAiModule> | null)?.closePageByTargetIdViaPlaywright;
          if (typeof closePage === "function") {
            await closePage({
              cdpUrl: profile.cdpUrl,
              targetId: tab.targetId,
            });
            continue;
          }
        }
        await fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`));
      } catch {
        // Best-effort cleanup for non-kept pages.
      }
    }
  };

  const navigateExistingPage = async (
    activePage: BrowserTab,
    url: string,
  ): Promise<BrowserTab | null> => {
    const ssrfPolicyOpts = withBrowserNavigationPolicy(state().resolved.ssrfPolicy);
    if (capabilities.usesChromeMcp) {
      const result = await navigateChromeMcpPage({
        profileName: profile.name,
        userDataDir: profile.userDataDir,
        targetId: activePage.targetId,
        url,
      });
      await assertBrowserNavigationResultAllowed({ url: result.url, ...ssrfPolicyOpts });
      const record = upsertManagedTabRecord({
        targetId: activePage.targetId,
        requestedUrl: url,
        currentUrl: result.url,
        lifecycleState: "ready",
      });
      readProfileState().lastTargetId = activePage.targetId;
      return toManagedTab({ ...activePage, url: result.url }, record);
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const navigate = (mod as Partial<PwAiModule> | null)?.navigateViaPlaywright;
      if (typeof navigate === "function") {
        const result = await navigate({
          cdpUrl: profile.cdpUrl,
          targetId: activePage.targetId,
          url,
          ...ssrfPolicyOpts,
        });
        const record = upsertManagedTabRecord({
          targetId: activePage.targetId,
          requestedUrl: url,
          currentUrl: result.url,
          lifecycleState: "ready",
        });
        readProfileState().lastTargetId = activePage.targetId;
        return toManagedTab({ ...activePage, url: result.url }, record);
      }
    }

    return null;
  };

  const rediscoverOpenedTab = async (params: {
    targetId: string;
    requestedUrl: string;
  }): Promise<BrowserTab | null> => {
    const tabs = await listTabs().catch(() => [] as BrowserTab[]);
    const exact = tabs.find((tab) => tab.targetId === params.targetId);
    if (exact) {
      return exact;
    }
    const sameUrl = tabs.filter((tab) => tab.url === params.requestedUrl);
    if (sameUrl.length === 1) {
      return sameUrl[0] ?? null;
    }
    const requestedDomain = getDomain(params.requestedUrl);
    const sameDomain = tabs.filter(
      (tab) => requestedDomain && getDomain(tab.url) === requestedDomain,
    );
    if (sameDomain.length === 1) {
      return sameDomain[0] ?? null;
    }
    return null;
  };

  const listTabs = async (): Promise<BrowserTab[]> => {
    pruneExpiredPendingOpens();
    if (capabilities.usesChromeMcp) {
      const tabs = await listChromeMcpTabs(profile.name, profile.userDataDir);
      return tabs.map((tab) => toManagedTab(tab, readProfileState().managedTabs.get(tab.targetId)));
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const listPagesViaPlaywright = (mod as Partial<PwAiModule> | null)?.listPagesViaPlaywright;
      if (typeof listPagesViaPlaywright === "function") {
        const pages = await listPagesViaPlaywright({ cdpUrl: profile.cdpUrl });
        return pages.map((p) =>
          toManagedTab(
            {
              targetId: p.targetId,
              title: p.title,
              url: p.url,
              type: p.type,
            },
            readProfileState().managedTabs.get(p.targetId),
          ),
        );
      }
    }

    const raw = await fetchJson<
      Array<{
        id?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
        type?: string;
      }>
    >(appendCdpPath(cdpHttpBase, "/json/list"));
    return raw
      .map((t) => ({
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
        type: t.type,
      }))
      .filter((t) => Boolean(t.targetId))
      .map((tab) => toManagedTab(tab, readProfileState().managedTabs.get(tab.targetId)));
  };

  const enforceManagedTabLimit = async (keepTargetId: string): Promise<void> => {
    const profileState = getProfileState();
    if (
      !capabilities.supportsManagedTabLimit ||
      state().resolved.attachOnly ||
      !profileState.running
    ) {
      return;
    }

    const pageTabs = await listTabs()
      .then((tabs) => filterRealPageTargets(tabs))
      .catch(() => [] as BrowserTab[]);
    if (pageTabs.length <= MANAGED_BROWSER_PAGE_TAB_LIMIT) {
      return;
    }

    const candidates = pageTabs.filter((tab) => tab.targetId !== keepTargetId);
    const excessCount = pageTabs.length - MANAGED_BROWSER_PAGE_TAB_LIMIT;
    for (const tab of candidates.slice(0, excessCount)) {
      void fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`)).catch(() => {
        // best-effort cleanup only
      });
    }
  };

  const triggerManagedTabLimit = (keepTargetId: string): void => {
    void enforceManagedTabLimit(keepTargetId).catch(() => {
      // best-effort cleanup only
    });
  };

  const openTab = async (
    url: string,
    opts?: { openDisposition?: "current" | "new" },
  ): Promise<BrowserTab> => {
    const ssrfPolicyOpts = withBrowserNavigationPolicy(state().resolved.ssrfPolicy);
    if (shouldUseSinglePagePolicy(opts)) {
      const activePage = await pickActivePage();
      if (activePage) {
        const navigated = await navigateExistingPage(activePage, url);
        if (navigated) {
          await closeOtherManagedPages(navigated.targetId);
          return navigated;
        }
      }
    } else {
      const reusable = await findReusableTabForUrl(url);
      if (reusable) {
        return reusable;
      }
    }

    if (capabilities.usesChromeMcp) {
      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      const page = await openChromeMcpTab(profile.name, url, profile.userDataDir);
      const profileState = getProfileState();
      profileState.lastTargetId = page.targetId;
      await assertBrowserNavigationResultAllowed({ url: page.url, ...ssrfPolicyOpts });
      const record = upsertManagedTabRecord({
        targetId: page.targetId,
        requestedUrl: url,
        currentUrl: page.url,
        lifecycleState: "ready",
      });
      if (shouldUseSinglePagePolicy(opts)) {
        await closeOtherManagedPages(page.targetId);
      }
      return toManagedTab(page, record);
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const createPageViaPlaywright = (mod as Partial<PwAiModule> | null)?.createPageViaPlaywright;
      if (typeof createPageViaPlaywright === "function") {
        const page = await createPageViaPlaywright({
          cdpUrl: profile.cdpUrl,
          url,
          ...ssrfPolicyOpts,
        });
        const profileState = getProfileState();
        profileState.lastTargetId = page.targetId;
        const tab = {
          targetId: page.targetId,
          title: page.title,
          url: page.url,
          type: page.type,
        };
        const record = upsertManagedTabRecord({
          targetId: page.targetId,
          requestedUrl: url,
          currentUrl: page.url,
          lifecycleState: "ready",
        });
        if (shouldUseSinglePagePolicy(opts)) {
          await closeOtherManagedPages(page.targetId);
        } else {
          triggerManagedTabLimit(page.targetId);
        }
        return toManagedTab(tab, record);
      }
    }

    if (requiresInspectableBrowserNavigationRedirects(state().resolved.ssrfPolicy)) {
      throw new InvalidBrowserNavigationUrlError(
        "Navigation blocked: strict browser SSRF policy requires Playwright-backed redirect-hop inspection",
      );
    }

    const createdViaCdp = await createTargetViaCdp({
      cdpUrl: profile.cdpUrl,
      url,
      ...ssrfPolicyOpts,
    })
      .then((r) => r.targetId)
      .catch(() => null);

    if (createdViaCdp) {
      const profileState = getProfileState();
      profileState.lastTargetId = createdViaCdp;
      registerPendingOpen(createdViaCdp, url);
      upsertManagedTabRecord({
        targetId: createdViaCdp,
        requestedUrl: url,
        currentUrl: url,
        lifecycleState: "discovering",
      });
      const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
      while (Date.now() < deadline) {
        const found = await rediscoverOpenedTab({
          targetId: createdViaCdp,
          requestedUrl: url,
        });
        if (found) {
          await assertBrowserNavigationResultAllowed({ url: found.url, ...ssrfPolicyOpts });
          clearPendingOpen(createdViaCdp);
          const record = upsertManagedTabRecord({
            targetId: found.targetId,
            previousTargetId: createdViaCdp,
            requestedUrl: url,
            currentUrl: found.url,
            lifecycleState: "ready",
            failureClass: found.targetId !== createdViaCdp ? "target_replaced" : undefined,
          });
          if (shouldUseSinglePagePolicy(opts)) {
            await closeOtherManagedPages(found.targetId);
          } else {
            triggerManagedTabLimit(found.targetId);
          }
          profileState.lastTargetId = found.targetId;
          return toManagedTab(found, record);
        }
        await new Promise((r) => setTimeout(r, OPEN_TAB_DISCOVERY_POLL_MS));
      }
      upsertManagedTabRecord({
        targetId: createdViaCdp,
        requestedUrl: url,
        currentUrl: url,
        lifecycleState: "recovering",
        failureClass: "open_unconfirmed",
      });
      if (!shouldUseSinglePagePolicy(opts)) {
        triggerManagedTabLimit(createdViaCdp);
      }
      throw new BrowserOpenUnconfirmedError(
        `tab open was not confirmed for ${url} (${createdViaCdp})`,
      );
    }

    const encoded = encodeURIComponent(url);
    const endpointUrl = new URL(appendCdpPath(cdpHttpBase, "/json/new"));
    await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
    const endpoint = endpointUrl.search
      ? (() => {
          endpointUrl.searchParams.set("url", url);
          return endpointUrl.toString();
        })()
      : `${endpointUrl.toString()}?${encoded}`;
    const created = await fetchJson<CdpTarget>(endpoint, CDP_JSON_NEW_TIMEOUT_MS, {
      method: "PUT",
    }).catch(async (err) => {
      if (String(err).includes("HTTP 405")) {
        return await fetchJson<CdpTarget>(endpoint, CDP_JSON_NEW_TIMEOUT_MS);
      }
      throw err;
    });

    if (!created.id) {
      throw new Error("Failed to open tab (missing id)");
    }
    const profileState = getProfileState();
    profileState.lastTargetId = created.id;
    const resolvedUrl = created.url ?? url;
    await assertBrowserNavigationResultAllowed({ url: resolvedUrl, ...ssrfPolicyOpts });
    clearPendingOpen(created.id);
    const record = upsertManagedTabRecord({
      targetId: created.id,
      requestedUrl: url,
      currentUrl: resolvedUrl,
      lifecycleState: "ready",
    });
    if (shouldUseSinglePagePolicy(opts)) {
      await closeOtherManagedPages(created.id);
    } else {
      triggerManagedTabLimit(created.id);
    }
    return toManagedTab(
      {
        targetId: created.id,
        title: created.title ?? "",
        url: resolvedUrl,
        wsUrl: normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl),
        type: created.type,
      },
      record,
    );
  };

  return {
    listTabs,
    openTab,
  };
}
