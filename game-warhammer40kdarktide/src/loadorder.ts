import path from "path";
import { randomUUID } from "crypto";
import { orderMods, type LoadOrder, type OrderRules } from "./ordering";

import { fs, selectors, types, util } from "@nexusmods/vortex-api";

import { GAME_ID } from "./constants";
import { loadOrderState, modUpdateState, resetLoadOrderState } from "./state";

/**
 * First line written by `serializeLoadOrder`. It is a marker for humans, not a
 * mod, and must be skipped when reading the file back.
 */
export const MANAGED_HEADER = "File managed by Vortex mod manager";
const OVERRIDE_HEADER = "-- Vortex ordering overrides: ";
const PURGE_SNAPSHOT = ".vortex_load_order_purge.json";

// Deployment listeners run concurrently. Serialize writes to the recovery file
// so completion cannot recreate a snapshot that a successful FBLO read consumed.
const snapshotWrites = new Map<string, Promise<void>>();
function updateSnapshot(
  gamePath: string,
  operation: (filePath: string) => Promise<void>,
): Promise<void> {
  const filePath = path.join(gamePath, "mods", PURGE_SNAPSHOT);
  const pending = (snapshotWrites.get(filePath) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => operation(filePath));
  snapshotWrites.set(filePath, pending);
  return pending.finally(() => {
    if (snapshotWrites.get(filePath) === pending)
      snapshotWrites.delete(filePath);
  });
}

function persistSnapshot(
  gamePath: string,
  preservedFile: { scope: string; contents: string },
  purged: boolean,
): Promise<void> {
  const contents = JSON.stringify({
    ...preservedFile,
    purged,
    purgePreparing: purged && loadOrderState.purgePreparing,
    purgeFailed: purged && loadOrderState.purgeFailed,
  });
  return updateSnapshot(gamePath, (filePath) =>
    fs.writeFileAsync(filePath, contents, { encoding: "utf8" }),
  );
}

async function loadSnapshot(gamePath: string): Promise<void> {
  if (loadOrderState.gamePath !== gamePath) {
    resetLoadOrderState();
    loadOrderState.gamePath = gamePath;
  }
  if (loadOrderState.snapshotLoad === undefined) {
    const pending = (async () => {
      const filePath = path.join(gamePath, "mods", PURGE_SNAPSHOT);
      await snapshotWrites.get(filePath);
      const contents = await fs
        .readFileAsync(filePath, { encoding: "utf8" })
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
          return "";
        });
      if (contents === "") return;
      let saved: unknown;
      try {
        saved = JSON.parse(contents);
      } catch {
        return;
      }
      if (saved === null || typeof saved !== "object") return;
      const record = saved as Record<string, unknown>;
      if (
        typeof record.scope !== "string" ||
        typeof record.contents !== "string" ||
        typeof record.purged !== "boolean"
      )
        return;
      let scope: unknown;
      try {
        scope = JSON.parse(record.scope);
      } catch {
        return;
      }
      if (!Array.isArray(scope) || scope.length !== 2 || scope[0] !== gamePath)
        return;
      if (
        loadOrderState.gamePath === gamePath &&
        loadOrderState.preservedFile === undefined
      ) {
        loadOrderState.preservedFile = {
          scope: record.scope,
          contents: record.contents,
        };
        loadOrderState.purged =
          record.purged && !loadOrderState.deploymentComplete;
        // Older snapshots have no completion marker. Check their files before
        // assuming that a purge completed rather than failed before removal.
        loadOrderState.purgePreparing =
          loadOrderState.purged && record.purgePreparing !== false;
        loadOrderState.purgeFailed =
          loadOrderState.purged && record.purgeFailed === true;
      }
    })();
    loadOrderState.snapshotLoad = pending;
  }
  await loadOrderState.snapshotLoad;
}

async function consumeSnapshot(
  gamePath: string,
  scope: string,
  preservedFile: typeof loadOrderState.preservedFile,
): Promise<void> {
  if (
    loadOrderState.preservedFile === preservedFile &&
    preservedFile?.scope === scope
  ) {
    loadOrderState.preservedFile = undefined;
    await updateSnapshot(gamePath, (filePath) => fs.removeAsync(filePath));
  }
}

