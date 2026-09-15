import path from "path";
import { spawn, spawnSync } from "child_process";

import { fs, selectors, types, util } from "@nexusmods/vortex-api";

import { GAME_ID, MS_APPID, STEAMAPP_ID, TOOLS } from "./constants";
import { modUpdateState } from "./state";
import { deserializeLoadOrder, serializeLoadOrder, validate } from "./loadorder";

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

function testSupportedContent(files: string[], gameId: string): Promise<types.ISupportedResult> {
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
  if (gameId === GAME_ID && !supported && !modUpdateState.updatingMod) {
    sendWarning(
      `Unsupported-Root-Install-${modUpdateState.modInstallName}`,
      `${modUpdateState.modInstallName} could not pass our support test, it'll be installed in the root directory`,
    );
  }

  return Promise.resolve({ supported, requiredFiles: [] });
}

async function installContent(files: string[]): Promise<types.IInstallResult> {
  const modFile = files.find((file) => path.extname(file).toLowerCase() === MOD_FILE_EXT);

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
  const modFile = files.find((file) => path.extname(file).toLowerCase() === MOD_FILE_EXT);
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
  if (supportedRoot === undefined && !modUpdateState.updatingMod) {
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

async function prepareForModding(discovery: types.IDiscoveryResult): Promise<void> {
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
            util.opn("https://www.nexusmods.com/warhammer40kdarktide/mods/8").catch(
              () => undefined,
            ),
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
            util.opn("https://www.nexusmods.com/warhammer40kdarktide/mods/19").catch(
              () => undefined,
            ),
        },
      ],
    });
  });
}

// --- toolbar ---------------------------------------------------------------

function toolbar(): void {
  if (api === undefined) {
    return;
  }

  const addToTitleBar = util.getSafe(
    api.getState(),
    ["settings", "interface", "tools", "addToolsToTitleBar"],
    false,
  );
  if (addToTitleBar) {
    return;
  }

  api.sendNotification?.({
    id: "Darktide-enable-toolbar",
    type: "warning",
    message: "Enable toolbar for easy game patching",
    actions: [
      {
        title: "Enable Toolbar",
        action: () => {
          api?.store?.dispatch({
            type: "SET_ADD_TO_TITLEBAR",
            payload: { addToTitleBar: true },
          });
          api?.dismissNotification?.("Darktide-enable-toolbar");
        },
      },
    ],
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
    requiresLauncher: util.toBlue(requiresLauncher) as types.IGame["requiresLauncher"],
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
    setup: util.toBlue((discovery: types.IDiscoveryResult) => prepareForModding(discovery)),
    environment: {
      SteamAPPId: STEAMAPP_ID,
    },
    details: {
      steamAppId: parseInt(STEAMAPP_ID, 10),
    },
  });

  context.registerLoadOrder({
    gameId: GAME_ID,
    validate: validate as types.ILoadOrderGameInfo["validate"],
    deserializeLoadOrder: () => deserializeLoadOrder(context.api),
    serializeLoadOrder: (loadOrder) => serializeLoadOrder(context.api, loadOrder),
    toggleableEntries: true,
    noCollectionGeneration: true,
    usageInstructions:
      "Drag and drop to reorder mods. Mods lower in the list are loaded later and win conflicts. " +
      "Use the toggles to enable or disable mods.",
  });

  context.once(() => {
    if (selectors.activeGameId(context.api.getState()) === GAME_ID) {
      toolbar();
    }

    context.api.events.on("profile-did-change", () => {
      if (selectors.activeGameId(context.api.getState()) === GAME_ID) {
        toolbar();
      }
    });

    // Patch on deploy.
    context.api.onAsync("did-deploy", async () => {
      modUpdateState.updateAllProfiles = false;
      modUpdateState.updatingMod = false;
      modUpdateState.updateModId = undefined;

      const discovery = selectors.discoveryByGame(context.api.getState(), GAME_ID);
      if (discovery?.path === undefined) {
        return;
      }
      try {
        spawn(path.join(discovery.path, "tools", "dtkit-patch.exe"), ["--patch"]).on(
          "error",
          () => undefined,
        );
      } catch {
        // ignore
      }
    });

    // Unpatch on purge.
    context.api.events.on("will-purge", () => {
      const discovery = selectors.discoveryByGame(context.api.getState(), GAME_ID);
      if (discovery?.path === undefined) {
        return;
      }
      try {
        spawnSync(path.join(discovery.path, "tools", "dtkit-patch.exe"), ["--unpatch"]);
      } catch {
        // ignore
      }
    });

    context.api.events.on("mod-update", (gameId: string, modId: string) => {
      if (gameId === GAME_ID) {
        modUpdateState.updateModId = modId;
      }
    });

    context.api.events.on("remove-mod", (_gameMode: string, modId: string) => {
      if (
        modUpdateState.updateModId !== undefined &&
        modId.includes(`-${modUpdateState.updateModId}-`)
      ) {
        modUpdateState.updateAllProfiles = true;
      }
    });

    context.api.events.on(
      "will-install-mod",
      (gameId: string, _archiveId: string, modId: string) => {
        modUpdateState.modInstallName = modId.split("-")[0];
        if (
          gameId === GAME_ID &&
          modUpdateState.updateModId !== undefined &&
          modId.includes(`-${modUpdateState.updateModId}-`)
        ) {
          modUpdateState.updatingMod = true;
        } else {
          modUpdateState.updatingMod = false;
        }
      },
    );
  });

  return true;
}

module.exports = {
  default: main,
};
