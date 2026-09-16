/**
 * Mutable state shared between the installer, the load order handling and the
 * event handlers. Kept in one place so it's obvious where it lives.
 */

/** A load order entry captured before an in-flight update undeploys its files. */
export interface PreservedEntry {
  /** Whether the entry was enabled when it was captured. */
  enabled: boolean;
  /** The real installed Vortex mod id, used to match the replacement. */
  modId?: string;
}

export const modUpdateState = {
  /** Display name of the mod currently being installed (used in warnings). */
  modInstallName: "",

  /** True while a mod is being updated (old version removed, new not yet deployed). */
  updateInProgress: false,

  /**
   * Profile the in-flight update belongs to. Preservation and cleanup are
   * scoped to this profile so an unrelated deployment can't discard it.
   */
  profileId: undefined as string | undefined,

  /**
   * Load order entries captured before undeployment, keyed by load order id
   * (the mod folder name). While an update is in progress these are kept in the
   * load order even though their folders are temporarily absent.
   */
  preservedEntries: new Map<string, PreservedEntry>(),
};

/** Forget any update that was being tracked. */
export function clearUpdateState(): void {
  modUpdateState.updateInProgress = false;
  modUpdateState.profileId = undefined;
  modUpdateState.preservedEntries.clear();
}
