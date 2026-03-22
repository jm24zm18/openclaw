import type { BrowserTab } from "./server-context.types.js";

const NON_PAGE_TARGET_TYPES = new Set([
  "iframe",
  "worker",
  "shared_worker",
  "shared-worker",
  "service_worker",
  "service-worker",
  "background_page",
  "background-page",
  "browser",
  "other",
]);

export function isRealPageTarget(tab: Pick<BrowserTab, "type"> | null | undefined): boolean {
  const rawType = String(tab?.type ?? "page")
    .trim()
    .toLowerCase();
  return !NON_PAGE_TARGET_TYPES.has(rawType);
}

export function filterRealPageTargets<T extends Pick<BrowserTab, "type">>(tabs: readonly T[]): T[] {
  return tabs.filter((tab) => isRealPageTarget(tab));
}
