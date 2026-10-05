import * as React from "react";
import { selectors, types } from "@nexusmods/vortex-api";

import { GAME_ID } from "./constants";
import { getOrderWarnings, type OrderWarning } from "./loadorder";
import { type LoadOrder } from "./ordering";

const EMPTY_ORDER: LoadOrder = [];

export const isLocked = (entry: types.ILoadOrderEntry) =>
  entry.locked === true || entry.locked === "true" || entry.locked === "always";

interface WarningSnapshot {
  loadOrder: LoadOrder;
  profileId?: string;
  entries: Map<string, LoadOrder[number]>;
  positions: Map<string, number>;
  warningsById: Map<string, OrderWarning[]>;
  warnings: types.IValidationResult["invalid"];
  lockedEntriesCount: number;
}

/** Share the host subscription and full-order work across rows and instructions. */
function createWarningStore(api: types.IExtensionApi) {
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  let snapshot: WarningSnapshot | undefined;
  let publishedSnapshot: WarningSnapshot | undefined;

  const read = (): WarningSnapshot => {
    const state = api.getState() as types.IState & {
      persistent: { loadOrder?: Record<string, LoadOrder> };
    };
    const profile = selectors.activeProfile(state);
    const profileId = profile?.gameId === GAME_ID ? profile.id : undefined;
    const loadOrder = profileId
      ? (state.persistent.loadOrder?.[profileId] ?? EMPTY_ORDER)
      : EMPTY_ORDER;
    if (snapshot?.loadOrder === loadOrder && snapshot.profileId === profileId)
      return snapshot;

    const entries = new Map<string, LoadOrder[number]>();
    const positions = new Map<string, number>();
    let lockedEntriesCount = 0;
    loadOrder.forEach((entry, index) => {
      entries.set(entry.id, entry);
      positions.set(entry.id, index + 1);
      if (isLocked(entry)) ++lockedEntriesCount;
    });
    const warningsById = new Map<string, OrderWarning[]>();
    const reasons = new Map<string, string>();
    for (const warning of getOrderWarnings(loadOrder)) {
      const warnings = warningsById.get(warning.id) ?? [];
      warnings.push(warning);
      warningsById.set(warning.id, warnings);
      const previous = reasons.get(warning.id);
      reasons.set(
        warning.id,
        previous === undefined
          ? warning.reason
          : `${warning.reason} ${previous}`,
      );
    }
    snapshot = {
      loadOrder,
      profileId,
      entries,
      positions,
      warningsById,
      warnings: [...reasons].map(([id, reason]) => ({ id, reason })),
      lockedEntriesCount,
    };
    return snapshot;
  };

  const update = () => {
    const current = read();
    // A newly mounted row can read the new state before Redux reaches our
    // subscription. Existing consumers still need that snapshot published.
    if (current !== publishedSnapshot) {
      publishedSnapshot = current;
      listeners.forEach((listener) => listener());
    }
  };

  return {
    read,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        // The types-only API package omits the Redux Store base declaration.
        const store = api.store as
          | { subscribe(listener: () => void): () => void }
          | undefined;
        unsubscribe = store?.subscribe(update);
      }
      // Catch changes between rendering and installing the subscription.
      update();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  };
}

const stores = new WeakMap<
  types.IExtensionApi,
  ReturnType<typeof createWarningStore>
>();

export function useLoadOrderWarnings(api: types.IExtensionApi) {
  let store = stores.get(api);
  if (store === undefined) {
    store = createWarningStore(api);
    stores.set(api, store);
  }
  const warningStore = store;
  const [snapshot, setSnapshot] = React.useState(warningStore.read);
  React.useEffect(() => {
    const update = () => setSnapshot(warningStore.read());
    const unsubscribe = warningStore.subscribe(update);
    update();
    return unsubscribe;
  }, [warningStore]);
  return snapshot;
}
