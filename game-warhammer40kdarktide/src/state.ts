/**
 * Mutable state shared between the installer, the load order handling and the
 * event handlers. Kept in one place so it's obvious where it lives.
 */
export const modUpdateState = {
  /** True while a mod is being updated (old version removed, new not yet deployed). */
  updateInProgress: false,

  /** Display name of the mod currently being installed (used in warnings). */
  modInstallName: "",
};
