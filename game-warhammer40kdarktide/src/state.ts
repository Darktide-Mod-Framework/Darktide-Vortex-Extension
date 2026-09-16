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
   * real installed Vortex mod id (the staging folder, e.g.
   * `True Level-156-1-6-3-1719534708`), taken from the last deployment
   * manifest. Vortex matches replacement entries by this id.
   */
  deployedModIds: new Map<string, string>(),
};

/** Forget the in-flight update. The deployed-mod-id map is kept. */
export function clearUpdateState(): void {
  modUpdateState.updateInProgress = false;
  modUpdateState.profileId = undefined;
}
