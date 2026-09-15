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

// Cache info.json parsing results per mod, invalidated by file mtime so we
// don't re-read unchanged metadata on every deserialization.
const orderRulesCache = new Map<string, { mtimeMs?: number; rules?: OrderRules }>();

// --- helpers ---------------------------------------------------------------

function toArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter((item): item is string => typeof item === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function sanitizeRules(dependencies: Record<string, unknown>): OrderRules | undefined {
  const required = toArray(dependencies.required);
  const selfAfter = toArray(dependencies.self_after);
  const selfBefore = toArray(dependencies.self_before);

  if (required === undefined && selfAfter === undefined && selfBefore === undefined) {
    return undefined;
  }

  return { required, selfAfter, selfBefore };
}

async function getOrderRules(modFolderPath: string, modId: string): Promise<OrderRules | undefined> {
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

/** Index of the last enabled dependency this mod must load after. */
function getLowerBound(loadOrder: LoadOrder, rules: OrderRules): number | undefined {
  if (rules.selfAfter === undefined) {
    return undefined;
  }

  let lastAfter: number | undefined;
  for (const dep of rules.selfAfter) {
    const idx = loadOrder.findIndex((mod) => mod.id === dep);
    if (idx >= 0 && loadOrder[idx].enabled && (lastAfter === undefined || idx > lastAfter)) {
      lastAfter = idx;
    }
  }
  return lastAfter;
}

/** Index of the first enabled dependency this mod must load before. */
function getUpperBound(loadOrder: LoadOrder, rules: OrderRules): number | undefined {
  if (rules.selfBefore === undefined) {
    return undefined;
  }

  let firstBefore: number | undefined;
  for (const dep of rules.selfBefore) {
    const idx = loadOrder.findIndex((mod) => mod.id === dep);
    if (idx >= 0 && loadOrder[idx].enabled && (firstBefore === undefined || idx < firstBefore)) {
      firstBefore = idx;
    }
  }
  return firstBefore;
}

function insertModIntoLoadOrder(loadOrder: LoadOrder, addMod: LoadOrder[number]): void {
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

function enabledDeps(loadOrder: LoadOrder, deps: string[] | undefined): string {
  if (deps === undefined) {
    return "";
  }
  return deps.filter((dep) => loadOrder.some((mod) => mod.id === dep && mod.enabled)).join(", ");
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
    .filter((name): name is string => name !== undefined && name !== "dmf" && name !== "base")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

async function isVortexManaged(modFolderPath: string, modId: string): Promise<boolean> {
  try {
    await fs.statAsync(path.join(modFolderPath, modId, "__folder_managed_by_vortex"));
    return true;
  } catch {
    try {
      await fs.statAsync(path.join(modFolderPath, modId, `${modId}.mod.vortex_backup`));
      return true;
    } catch {
      return false;
    }
  }
}

// --- public API ------------------------------------------------------------

export async function deserializeLoadOrder(api: types.IExtensionApi): Promise<LoadOrder> {
  // During an "update all profiles" cycle Vortex would otherwise drop the
  // updated mod from the load order, so hand back a placeholder instead.
  if (modUpdateState.updateAllProfiles) {
    return [
      {
        id: "mod update in progress, please wait. Refresh when finished. \n To avoid this wait, only update current profile",
        name: "Mod update in progress",
        enabled: false,
      },
    ];
  }

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
    const id = line.replace(/-- /g, "").trim();
    if (id === "" || !modFolders.includes(id)) {
      continue;
    }

    loadOrder.push({
      id,
      name: id,
      modId: (await isVortexManaged(modFolderPath, id)) ? id : undefined,
      enabled: !line.startsWith("--"),
      data: { orderRules: await getOrderRules(modFolderPath, id) },
    });
  }

  // Add any mods present on disk but missing from the load order file,
  // respecting their declared ordering rules.
  for (const folder of modFolders) {
    if (!loadOrder.some((mod) => mod.id === folder)) {
      insertModIntoLoadOrder(loadOrder, {
        id: folder,
        name: folder,
        modId: (await isVortexManaged(modFolderPath, folder)) ? folder : undefined,
        enabled: true,
        data: { orderRules: await getOrderRules(modFolderPath, folder) },
      });
    }
  }

  return loadOrder;
}

export async function serializeLoadOrder(
  api: types.IExtensionApi,
  loadOrder: LoadOrder,
): Promise<void> {
  if (modUpdateState.updateAllProfiles) {
    return;
  }

  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, GAME_ID);
  if (discovery?.path === undefined) {
    throw new util.ProcessCanceled("Game is not discovered");
  }

  const loadOrderPath = path.join(discovery.path, "mods", "mod_load_order.txt");
  const output = loadOrder.map((mod) => (mod.enabled ? mod.id : `-- ${mod.id}`)).join("\n");

  try {
    await fs.writeFileAsync(loadOrderPath, `-- File managed by Vortex mod manager\n${output}`, {
      encoding: "utf8",
    });
  } catch (err) {
    const allowReport = !(err instanceof util.UserCanceled);
    api.showErrorNotification?.("Failed to save load order", err, { allowReport });
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
          errorMessage === undefined ? requireMessage : `${requireMessage} ${errorMessage}`;
      }
    }

    if (errorMessage !== undefined) {
      invalid.push({ id: mod.id, reason: errorMessage });
    }
  }

  return invalid.length > 0 ? { invalid } : undefined;
}
