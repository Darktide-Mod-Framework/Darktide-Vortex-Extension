import path from "path";

import { fs, selectors, types, util } from "@nexusmods/vortex-api";

import { GAME_ID } from "./constants";
import { modUpdateState } from "./state";

/**
 * Rules read from a mod's optional `info.json` file, following the community
 * convention documented at:
 * https://dmf-docs.darkti.de/#/expanded-metadata
 */
interface OrderRules {
  required?: string[];
  selfAfter?: string[];
  selfBefore?: string[];
}

type LoadOrderEntryData = { orderRules?: OrderRules };
type LoadOrder = types.ILoadOrderEntry<LoadOrderEntryData>[];

/**
 * First line written by `serializeLoadOrder`. It is a marker for humans, not a
 * mod, and must be skipped when reading the file back.
 */
export const MANAGED_HEADER = "File managed by Vortex mod manager";

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

  const cached = orderRulesCache.get(modId);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
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

  orderRulesCache.set(modId, { mtimeMs, rules });
  return rules;
}

/**
 * Records `deployed folder -> real Vortex mod id` from a deployment manifest.
 *
 * A mod's `installationPath` is its staging folder (e.g.
 * `True Level-156-1-6-3-1719534708`), not the folder it is deployed into
 * (`true_level`), so the manifest's `source` is the reliable link between the
 * two. `relPath` is the deployed file path, so the `.mod` file's parent
 * directory is the load order id.
 */
