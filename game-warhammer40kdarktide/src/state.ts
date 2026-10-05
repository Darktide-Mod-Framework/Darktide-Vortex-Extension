/**
 * Mutable state shared between the installer, the load order handling and the
 * event handlers. Kept in one place so it's obvious where it lives.
 */

export const modUpdateState = {
  /** Display name of the mod currently being installed (used in warnings). */
  modInstallName: "",

  /** True while a mod is being updated (old version removed, new not yet deployed). */
  updateInProgress: false,

  /**
   * Profile the in-flight update belongs to. Cleanup is scoped to Darktide so
   * an unrelated deployment can't discard it.
   */
  profileId: undefined as string | undefined,

  /**
   * Maps a deployed mod folder (the load order id, e.g. `true_level`) to the
   * deployment source (the staging folder, e.g.
   * `True Level-156-1-6-3-1719534708`), taken from the last deployment
   * manifest, resolved to the installed state key when read.
   */
  deployedModIds: new Map<string, string>(),

  /** Directory whose persisted manifest has been checked during this session. */
  manifestPath: undefined as string | undefined,
  manifestLoad: undefined as Promise<void> | undefined,
  /** Changes whenever an event supplies fresher deployment data. */
  deploymentRevision: 0,
};

/** Forget the in-flight update. The deployed-mod-id map is kept. */
export function clearUpdateState(): void {
  modUpdateState.updateInProgress = false;
  modUpdateState.profileId = undefined;
}

/** The profile whose files are on disk, even before Vortex confirms a switch. */
export const loadOrderState = {
  gamePath: undefined as string | undefined,
  profileId: undefined as string | undefined,
  purged: false,
  /** will-purge ran, but the host has not reported successful completion. */
  purgePreparing: false,
  /** A failed purge removed files; preserve them while saving surviving mods. */
  purgeFailed: false,
  deploymentComplete: false,
  snapshotLoad: undefined as Promise<void> | undefined,
  // A purge can remove mod_load_order.txt itself. Keep its settings until the
  // same profile is deployed again, including comments for other profiles.
  preservedFile: undefined as { scope: string; contents: string } | undefined,
};

export function resetLoadOrderState(): void {
  loadOrderState.gamePath = undefined;
  loadOrderState.profileId = undefined;
  loadOrderState.purged = false;
  loadOrderState.purgePreparing = false;
  loadOrderState.purgeFailed = false;
  loadOrderState.deploymentComplete = false;
  loadOrderState.snapshotLoad = undefined;
  loadOrderState.preservedFile = undefined;
}