function scopeFor(state: types.IState): string {
  const gamePath = selectors.discoveryByGame(state, GAME_ID)?.path;
  return JSON.stringify([
    gamePath,
    (loadOrderState.gamePath === gamePath
      ? loadOrderState.profileId
      : undefined) ?? selectors.lastActiveProfileForGame(state, GAME_ID),
  ]);
}

/** will-deploy is awaited before the incoming profile's files reach disk. */
export function rememberLoadOrderProfile(
  api: types.IExtensionApi,
  profileId: string,
): void {
  const gamePath = selectors.discoveryByGame(api.getState(), GAME_ID)?.path;
  if (loadOrderState.gamePath !== gamePath) resetLoadOrderState();
  loadOrderState.gamePath = gamePath;
  loadOrderState.profileId = profileId;
}

export async function beginPurge(
  api: types.IExtensionApi,
  profileId: string,
): Promise<void> {
  rememberLoadOrderProfile(api, profileId);
  const state = api.getState();
  const gamePath = loadOrderState.gamePath;
  if (gamePath === undefined) return;
  loadOrderState.purged = true;
  loadOrderState.purgePreparing = true;
  loadOrderState.purgeFailed = false;
  loadOrderState.deploymentComplete = false;
  await loadSnapshot(gamePath);
  loadOrderState.purged = true;
  loadOrderState.purgePreparing = true;
  loadOrderState.purgeFailed = false;
  const scope = scopeFor(state);
  const contents = await fs
    .readFileAsync(path.join(gamePath, "mods", "mod_load_order.txt"), {
      encoding: "utf8",
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      return "";
    });
  // Repeated purges must not replace the original with an absent/default file.
  if (loadOrderState.preservedFile?.scope !== scope) {
    loadOrderState.preservedFile = { scope, contents };
  }
  await persistSnapshot(gamePath, loadOrderState.preservedFile, true);
}

/**
 * Vortex clears its purging activity even when it skips did-purge after an
 * error. A restart can also leave only the preparation snapshot behind.
 * Release saving when nothing was removed; otherwise retain missing choices
 * while allowing edits to reach the files that survived the failed purge.
 */
export async function reconcilePurge(
  api: types.IExtensionApi,
  completed = false,
): Promise<void> {
  if (!loadOrderState.purgePreparing) return;
  if (
    !completed &&
    api.getState().session?.base?.activity?.mods?.includes("purging")
  )
    return;
  const gamePath = loadOrderState.gamePath;
  const preservedFile = loadOrderState.preservedFile;
  if (gamePath === undefined || preservedFile === undefined) return;
  const ids = preservedFile.contents
    .split("\n")
    .filter((line) => !line.startsWith(OVERRIDE_HEADER))
    .map(parseEntryId)
    .filter((id): id is string => id !== undefined && id !== MANAGED_HEADER);
  const present = await Promise.all(
    ids.map(async (id) => {
      try {
        await fs.statAsync(path.join(gamePath, "mods", id, `${id}.mod`));
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
        return false;
      }
    }),
  );
  if (
    !loadOrderState.purgePreparing ||
    loadOrderState.gamePath !== gamePath ||
    loadOrderState.preservedFile !== preservedFile
  )
    return;
  loadOrderState.purged = present.some((exists) => !exists);
  loadOrderState.purgePreparing = false;
  loadOrderState.purgeFailed = loadOrderState.purged && !completed;
  await persistSnapshot(gamePath, preservedFile, loadOrderState.purged);
}

export async function completePurge(
  api: types.IExtensionApi,
  profileId: string,
): Promise<void> {
  rememberLoadOrderProfile(api, profileId);
  // ProcessCanceled can still emit did-purge without removing any files.
  // Inspect the result rather than leaving those mods indefinitely guarded.
  await reconcilePurge(api, true);
}