export function rememberDeploymentManifest(
  deployment: types.IDeploymentManifest | undefined,
): void {
  for (const file of deployment?.files ?? []) {
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
async function isVortexManaged(modFolderPath: string, folder: string): Promise<boolean> {
  try {
    await fs.statAsync(path.join(modFolderPath, folder, "__folder_managed_by_vortex"));
    return true;
  } catch {
    try {
      await fs.statAsync(path.join(modFolderPath, folder, `${folder}.mod.vortex_backup`));
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
  modFolderPath: string,
  folder: string,
): Promise<string | undefined> {
  const fromManifest = modUpdateState.deployedModIds.get(folder.toLowerCase());
  if (fromManifest !== undefined) {
    return fromManifest;
  }
  return (await isVortexManaged(modFolderPath, folder)) ? folder : undefined;
}

/** Strips the disabled marker (`-- `) from a load order line and trims it. */
function parseEntryId(line: string): string | undefined {
  const id = line.replace(/^--\s?/, "").trim();
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

function insertModIntoLoadOrder(
  loadOrder: LoadOrder,
  addMod: LoadOrder[number],
): void {
  const rules = addMod.data?.orderRules;
  let insertIdx: number | undefined;

  if (rules !== undefined) {
    const lowerBound = getLowerBound(loadOrder, rules);
    if (lowerBound !== undefined) {
      // `lowerBound + 1` is always a valid slot whenever the constraints are
      // satisfiable, so honouring the lower bound is sufficient.
      insertIdx = lowerBound + 1;
    } else {
      const upperBound = getUpperBound(loadOrder, rules);
      if (upperBound !== undefined) {
        insertIdx = upperBound;
      }
    }
  }

  if (insertIdx === undefined) {
    loadOrder.push(addMod);
  } else {
    loadOrder.splice(insertIdx, 0, addMod);
  }
}

/**
 * Orders mods that are new to the file so that `self_after`/`self_before`
 * constraints *between them* are satisfied. Without this, insertion would be
 * order-dependent: an alphabetical scan could place a mod before a dependency
 * that hasn't been added yet.
 *
 * Cycles and unsatisfiable constraints are left in their intrinsic
 * (alphabetical) order for `validate` to report.
 */
function orderNewMods(pending: LoadOrder): LoadOrder {
  if (pending.length < 2) {
    return pending;
  }

  const byId = new Map(pending.map((mod) => [mod.id, mod]));
  const mustPrecede = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>(pending.map((mod) => [mod.id, 0]));

  const addEdge = (before: string, after: string): void => {
    if (before === after || !byId.has(before) || !byId.has(after)) {
      return;
    }
    const targets = mustPrecede.get(before) ?? new Set<string>();
    if (targets.has(after)) {
      return;
    }
    targets.add(after);
    mustPrecede.set(before, targets);
    inDegree.set(after, (inDegree.get(after) ?? 0) + 1);
  };

  for (const mod of pending) {
    for (const dep of mod.data?.orderRules?.selfAfter ?? []) {
      addEdge(dep, mod.id);
    }
    for (const dep of mod.data?.orderRules?.selfBefore ?? []) {
      addEdge(mod.id, dep);
    }
  }

  const ready = pending
    .filter((mod) => (inDegree.get(mod.id) ?? 0) === 0)
    .map((mod) => mod.id);
  const result: LoadOrder = [];

  while (ready.length > 0) {
    ready.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const id = ready.shift() as string;
    result.push(byId.get(id) as LoadOrder[number]);

    for (const next of mustPrecede.get(id) ?? []) {
      const degree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, degree);
      if (degree === 0) {
        ready.push(next);
      }
    }
  }

  if (result.length < pending.length) {
    const placed = new Set(result.map((mod) => mod.id));
    for (const mod of pending) {
      if (!placed.has(mod.id)) {
        result.push(mod);
      }
    }
  }

  return result;
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
  } catch {
    return [];
  }

  const folders = await Promise.all(
    entries.map(async (name) => {
      try {
        await fs.statAsync(path.join(modFolderPath, name, `${name}.mod`));
        return name;
      } catch {
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

  const modFolderPath = path.join(discovery.path, "mods");
  const loadOrderPath = path.join(modFolderPath, "mod_load_order.txt");

  const loadOrderFile = await fs
    .readFileAsync(loadOrderPath, { encoding: "utf8" })
    .catch(() => "");

  const modFolders = await listModFolders(modFolderPath);

  const loadOrder: LoadOrder = [];
  for (const line of loadOrderFile.split("\n")) {
    const id = parseEntryId(line);
    if (id === undefined || id === MANAGED_HEADER) {
      continue;
    }

    // Keep entries whose folder is only temporarily absent because it is being
    // replaced. Without an update in flight the mod is really uninstalled.
    if (!modFolders.includes(id) && !modUpdateState.updateInProgress) {
      continue;
    }

    loadOrder.push({
      id,
      name: id,
      modId: await resolveModId(modFolderPath, id),
      enabled: !line.startsWith("--"),
      data: { orderRules: await getOrderRules(modFolderPath, id) },
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
      modId: await resolveModId(modFolderPath, folder),
      enabled: true,
      data: { orderRules: await getOrderRules(modFolderPath, folder) },
    });
  }

  for (const mod of orderNewMods(pending)) {
    insertModIntoLoadOrder(loadOrder, mod);
  }

  return loadOrder;
}

export async function serializeLoadOrder(
  api: types.IExtensionApi,
  loadOrder: LoadOrder,
): Promise<void> {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  if (discovery?.path === undefined) {
    throw new util.ProcessCanceled("Game is not discovered");
  }

  const loadOrderPath = path.join(discovery.path, "mods", "mod_load_order.txt");

  // The array handed to us is already in the order the user chose. Write it as
  // given - reordering here would override a drag-and-drop change.
  const output = loadOrder
    .map((mod) => (mod.enabled ? mod.id : `-- ${mod.id}`))
    .join("\n");

  try {
    await fs.writeFileAsync(loadOrderPath, `-- ${MANAGED_HEADER}\n${output}`, {
      encoding: "utf8",
    });
  } catch (err) {
    const allowReport = !(err instanceof util.UserCanceled);
    api.showErrorNotification?.("Failed to save load order", err, {
      allowReport,
    });
    throw err;
  }
}

export async function validate(
  prev: LoadOrder,
  current: LoadOrder,
): Promise<types.IValidationResult | undefined> {
  const invalid: Array<{ id: string; reason: string }> = [];

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

    if (rules.required !== undefined) {
      const missing = rules.required.filter((dep) => {
        const requiredMod = current.find((m) => m.id === dep);
        return requiredMod === undefined || !requiredMod.enabled;
      });
      if (missing.length > 0) {
        const requireMessage = `Requires ${missing.join(", ")}.`;
        errorMessage =
          errorMessage === undefined
            ? requireMessage
            : `${requireMessage} ${errorMessage}`;
      }
    }

    if (errorMessage !== undefined) {
      invalid.push({ id: mod.id, reason: errorMessage });
    }
  }

  return invalid.length > 0 ? { invalid } : undefined;
}
