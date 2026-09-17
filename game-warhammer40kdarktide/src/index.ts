import path from "path";
import { spawn, spawnSync } from "child_process";

import { fs, selectors, types, util } from "@nexusmods/vortex-api";

import { GAME_ID, MS_APPID, STEAMAPP_ID, TOOLS } from "./constants";
import { clearUpdateState, modUpdateState } from "./state";
import {
  beginUpdate,
  type DeploymentFiles,
  deserializeLoadOrder,
  rememberDeploymentFiles,
  serializeLoadOrder,
  warnAboutOrder,
} from "./loadorder";

import { orderMods, type LoadOrder } from "./ordering";
import { createUsageInstructions } from "./UsageInstructions";
import { createLoadOrderRow } from "./LoadOrderRow";

const MOD_FILE_EXT = ".mod";
const BAT_FILE_EXT = ".bat";

// The installer callbacks don't receive the api, so keep a module-level
// reference. It's set as soon as `main` runs (context.api is available).
let api: types.IExtensionApi | undefined;

function sendWarning(id: string, message: string): void {
  api?.sendNotification?.({
    id: `Darktide-${id}`,
    type: "warning",
    message,
    allowSuppress: true,
  });
}

// --- installer ------------------------------------------------------------

function testSupportedContent(
  files: string[],
  gameId: string,
): Promise<types.ISupportedResult> {
  const supported =
    gameId === GAME_ID &&
    files.some(
      (file) =>
        path.extname(file).toLowerCase() === MOD_FILE_EXT ||
        (path.extname(file).toLowerCase() === BAT_FILE_EXT &&
          (file.includes("toggle_darktide_mods") ||
            file.includes("_mod_load_order_file_maker"))),
    );

  // Don't resend the alert in case of updates.
  if (gameId === GAME_ID && !supported && !modUpdateState.updateInProgress) {
    sendWarning(
      `Unsupported-Root-Install-${modUpdateState.modInstallName}`,
      `${modUpdateState.modInstallName} could not pass our support test, it'll be installed in the root directory`,
    );
  }

  return Promise.resolve({ supported, requiredFiles: [] });
}

async function installContent(files: string[]): Promise<types.IInstallResult> {
  const modFile = files.find(
    (file) => path.extname(file).toLowerCase() === MOD_FILE_EXT,
  );

  if (modFile !== undefined && modFile.split("\\").length < 3) {
    return installMod(files);
  }

  const loadOrderFileMaker = files.find(
    (file) =>
      path.extname(file).toLowerCase() === BAT_FILE_EXT &&
      file.includes("_mod_load_order_file_maker"),
  );

  if (loadOrderFileMaker !== undefined) {
    return installModLoadOrderFileMaker(files);
  }

  return rootGameInstall(files);
}

function installMod(files: string[]): types.IInstallResult {
  const modFile = files.find(
    (file) => path.extname(file).toLowerCase() === MOD_FILE_EXT,
  );
  if (modFile === undefined) {
    return { instructions: [] };
  }

  const idx = modFile.indexOf(path.basename(modFile));
  const rootPath = path.dirname(modFile);
  const modName = path.basename(modFile, MOD_FILE_EXT);
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep),
  );

  const instructions: types.IInstruction[] = filtered.map((file) => ({
    type: "copy",
    source: file,
    destination: path.join("mods", modName, file.slice(idx)),
  }));
  return { instructions };
}

function rootGameInstall(files: string[]): types.IInstallResult {
  // Check for the mod loader (DML), other mods could be added here as well.
  const supportedRoot = files.find(
    (file) =>
      path.extname(file).toLowerCase() === BAT_FILE_EXT &&
      file.includes("toggle_darktide_mods"),
  );

  // Don't resend the alert in case of updates.
  if (supportedRoot === undefined && !modUpdateState.updateInProgress) {
    sendWarning(
      `Root-Install-${modUpdateState.modInstallName}`,
      `${modUpdateState.modInstallName} will be installed in the root directory of the game. If it's normal just ignore this warning`,
    );
  }

  const rootPath = "";
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep),
  );

  const instructions: types.IInstruction[] = filtered.map((file) => ({
    type: "copy",
    source: file,
    destination: path.join("", file),
  }));
  return { instructions };
}

function installModLoadOrderFileMaker(files: string[]): types.IInstallResult {
  const loadOrderFileMaker = files.find(
    (file) =>
      path.extname(file).toLowerCase() === BAT_FILE_EXT &&
      file.includes("_mod_load_order_file_maker"),
  );
  if (loadOrderFileMaker === undefined) {
    return { instructions: [] };
  }

  const idx = loadOrderFileMaker.indexOf(path.basename(loadOrderFileMaker));
  const rootPath = path.dirname(loadOrderFileMaker);
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep),
  );

  const instructions: types.IInstruction[] = filtered.map((file) => ({
    type: "copy",
    source: file,
    destination: path.join("mods", file.slice(idx)),
  }));
  return { instructions };
}