function canSavePurgedOrder(api: types.IExtensionApi): boolean {
  const activity = api.getState().session?.base?.activity?.mods;
  return (
    !loadOrderState.purgePreparing &&
    !activity?.includes("purging") &&
    !activity?.includes("deployment")
  );
}

export async function completeDeployment(
  api: types.IExtensionApi,
  profileId: string,
): Promise<void> {
  rememberLoadOrderProfile(api, profileId);
  loadOrderState.purged = false;
  loadOrderState.purgePreparing = false;
  loadOrderState.purgeFailed = false;
  loadOrderState.deploymentComplete = true;
  const gamePath = loadOrderState.gamePath;
  if (gamePath === undefined) return;
  await loadSnapshot(gamePath);
  // The saved file is consumed by the subsequent FBLO read, which may already
  // be awaiting the filesystem when this did-deploy listener runs.
  const preservedFile = loadOrderState.preservedFile;
  if (preservedFile !== undefined)
    await persistSnapshot(gamePath, preservedFile, false);
}

type SavedOverrides = Record<string, Array<[string, string[]]>>;

function readOverrides(file: string): SavedOverrides {
  try {
    const line = file
      .split("\n")
      .find((line) => line.startsWith(OVERRIDE_HEADER));
    if (!line) return {};
    const saved: unknown = JSON.parse(line.slice(OVERRIDE_HEADER.length));
    if (saved === null || typeof saved !== "object" || Array.isArray(saved))
      return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, entries]) =>
          Array.isArray(entries) &&
          entries.every(
            (entry: unknown) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              Array.isArray(entry[1]) &&
              entry[1].every((id: unknown) => typeof id === "string"),
          ),
      ),
    );
  } catch {
    return {};
  }
}

// Cache info.json parsing results per mod, invalidated by file mtime so we
// don't re-read unchanged metadata on every deserialization.
const orderRulesCache = new Map<
  string,
  { mtimeMs?: number; rules?: OrderRules }
>();

// --- helpers ---------------------------------------------------------------

function toArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter(
    (item): item is string => typeof item === "string",
  );
  return filtered.length > 0 ? filtered : undefined;
}

function sanitizeRules(
  dependencies: Record<string, unknown>,
): OrderRules | undefined {
  const required = toArray(dependencies.required);
  const selfAfter = toArray(dependencies.self_after);
  const selfBefore = toArray(dependencies.self_before);

  if (
    required === undefined &&
    selfAfter === undefined &&
    selfBefore === undefined
  ) {
    return undefined;
  }

  return { required, selfAfter, selfBefore };
}

async function getOrderRules(
  modFolderPath: string,
  modId: string,
): Promise<OrderRules | undefined> {
  const metadataPath = path.join(modFolderPath, modId, "info.json");

  let mtimeMs: number | undefined;
  try {
    const stats = await fs.statAsync(metadataPath);
    mtimeMs = stats.mtimeMs;
  } catch {
    mtimeMs = undefined;
  }

  const cached = orderRulesCache.get(metadataPath);
  if (
    cached !== undefined &&
    (cached.mtimeMs === mtimeMs ||
      (mtimeMs === undefined &&
        (modUpdateState.updateInProgress || loadOrderState.purged)))
  ) {
    return cached.rules;
  }

  let rules: OrderRules | undefined;
  try {
    const raw = await fs.readFileAsync(metadataPath, { encoding: "utf8" });
    const json = JSON.parse(raw) as { dependencies?: unknown };
    if (
      json.dependencies !== null &&
      typeof json.dependencies === "object" &&
      !Array.isArray(json.dependencies)
    ) {
      rules = sanitizeRules(json.dependencies as Record<string, unknown>);
    }
  } catch {
    rules = undefined;
  }

  orderRulesCache.set(metadataPath, { mtimeMs, rules });
  return rules;
}

export type DeploymentFiles = Record<string, types.IDeployedFile[]>;

