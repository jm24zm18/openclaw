import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { closeChromeMcpTab, focusChromeMcpTab } from "./chrome-mcp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import {
  BrowserOpenUnconfirmedError,
  BrowserTabNotFoundError,
  BrowserTargetAmbiguousError,
} from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import type {
  BrowserTab,
  ManagedBrowserTabRecord,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { filterRealPageTargets } from "./target-filter.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

type SelectionDeps = {
  profile: ResolvedBrowserProfile;
  getProfileState: () => ProfileRuntimeState;
  ensureBrowserAvailable: () => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
};

type SelectionOps = {
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
};

export function createProfileSelectionOps({
  profile,
  getProfileState,
  ensureBrowserAvailable,
  listTabs,
  openTab,
}: SelectionDeps): SelectionOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const getDomain = (rawUrl: string): string | undefined => {
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  };

  const toManagedTab = (tab: BrowserTab, record?: ManagedBrowserTabRecord): BrowserTab => {
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
  };

  const findTrackedRecord = (rawTargetId: string): ManagedBrowserTabRecord | null => {
    const profileState = getProfileState();
    return (
      profileState.managedTabs.get(rawTargetId) ??
      [...profileState.managedTabs.values()].find(
        (record) =>
          record.previousTargetIds.includes(rawTargetId) || record.targetId === rawTargetId,
      ) ??
      null
    );
  };

  const bindTrackedRecord = (params: {
    record: ManagedBrowserTabRecord;
    tab: BrowserTab;
    lifecycleState: ManagedBrowserTabRecord["lifecycleState"];
    failureClass?: ManagedBrowserTabRecord["failureClass"];
    previousTargetId?: string;
  }): BrowserTab => {
    const profileState = getProfileState();
    const next: ManagedBrowserTabRecord = {
      ...params.record,
      targetId: params.tab.targetId,
      currentUrl: params.tab.url,
      lastUsedAt: Date.now(),
      lifecycleState: params.lifecycleState,
      previousTargetIds: [
        ...new Set([
          ...params.record.previousTargetIds,
          ...(params.previousTargetId && params.previousTargetId !== params.tab.targetId
            ? [params.previousTargetId]
            : []),
        ]),
      ],
      ...(params.failureClass ? { failureClass: params.failureClass } : {}),
      domain: getDomain(params.tab.url) ?? params.record.domain,
    };
    if (params.record.targetId !== params.tab.targetId) {
      profileState.managedTabs.delete(params.record.targetId);
    }
    profileState.managedTabs.set(next.targetId, next);
    profileState.lastTargetId = next.targetId;
    return toManagedTab(params.tab, next);
  };

  const recoverMissingTab = async (
    rawTargetId: string,
    candidates: BrowserTab[],
  ): Promise<BrowserTab | "AMBIGUOUS" | null> => {
    const profileState = getProfileState();
    const pageCandidates = filterRealPageTargets(candidates);
    const record = findTrackedRecord(rawTargetId);
    const pending = profileState.pendingOpens.get(rawTargetId);
    const requestedUrl = pending?.requestedUrl ?? record?.requestedUrl;
    const requestedDomain =
      pending?.domain ?? record?.domain ?? (requestedUrl ? getDomain(requestedUrl) : undefined);

    const exactRecordMatch = record
      ? candidates.find((tab) => tab.targetId === record.targetId)
      : null;
    if (exactRecordMatch && record) {
      return bindTrackedRecord({
        record,
        tab: exactRecordMatch,
        lifecycleState: "ready",
      });
    }

    if (requestedUrl) {
      const sameUrl = pageCandidates.filter((tab) => tab.url === requestedUrl);
      if (sameUrl.length === 1) {
        if (record) {
          profileState.pendingOpens.delete(rawTargetId);
          return bindTrackedRecord({
            record,
            tab: sameUrl[0],
            lifecycleState: "recovering",
            failureClass: "target_replaced",
            previousTargetId: rawTargetId,
          });
        }
        return sameUrl[0] ?? null;
      }
      if (sameUrl.length > 1) {
        return "AMBIGUOUS";
      }
    }

    if (requestedDomain) {
      const sameDomain = pageCandidates.filter((tab) => getDomain(tab.url) === requestedDomain);
      if (sameDomain.length === 1) {
        if (record) {
          profileState.pendingOpens.delete(rawTargetId);
          return bindTrackedRecord({
            record,
            tab: sameDomain[0],
            lifecycleState: "recovering",
            failureClass: "target_replaced",
            previousTargetId: rawTargetId,
          });
        }
        return sameDomain[0] ?? null;
      }
      if (sameDomain.length > 1) {
        return "AMBIGUOUS";
      }
    }

    if (pageCandidates.length === 1) {
      const soleCandidate = pageCandidates[0];
      const managedPageRecords = [...profileState.managedTabs.values()];
      const soleManagedRecord = managedPageRecords.length === 1 ? managedPageRecords[0] : null;
      if (record || soleManagedRecord) {
        profileState.pendingOpens.delete(rawTargetId);
        return bindTrackedRecord({
          record: record ?? soleManagedRecord!,
          tab: soleCandidate,
          lifecycleState: "recovering",
          failureClass: "target_replaced",
          previousTargetId: rawTargetId,
        });
      }
      return soleCandidate;
    }

    if (record) {
      profileState.managedTabs.set(record.targetId, {
        ...record,
        lifecycleState: pending ? "recovering" : "failed",
        failureClass: pending ? "open_unconfirmed" : "target_missing",
        lastUsedAt: Date.now(),
      });
    }
    return null;
  };

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    const tabs1 = await listTabs();
    if (tabs1.length === 0) {
      await openTab("about:blank");
    }

    const tabs = await listTabs();
    const candidates = capabilities.supportsPerTabWs ? tabs.filter((t) => Boolean(t.wsUrl)) : tabs;
    const pageCandidates = filterRealPageTargets(candidates);

    const resolveById = (raw: string) => {
      const resolved = resolveTargetIdFromTabs(raw, pageCandidates);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          return "AMBIGUOUS" as const;
        }
        return null;
      }
      return pageCandidates.find((t) => t.targetId === resolved.targetId) ?? null;
    };

    const pickDefault = () => {
      const last = profileState.lastTargetId?.trim() || "";
      const lastResolved = last ? resolveById(last) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") {
        return lastResolved;
      }
      // Prefer a real page tab first (avoid service workers/background targets).
      return pageCandidates.at(0) ?? null;
    };

    const chosen = targetId ? resolveById(targetId) : pickDefault();

    if (chosen === "AMBIGUOUS") {
      throw new BrowserTargetAmbiguousError();
    }
    if (!chosen && targetId) {
      const recovered = await recoverMissingTab(targetId, pageCandidates);
      if (recovered === "AMBIGUOUS") {
        throw new BrowserTargetAmbiguousError("ambiguous target recovery");
      }
      if (recovered) {
        return recovered;
      }
    }
    if (!chosen) {
      const pending = targetId ? getProfileState().pendingOpens.get(targetId) : null;
      if (pending) {
        throw new BrowserOpenUnconfirmedError(
          `tab open was not confirmed for ${pending.requestedUrl}`,
        );
      }
      throw new BrowserTabNotFoundError();
    }
    profileState.lastTargetId = chosen.targetId;
    const record = findTrackedRecord(chosen.targetId);
    return record
      ? bindTrackedRecord({
          record,
          tab: chosen,
          lifecycleState: record.lifecycleState === "recovering" ? "recovering" : "ready",
        })
      : chosen;
  };

  const resolveTargetIdOrThrow = async (targetId: string): Promise<string> => {
    const tabs = filterRealPageTargets(await listTabs());
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new BrowserTargetAmbiguousError();
      }
      const recovered = await recoverMissingTab(targetId, tabs);
      if (recovered === "AMBIGUOUS") {
        throw new BrowserTargetAmbiguousError("ambiguous target recovery");
      }
      if (recovered) {
        return recovered.targetId;
      }
      throw new BrowserTabNotFoundError();
    }
    return resolved.targetId;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (capabilities.usesChromeMcp) {
      await focusChromeMcpTab(profile.name, resolvedTargetId, profile.userDataDir);
      const profileState = getProfileState();
      profileState.lastTargetId = resolvedTargetId;
      return;
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const focusPageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.focusPageByTargetIdViaPlaywright;
      if (typeof focusPageByTargetIdViaPlaywright === "function") {
        await focusPageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
        });
        const profileState = getProfileState();
        profileState.lastTargetId = resolvedTargetId;
        return;
      }
    }

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/activate/${resolvedTargetId}`));
    const profileState = getProfileState();
    profileState.lastTargetId = resolvedTargetId;
  };

  const closeTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (capabilities.usesChromeMcp) {
      await closeChromeMcpTab(profile.name, resolvedTargetId, profile.userDataDir);
      return;
    }

    // For remote profiles, use Playwright's persistent connection to close tabs
    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const closePageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.closePageByTargetIdViaPlaywright;
      if (typeof closePageByTargetIdViaPlaywright === "function") {
        await closePageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
        });
        return;
      }
    }

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${resolvedTargetId}`));
    const profileState = getProfileState();
    const record = findTrackedRecord(resolvedTargetId);
    if (record) {
      profileState.managedTabs.set(resolvedTargetId, {
        ...record,
        lifecycleState: "closed",
        lastUsedAt: Date.now(),
      });
    }
  };

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}