// --- game setup ------------------------------------------------------------

async function findGame(): Promise<types.IGameStoreEntry | undefined> {
  const results = await util.GameStoreHelper.find({
    steam: STEAMAPP_ID,
    xbox: MS_APPID,
  });
  return results[0];
}

function requiresLauncher(
  _gamePath: string,
  store?: string,
): Promise<{ launcher: string; addInfo?: unknown } | undefined> {
  if (store === "xbox") {
    return Promise.resolve({
      launcher: "xbox",
      addInfo: {
        appId: MS_APPID,
        // appExecName is the <Application id=""> in the appxmanifest.xml file.
        parameters: [{ appExecName: "launcher.launcher" }],
      },
    });
  }
  return Promise.resolve(undefined);
}

async function prepareForModding(
  discovery: types.IDiscoveryResult,
): Promise<void> {
  if (discovery.path === undefined) {
    return;
  }
  const gamePath = discovery.path;

  // Ensure the mods directory exists.
  await fs.ensureDirWritableAsync(path.join(gamePath, "mods"));

  // Ensure the mod load order file exists.
  await fs.ensureFileAsync(path.join(gamePath, "mods", "mod_load_order.txt"));

  // Check if DMF is installed.
  await checkForDMF(path.join(gamePath, "mods", "dmf"));

  // Check if DML is installed.
  await checkForDML(path.join(gamePath, "toggle_darktide_mods.bat"));
}

async function checkForDMF(modFrameworkPath: string): Promise<void> {
  await fs.statAsync(modFrameworkPath).catch(() => {
    api?.sendNotification?.({
      id: "darktide-mod-framework-missing",
      type: "warning",
      title: "Darktide Mod Framework not installed",
      message: "Darktide Mod Framework is required to mod Darktide.",
      actions: [
        {
          title: "Get DMF",
          action: () =>
            util
              .opn("https://www.nexusmods.com/warhammer40kdarktide/mods/8")
              .catch(() => undefined),
        },
      ],
    });
  });
}

async function checkForDML(toggleModsPath: string): Promise<void> {
  await fs.statAsync(toggleModsPath).catch(() => {
    api?.sendNotification?.({
      id: "toggle_darktide_mods-missing",
      type: "warning",
      title: "Darktide Mod Loader not installed",
      message: "Darktide Mod Loader is required to mod Darktide.",
      actions: [
        {
          title: "Get DML",
          action: () =>
            util
              .opn("https://www.nexusmods.com/warhammer40kdarktide/mods/19")
              .catch(() => undefined),
        },
      ],
    });
  });
}

// --- main ------------------------------------------------------------------