/**
 * Records `deployed folder -> real Vortex mod id` from deployment event files.
 *
 * A mod's `installationPath` is its staging folder (e.g.
 * `True Level-156-1-6-3-1719534708`), not the folder it is deployed into
 * (`true_level`), so the manifest's `source` is the reliable link between the
 * two. `relPath` is the deployed file path, so the `.mod` file's parent
 * directory is the load order id.
 */
export function rememberDeploymentFiles(
  deployment: DeploymentFiles | undefined,
): void {
  if (deployment === undefined) {
    return;
  }
  modUpdateState.deploymentRevision++;
  modUpdateState.deployedModIds.clear();
  for (const file of Object.values(deployment).flat()) {
    if (!file.relPath.toLowerCase().endsWith(".mod")) {
      continue;
    }
    const segments = file.relPath.replace(/[\\/]+$/, "").split(/[\\/]/);
    const folder = segments[segments.length - 2];
    if (folder !== undefined && folder !== "") {
      modUpdateState.deployedModIds.set(folder.toLowerCase(), file.source);
    }
  }
}

/** True when the mod folder has markers indicating it is managed by Vortex. */
async function isVortexManaged(
  modFolderPath: string,
  folder: string,
): Promise<boolean> {
  try {
    await fs.statAsync(
      path.join(modFolderPath, folder, "__folder_managed_by_vortex"),
    );
    return true;
  } catch {
    try {
      await fs.statAsync(
        path.join(modFolderPath, folder, `${folder}.mod.vortex_backup`),
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The real installed Vortex mod id for a deployed folder, so Vortex can match
 * the entry with its replacement. Falls back to the folder name (a truthy id
 * keeps Vortex from labelling the mod as unmanaged) when the deployment
 * manifest doesn't know about it yet.
 */
async function resolveModId(
  api: types.IExtensionApi,
  modFolderPath: string,
  folder: string,
): Promise<string | undefined> {
  const fromManifest = modUpdateState.deployedModIds.get(folder.toLowerCase());
  if (fromManifest !== undefined) {
    const installed = api.getState().persistent.mods[GAME_ID] ?? {};
    const owner = Object.entries(installed).find(
      ([, mod]) => mod.installationPath === fromManifest,
    );
    if (owner !== undefined) {
      // Keep the actual ID available while an update temporarily removes state.
      modUpdateState.deployedModIds.set(folder.toLowerCase(), owner[0]);
      return owner[0];
    }
    return fromManifest;
  }
  return (await isVortexManaged(modFolderPath, folder)) ? folder : undefined;
}

/** Strips the disabled marker (`-- `) from a load order line and trims it. */
function parseEntryId(line: string): string | undefined {
  const id = line
    .trim()
    .replace(/^--\s?/, "")
    .trim();
  return id === "" ? undefined : id;
}

/** Index of the last enabled dependency this mod must load after. */
function getLowerBound(
  loadOrder: LoadOrder,
  rules: OrderRules,
): number | undefined {
  if (rules.selfAfter === undefined) {
    return undefined;
  }

  let lastAfter: number | undefined;
  for (const dep of rules.selfAfter) {
    const idx = loadOrder.findIndex((mod) => mod.id === dep);
    if (
      idx >= 0 &&
      loadOrder[idx].enabled &&
      (lastAfter === undefined || idx > lastAfter)
    ) {
      lastAfter = idx;
    }
  }
  return lastAfter;
}

/** Index of the first enabled dependency this mod must load before. */
function getUpperBound(
  loadOrder: LoadOrder,
  rules: OrderRules,
): number | undefined {
  if (rules.selfBefore === undefined) {
    return undefined;
  }

  let firstBefore: number | undefined;
  for (const dep of rules.selfBefore) {
    const idx = loadOrder.findIndex((mod) => mod.id === dep);
    if (
      idx >= 0 &&
      loadOrder[idx].enabled &&
      (firstBefore === undefined || idx < firstBefore)
    ) {
      firstBefore = idx;
    }
  }
  return firstBefore;
}

function enabledDeps(loadOrder: LoadOrder, deps: string[] | undefined): string {
  if (deps === undefined) {
    return "";
  }
  return deps
    .filter((dep) => loadOrder.some((mod) => mod.id === dep && mod.enabled))
    .join(", ");
}

/** Returns the mod folders that actually contain a `<name>.mod` file. */
async function listModFolders(modFolderPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdirAsync(modFolderPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }

  const folders = await Promise.all(
    entries.map(async (name) => {
      try {
        await fs.statAsync(path.join(modFolderPath, name, `${name}.mod`));
        return name;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return undefined;
      }
    }),
  );

  return folders
    .filter(
      (name): name is string =>
        name !== undefined && name !== "dmf" && name !== "base",
    )
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// --- public API ------------------------------------------------------------

/**
 * Mark an update as in progress. Called on the pre-undeployment
 * `will-remove-mods` event (and idempotently on the later singular
 * `will-remove-mod`). While the flag is set, folders that are temporarily
 * absent are kept in the load order instead of dropped, which preserves the
 * updated mod's position and enabled state through intermediate reads.
 */
export function beginUpdate(api: types.IExtensionApi): void {
  modUpdateState.updateInProgress = true;
  modUpdateState.profileId =
    modUpdateState.profileId ??
    selectors.lastActiveProfileForGame(api.getState(), GAME_ID);
}

export async function deserializeLoadOrder(
  api: types.IExtensionApi,
): Promise<LoadOrder> {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  if (discovery?.path === undefined) {
    return [];
  }
  // Capture the event's profile before any asynchronous work. A later incoming
  // deployment must not relabel this read as another profile.
  const scope = scopeFor(state);

  // A session may open the load-order page before any deployment event fires.
  // Read the persisted manifest once per game path; events keep it fresh after
  // that. Do not let a slow disk read replace newer event data.
  if (modUpdateState.manifestPath !== discovery.path) {
    const previousPath = modUpdateState.manifestPath;
    const revision = modUpdateState.deploymentRevision;
    modUpdateState.manifestPath = discovery.path;
    if (previousPath !== undefined) modUpdateState.deployedModIds.clear();
    modUpdateState.manifestLoad = (async () => {
      try {
        const manifest = await util.getManifest(api, "", GAME_ID);
        if (
          revision === modUpdateState.deploymentRevision &&
          modUpdateState.manifestPath === discovery.path
        ) {
          rememberDeploymentFiles({ "": manifest.files });
        }
      } catch {
        // A missing/unreadable deployment manifest must not prevent manual mods
        // from loading. A later deployment event can supply the ownership map.
      }
    })();
  }
  await Promise.all([
    modUpdateState.manifestLoad,
    loadSnapshot(discovery.path),
  ]);
  await reconcilePurge(api);

  const modFolderPath = path.join(discovery.path, "mods");
  const loadOrderPath = path.join(modFolderPath, "mod_load_order.txt");

  const diskFile = await fs
    .readFileAsync(loadOrderPath, { encoding: "utf8" })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      return "";
    });

  const preservedFile =
    loadOrderState.gamePath === discovery.path
      ? loadOrderState.preservedFile
      : undefined;
  const loadOrderFile =
    preservedFile?.scope === scope ? preservedFile.contents : diskFile;
  const modFolders = await listModFolders(modFolderPath);
  const readToken = randomUUID();
  const overrides = new Map(readOverrides(loadOrderFile)[scope] ?? []);

  const loadOrder: LoadOrder = [];
  const seen = new Set<string>();
  for (const line of loadOrderFile.split("\n")) {
    if (line.startsWith(OVERRIDE_HEADER)) continue;
    const id = parseEntryId(line);
    if (id === undefined || id === MANAGED_HEADER || seen.has(id)) {
      continue;
    }

    // Keep entries whose folder is only temporarily absent because it is being
    // replaced. Without an update in flight the mod is really uninstalled.
    if (
      !modFolders.includes(id) &&
      !modUpdateState.updateInProgress &&
      !(loadOrderState.gamePath === discovery.path && loadOrderState.purged)
    ) {
      continue;
    }

    seen.add(id);
    loadOrder.push({
      id,
      name: id,
      modId: await resolveModId(api, modFolderPath, id),
      enabled: !line.trimStart().startsWith("--"),
      data: {
        orderRules: await getOrderRules(modFolderPath, id),
        scope,
        readToken,
        ignoredBefore: overrides.get(id),
      },
    });
  }

  // Add any mods present on disk but missing from the load order file,
  // respecting their declared ordering rules.
  const pending: LoadOrder = [];
  for (const folder of modFolders) {
    if (loadOrder.some((mod) => mod.id === folder)) {
      continue;
    }

    pending.push({
      id: folder,
      name: folder,
      modId: await resolveModId(api, modFolderPath, folder),
      enabled: true,
      data: {
        orderRules: await getOrderRules(modFolderPath, folder),
        scope,
        readToken,
      },
    });
  }

  const ordered = orderMods([...loadOrder, ...pending]);
  // FBLO may skip serialization when this matches its existing Redux order.
  // Persist discovery/metadata-driven sorting now so the game and UI agree even
  // on that path. No user intent is inferred during a disk read.
  // Leave files alone during purge/deployment. Once purging stops, surviving
  // mods can receive changes; keep missing choices until deployment finishes.
  const purged =
    loadOrderState.gamePath === discovery.path && loadOrderState.purged;
  if (
    (!purged ||
      (canSavePurgedOrder(api) &&
        (loadOrderState.purgeFailed || modFolders.length > 0))) &&
    (ordered.length > 0 || loadOrderFile !== "")
  ) {
    await writeOrder(
      loadOrderPath,
      ordered,
      scope,
      diskFile,
      preservedFile?.contents,
    );
    if (!purged) await consumeSnapshot(discovery.path, scope, preservedFile);
  }
  return ordered;
}

export async function serializeLoadOrder(
  api: types.IExtensionApi,
  loadOrder: LoadOrder,
  prev: LoadOrder = [],
): Promise<void> {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  if (discovery?.path === undefined) {
    throw new util.ProcessCanceled("Game is not discovered");
  }

  const loadOrderPath = path.join(discovery.path, "mods", "mod_load_order.txt");
  const scope = scopeFor(state);
  await loadSnapshot(discovery.path);
  await reconcilePurge(api);

  // The action check normalizes before Redux stores the order, so UI and disk
  // agree. Normalize defensively for direct callers as well.
  const ordered = orderMods(loadOrder, prev);
  try {
    const previousFile = await fs
      .readFileAsync(loadOrderPath, { encoding: "utf8" })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
        return "";
      });
    const preservedFile =
      loadOrderState.gamePath === discovery.path
        ? loadOrderState.preservedFile
        : undefined;
    if (loadOrderState.gamePath === discovery.path && loadOrderState.purged) {
      // Preserve UI changes until redeployment, deferring the game-file write
      // while the deployment engine is removing or replacing files.
      loadOrderState.preservedFile = {
        scope,
        contents: orderContents(
          ordered,
          scope,
          previousFile,
          preservedFile?.contents,
        ),
      };
      await persistSnapshot(discovery.path, loadOrderState.preservedFile, true);
      if (canSavePurgedOrder(api)) {
        // Purging has stopped. Surviving mods must see the user's changes now,
        // including manual mods and removals the activator silently skipped.
        // The recovery file still owns choices for the removed mods.
        await writeOrder(
          loadOrderPath,
          ordered,
          scope,
          previousFile,
          preservedFile?.contents,
        );
      }
      return;
    }
    await writeOrder(
      loadOrderPath,
      ordered,
      scope,
      previousFile,
      preservedFile?.contents,
    );
    await consumeSnapshot(discovery.path, scope, preservedFile);
  } catch (err) {
    const allowReport = !(err instanceof util.UserCanceled);
    api.showErrorNotification?.("Failed to save load order", err, {
      allowReport,
    });
    throw err;
  }
}

function orderContents(
  ordered: LoadOrder,
  scope: string,
  previousFile: string,
  preservedFile?: string,
): string {
  const entries: Array<[string, string[]]> = ordered
    .filter((m) => m.data?.ignoredBefore?.length)
    .map((m) => [m.id, m.data!.ignoredBefore!]);
  // Keep exceptions for other profiles when the shared game file changes.
  // Storing metadata with the order avoids separate-file partial writes.
  const saved = {
    ...readOverrides(preservedFile ?? ""),
    ...readOverrides(previousFile),
  };
  if (entries.length) saved[scope] = entries;
  else delete saved[scope];
  const metadata = Object.keys(saved).length
    ? `${OVERRIDE_HEADER}${JSON.stringify(saved)}\n`
    : "";
  const output = ordered
    .map((mod) => (mod.enabled ? mod.id : `-- ${mod.id}`))
    .join("\n");
  return `-- ${MANAGED_HEADER}\n${metadata}${output}`;
}

async function writeOrder(
  loadOrderPath: string,
  ordered: LoadOrder,
  scope: string,
  previousFile: string,
  preservedFile?: string,
): Promise<void> {
  const contents = orderContents(ordered, scope, previousFile, preservedFile);
  if (contents !== previousFile) {
    await fs.writeFileAsync(loadOrderPath, contents, { encoding: "utf8" });
  }
}

export interface OrderWarning {
  id: string;
  kind: "ordering" | "dependency";
  reason: string;
}

/** Shared rule checks for advisory rows and the instructions panel. */
export function getOrderWarnings(current: LoadOrder): OrderWarning[] {
  const warnings: OrderWarning[] = [];

  for (let idx = 0; idx < current.length; idx++) {
    const mod = current[idx];
    const rules = mod.data?.orderRules;
    if (!mod.enabled || rules === undefined) {
      continue;
    }

    const lowerBound = getLowerBound(current, rules);
    const upperBound = getUpperBound(current, rules);

    let errorMessage: string | undefined;
    if (lowerBound !== undefined || upperBound !== undefined) {
      if (lowerBound !== undefined && upperBound !== undefined) {
        if (idx <= lowerBound || idx >= upperBound) {
          errorMessage =
            `Should be after ${enabledDeps(current, rules.selfAfter)} ` +
            `but before ${enabledDeps(current, rules.selfBefore)}.`;
        }
      } else if (lowerBound !== undefined) {
        if (idx <= lowerBound) {
          errorMessage = `Should be after ${enabledDeps(current, rules.selfAfter)}.`;
        }
      } else if (upperBound !== undefined) {
        if (idx >= upperBound) {
          errorMessage = `Should be before ${enabledDeps(current, rules.selfBefore)}.`;
        }
      }
    }

    if (errorMessage !== undefined) {
      warnings.push({ id: mod.id, kind: "ordering", reason: errorMessage });
    }

    if (rules.required !== undefined) {
      const missing = rules.required.filter((dep) => {
        const requiredMod = current.find((m) => m.id === dep);
        return requiredMod === undefined || !requiredMod.enabled;
      });
      if (missing.length > 0) {
        warnings.push({
          id: mod.id,
          kind: "dependency",
          reason: `Requires ${missing.join(", ")}.`,
        });
      }
    }
  }
  return warnings;
}

export async function validate(
  prev: LoadOrder,
  current: LoadOrder,
): Promise<types.IValidationResult | undefined> {
  const messages = new Map<string, string>();
  for (const warning of getOrderWarnings(current)) {
    const existing = messages.get(warning.id);
    messages.set(
      warning.id,
      existing === undefined ? warning.reason : `${warning.reason} ${existing}`,
    );
  }
  const invalid = [...messages].map(([id, reason]) => ({ id, reason }));
  return invalid.length > 0 ? { invalid } : undefined;
}

/** Rule failures are advisory: FBLO's invalid result can lock/reject an order. */
export async function warnAboutOrder(
  api: types.IExtensionApi,
  prev: LoadOrder,
  current: LoadOrder,
): Promise<types.IValidationResult | undefined> {
  // Clear notifications left by earlier extension versions. Warnings now live
  // in the usage instructions, independently of FBLO's blocking validation.
  api.dismissNotification?.("darktide-load-order-rules");
  return undefined;
}
