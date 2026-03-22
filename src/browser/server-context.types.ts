import type { Server } from "node:http";
import type { RunningChrome } from "./chrome.js";
import type { BrowserTransport } from "./client.js";
import type { BrowserTab } from "./client.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

export type { BrowserTab };
export type BrowserOpenDisposition = "current" | "new";

export type BrowserTabLifecycleState =
  | "opening"
  | "discovering"
  | "ready"
  | "recovering"
  | "challenged"
  | "failed"
  | "closed"
  | "fallback-search";

export type BrowserTabFailureClass =
  | "open_unconfirmed"
  | "target_missing"
  | "target_replaced"
  | "navigation_churn"
  | "challenge_detected"
  | "retailer_soft_block"
  | "ambiguous_rebind"
  | "fallback_search_entered";

export type ManagedBrowserTabRecord = {
  profile: string;
  driver: ResolvedBrowserProfile["driver"];
  requestedUrl: string;
  currentUrl: string;
  targetId: string;
  previousTargetIds: string[];
  openedAt: number;
  lastUsedAt: number;
  lifecycleState: BrowserTabLifecycleState;
  failureClass?: BrowserTabFailureClass;
  domain?: string;
};

export type PendingBrowserTabOpen = {
  targetId: string;
  requestedUrl: string;
  domain?: string;
  openedAt: number;
  expiresAt: number;
};

/**
 * Runtime state for a single profile's Chrome instance.
 */
export type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;
  /** Sticky tab selection when callers omit targetId (keeps snapshot+act consistent). */
  lastTargetId?: string | null;
  managedTabs: Map<string, ManagedBrowserTabRecord>;
  pendingOpens: Map<string, PendingBrowserTabOpen>;
  identityApplied?: Map<string, string>;
  reconcile?: {
    previousProfile: ResolvedBrowserProfile;
    reason: string;
  } | null;
};

export type BrowserServerState = {
  server?: Server | null;
  port: number;
  resolved: ResolvedBrowserConfig;
  profiles: Map<string, ProfileRuntimeState>;
};

type BrowserProfileActions = {
  ensureBrowserAvailable: () => Promise<void>;
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (
    url: string,
    opts?: { openDisposition?: BrowserOpenDisposition },
  ) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
};

export type BrowserRouteContext = {
  state: () => BrowserServerState;
  forProfile: (profileName?: string) => ProfileContext;
  listProfiles: () => Promise<ProfileStatus[]>;
  // Legacy methods delegate to default profile for backward compatibility
  mapTabError: (err: unknown) => { status: number; message: string } | null;
} & BrowserProfileActions;

export type ProfileContext = {
  profile: ResolvedBrowserProfile;
} & BrowserProfileActions;

export type ProfileStatus = {
  name: string;
  transport: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  color: string;
  driver: ResolvedBrowserProfile["driver"];
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
  missingFromConfig?: boolean;
  reconcileReason?: string | null;
};

export type ContextOptions = {
  getState: () => BrowserServerState | null;
  onEnsureAttachTarget?: (profile: ResolvedBrowserProfile) => Promise<void>;
  refreshConfigFromDisk?: boolean;
};
