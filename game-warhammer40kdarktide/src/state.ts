/**
 * Mutable state shared between the installer, the load order handling and the
 * event handlers. Kept in one place so it's obvious where it lives and how it
 * is mutated.
 */
export const modUpdateState = {
  /** True while a "mod update for all profiles" is in progress. */
  updateAllProfiles: false,

  /** True while an individual mod update is being installed. */
  updatingMod: false,

  /** Internal mod id of the mod currently being updated. */
  updateModId: undefined as string | undefined,

  /** Display name of the mod currently being installed. */
  modInstallName: "",
};