function main(context: types.IExtensionContext): boolean {
  api = context.api;

  context.registerInstaller(
    "warhammer40kdarktide-mod",
    25,
    testSupportedContent,
    installContent,
  );

  context.registerGame({
    id: GAME_ID,
    name: "Warhammer 40,000: Darktide",
    logo: "gameart.png",
    queryPath: util.toBlue(findGame) as types.IGame["queryPath"],
    queryModPath: () => "",
    supportedTools: TOOLS,
    mergeMods: true,
    directoryCleaning: "tag",
    requiresCleanup: false,
    requiresLauncher: util.toBlue(
      requiresLauncher,
    ) as types.IGame["requiresLauncher"],
    executable: () => "binaries/Darktide.exe",
    parameters: [
      "--bundle-dir",
      "../bundle",
      "--ini",
      "settings",
      "--backend-auth-service-url",
      "https://bsp-auth-prod.atoma.cloud",
      "--backend-title-service-url",
      "https://bsp-td-prod.atoma.cloud",
    ],
    requiredFiles: ["launcher/Launcher.exe", "binaries/Darktide.exe"],
    setup: util.toBlue((discovery: types.IDiscoveryResult) =>
      prepareForModding(discovery),
    ),
    environment: {
      SteamAPPId: STEAMAPP_ID,
    },
    details: {
      steamAppId: parseInt(STEAMAPP_ID, 10),
    },
  });

  context.registerLoadOrder({
    gameId: GAME_ID,
    validate: ((prev: LoadOrder, current: LoadOrder) =>
      warnAboutOrder(
        context.api,
        prev,
        current,
      )) as types.ILoadOrderGameInfo["validate"],
    deserializeLoadOrder: () => deserializeLoadOrder(context.api),
    serializeLoadOrder: (loadOrder, prev) =>
      serializeLoadOrder(context.api, loadOrder, prev),
    toggleableEntries: true,
    noCollectionGeneration: true,
    usageInstructions: createUsageInstructions(context.api),
    customItemRenderer: createLoadOrderRow(context.api),
  });

  // Normalize the action before FBLO stores it. Sorting only inside serialize
  // leaves Redux/the displayed rows in the host-restored order. Dispatching a
  // second load-order action from serialize causes a feedback loop instead.
  const normalizeOrderAction = (
    state: types.IState & {
      persistent: { loadOrder?: Record<string, LoadOrder> };
    },
    action: any,
  ): undefined => {
    const { profileId } = action.payload ?? {};
    if (selectors.profileById(state, profileId)?.gameId !== GAME_ID) return;
    const previous = (state.persistent.loadOrder?.[profileId] ??
      []) as LoadOrder;
    const incoming =
      action.type === "SET_FB_LOAD_ORDER_ENTRY"
        ? previous.map((entry) =>
            entry.id === action.payload.loEntry.id
              ? action.payload.loEntry
              : entry,
          )
        : action.payload.loadOrder;
    if (!Array.isArray(incoming)) return;
    action.type = "SET_FB_LOAD_ORDER";
    action.payload = {
      ...action.payload,
      loadOrder: orderMods(incoming, previous),
    };
  };
  context.registerActionCheck(
    "SET_FB_LOAD_ORDER",
    normalizeOrderAction as unknown as Parameters<
      types.IExtensionContext["registerActionCheck"]
    >[1],
  );
  context.registerActionCheck(
    "SET_FB_LOAD_ORDER_ENTRY",
    normalizeOrderAction as unknown as Parameters<
      types.IExtensionContext["registerActionCheck"]
    >[1],
  );

  context.once(() => {
    // Patch on deploy. `did-deploy` is global, so only react to Darktide's own
    // profiles - deploying another game must not patch Darktide or discard a
    // Darktide update that is still in flight.
    context.api.onAsync(
      "did-deploy",
      async (profileId: string, deployment?: DeploymentFiles) => {
        if (!isDarktideProfile(context.api, profileId)) {
          return;
        }

        // Refresh the folder -> mod id map so the load order can point each
        // entry at the installed mod Vortex knows about.
        rememberDeploymentFiles(deployment);

        // The replacement has been deployed; preservation is no longer needed.
        clearUpdateState();

        const discovery = selectors.discoveryByGame(
          context.api.getState(),
          GAME_ID,
        );
        if (discovery?.path === undefined) {
          return;
        }
        try {
          spawn(path.join(discovery.path, "tools", "dtkit-patch.exe"), [
            "--patch",
          ]).on("error", () => undefined);
        } catch {
          // ignore
        }
      },
    );

    // `will-deploy` carries the previous deployment files by mod type. Keep
    // their mapping available while files are being replaced.
    context.api.onAsync(
      "will-deploy",
      async (profileId: string, deployment?: DeploymentFiles) => {
        if (!isDarktideProfile(context.api, profileId)) {
          return;
        }
        rememberDeploymentFiles(deployment);
      },
    );

    // Unpatch on purge. `will-purge` is global too, so scope it to Darktide.
    context.api.events.on("will-purge", (profileId: string) => {
      if (!isDarktideProfile(context.api, profileId)) {
        return;
      }

      clearUpdateState();

      const discovery = selectors.discoveryByGame(
        context.api.getState(),
        GAME_ID,
      );
      if (discovery?.path === undefined) {
        return;
      }
      try {
        spawnSync(path.join(discovery.path, "tools", "dtkit-patch.exe"), [
          "--unpatch",
        ]);
      } catch {
        // ignore
      }
    });

    context.api.events.on(
      "will-install-mod",
      (gameId: string, _archiveId: string, modId: string) => {
        if (gameId !== GAME_ID) return;
        modUpdateState.modInstallName = modId.split("-")[0];
      },
    );

    // An update removes the old mod version before installing the new one.
    // `will-remove-mods` fires *before* the old files are undeployed, which is
    // the only point at which the affected entries can still be captured; the
    // later singular `will-remove-mod` repeats the same mods, so handling both
    // (idempotently) keeps the guard active across the whole window.
    const onWillRemove = async (
      gameId: string,
      _modIds: string[],
      removeOpts?: types.IRemoveModOptions,
    ) => {
      if (gameId !== GAME_ID || removeOpts?.willBeReplaced !== true) {
        return;
      }
      beginUpdate(context.api);
    };

    context.api.onAsync("will-remove-mods", onWillRemove);
    context.api.onAsync(
      "will-remove-mod",
      (gameId: string, modId: string, removeOpts?: types.IRemoveModOptions) =>
        onWillRemove(gameId, [modId], removeOpts),
    );
  });

  return true;
}

/** True when the profile belongs to Darktide (deployment events are global). */
export function isDarktideProfile(
  api: types.IExtensionApi,
  profileId?: string,
): boolean {
  if (profileId === undefined) {
    return false;
  }
  return selectors.profileById(api.getState(), profileId)?.gameId === GAME_ID;
}

export default main;
