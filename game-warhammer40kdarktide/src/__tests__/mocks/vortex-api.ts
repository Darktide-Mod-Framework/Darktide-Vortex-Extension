/**
 * Minimal in-memory stand-in for the parts of the Vortex API the extension
 * uses at runtime. `@nexusmods/vortex-api` ships type declarations only, so
 * tests resolve it here (see `vitest.config.ts`).
 */
import path from "path";

export const GAME_ID = "warhammer40kdarktide";

export const vfs = {
  dirs: new Set<string>(),
  files: new Map<string, string>(),
};

export const vortexState: any = {
  discovery: {},
  profiles: {},
  lastActiveProfile: {},
  persistent: { mods: {} },
};

export function resetAll(): void {
  vfs.dirs.clear();
  vfs.files.clear();
  vortexState.discovery = {};
  vortexState.profiles = {};
  vortexState.lastActiveProfile = {};
  vortexState.persistent = { mods: {} };
}

function norm(filePath: string): string {
  return path.resolve(filePath);
}

/** Absolute path of the mods directory for the currently discovered game. */
function modsPath(): string {
  const gamePath = vortexState.discovery[GAME_ID]?.path;
  if (gamePath === undefined) {
    throw new Error("test game path is not set");
  }
  return norm(path.join(gamePath, "mods"));
}

export function setGamePath(gamePath: string): void {
  vortexState.discovery[GAME_ID] = { path: gamePath };
  vfs.dirs.add(norm(gamePath));
  vfs.dirs.add(norm(path.join(gamePath, "mods")));
}

/** Registers `modId -> installationPath` for the installed Vortex mods. */
export function setInstalledMods(
  mods: Record<string, { installationPath: string }>,
): void {
  vortexState.persistent.mods[GAME_ID] = mods;
}

/** Installs one Vortex mod per folder, using `<folder>-id` as the mod id. */
export function installMods(...folders: string[]): void {
  const mods: Record<string, { installationPath: string }> = {};
  for (const folder of folders) {
    mods[`${folder}-id`] = { installationPath: path.join("mods", folder) };
  }
  setInstalledMods(mods);
}

const mtimes = new Map<string, number>();
let nextMtime = 0;

export function writeFile(filePath: string, content: string): void {
  const resolved = norm(filePath);
  vfs.files.set(resolved, content);
  mtimes.set(resolved, ++nextMtime);

  let dir = path.dirname(resolved);
  while (!vfs.dirs.has(dir)) {
    vfs.dirs.add(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
}

export function readFileText(filePath: string): string | undefined {
  return vfs.files.get(norm(filePath));
}

/** Adds `mods/<name>/<name>.mod` so the folder counts as an installed mod. */
export function addModFolder(name: string): void {
  const folder = path.join(modsPath(), name);
  vfs.dirs.add(norm(folder));
  writeFile(path.join(folder, `${name}.mod`), "");
}

/** Removes a mod folder and everything under it (simulates undeployment). */
export function removeModFolder(name: string): void {
  const folder = norm(path.join(modsPath(), name));
  vfs.dirs.delete(folder);
  for (const key of [...vfs.files.keys()]) {
    if (key === folder || key.startsWith(folder + path.sep)) {
      vfs.files.delete(key);
    }
  }
}

export const fs = {
  async statAsync(filePath: string): Promise<{ mtimeMs: number }> {
    const resolved = norm(filePath);
    if (vfs.dirs.has(resolved) || vfs.files.has(resolved)) {
      return { mtimeMs: mtimes.get(resolved) ?? 0 };
    }
    throw Object.assign(new Error(`ENOENT: ${resolved}`), { code: "ENOENT" });
  },
  async readFileAsync(filePath: string): Promise<string> {
    const resolved = norm(filePath);
    const content = vfs.files.get(resolved);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${resolved}`), { code: "ENOENT" });
    }
    return content;
  },
  async readdirAsync(dirPath: string): Promise<string[]> {
    const resolved = norm(dirPath);
    if (!vfs.dirs.has(resolved)) {
      throw Object.assign(new Error(`ENOENT: ${resolved}`), { code: "ENOENT" });
    }
    const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
    const names = new Set<string>();
    for (const entry of [...vfs.dirs, ...vfs.files.keys()]) {
      if (entry.startsWith(prefix)) {
        const first = entry.slice(prefix.length).split(path.sep)[0];
        if (first) {
          names.add(first);
        }
      }
    }
    return [...names];
  },
  async writeFileAsync(filePath: string, data: string): Promise<void> {
    writeFile(filePath, data);
  },
  async ensureDirWritableAsync(dirPath: string): Promise<void> {
    vfs.dirs.add(norm(dirPath));
  },
  async ensureFileAsync(filePath: string): Promise<void> {
    writeFile(filePath, readFileText(filePath) ?? "");
  },
  async removeAsync(filePath: string): Promise<void> {
    const resolved = norm(filePath);
    vfs.files.delete(resolved);
    vfs.dirs.delete(resolved);
  },
};

export const selectors = {
  discoveryByGame: (state: any, gameId: string) => state?.discovery?.[gameId],
  profileById: (state: any, profileId: string) => state?.profiles?.[profileId],
  lastActiveProfileForGame: (state: any, gameId: string) =>
    state?.lastActiveProfile?.[gameId],
};

export class DataInvalid extends Error {}

export class ProcessCanceled extends Error {}
export class UserCanceled extends Error {}

export const util = {
  DataInvalid,
  ProcessCanceled,
  UserCanceled,
  toBlue: (fn: unknown) => fn,
  opn: async () => undefined,
  GameStoreHelper: { find: async () => [] },
  getManifest: async (
    ..._args: unknown[]
  ): Promise<{ files: Array<{ relPath: string; source: string }> }> => {
    throw Object.assign(new Error("manifest not found"), { code: "ENOENT" });
  },
};

// Only used in type positions; present so the import resolves at runtime.
export const types = {};
