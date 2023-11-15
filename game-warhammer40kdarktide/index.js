const path = require("path");
const { fs, log, util } = require("vortex-api");

// Nexus Mods domain for the game. e.g. nexusmods.com/warhammer40kdarktide
const GAME_ID = "warhammer40kdarktide";
// Steam app id
const STEAMAPP_ID = "1361210";
// Microsoft Store app id (gamepass)
const MS_APPID = "FatsharkAB.Warhammer40000DarktideNew";

const tools = [
  {
    id: "ToggleMods",
    name: "Darktide Mod Patcher",
    shortName: "DML",
    logo: "dmf.png",
    executable: () => "tools/dtkit-patch.exe",
    requiredFiles: ["tools/dtkit-patch.exe"],
    relative: true,
    exclusive: true,
  },
  {
    id: "SL_EN_mod_load_order_file_maker",
    name: "SL_EN_mod_load_order_file_maker",
    executable: () => "SL_EN_mod_load_order_file_maker.bat",
    requiredFiles: ["SL_EN_mod_load_order_file_maker.bat"],
    relative: true,
    exclusive: true,
  },
  {
    id: "SL_RU_mod_load_order_file_maker",
    name: "SL_RU_mod_load_order_file_maker",
    executable: () => "SL_RU_mod_load_order_file_maker.bat",
    requiredFiles: ["SL_RU_mod_load_order_file_maker.bat"],
    relative: true,
    exclusive: true,
  },
];

async function prepareForModding(discovery, api) {
  // Ensure the mods directory exists
  await fs.ensureDirWritableAsync(path.join(discovery.path, "mods"));

  // Ensure the mod load order file exists
  await fs.ensureFileAsync(
    path.join(discovery.path, "mods", "mod_load_order.txt")
  );

  // Check if DMF is installed
  await checkForDMF(api, path.join(discovery.path, "mods", "dmf"));

  // Check if DML is installed
  await checkForDML(api, path.join(discovery.path, "toggle_darktide_mods.bat"));
}

function checkForDMF(api, mod_framework) {
  return fs.statAsync(mod_framework).catch(() => {
    api.sendNotification({
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
function checkForDML(api, toggle_mods_path) {
  return fs.statAsync(toggle_mods_path).catch(() => {
    api.sendNotification({
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

const MOD_FILE_EXT = ".mod";
const BAT_FILE_EXT = ".bat";

function testSupportedContent(files, gameId) {
  let supported =
    gameId === GAME_ID &&
    files.find(
      (file) =>
        path.extname(file).toLowerCase() === MOD_FILE_EXT ||
        path.extname(file).toLowerCase() === BAT_FILE_EXT
    ) !== undefined;

  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

async function installContent(files) {
  const modFile = files.find(
    (file) => path.extname(file).toLowerCase() === MOD_FILE_EXT
  );
  if (modFile) {
    return installMod(files);
  }
  const DML = files.find(
    (file) => file.toLowerCase() === "toggle_darktide_mods.bat"
  );
  if (DML) {
    return installDML(files);
  }
  const mod_load_order_file_maker = files.find(
    (file) =>
      path.extname(file).toLowerCase() === BAT_FILE_EXT &&
      file.includes("_mod_load_order_file_maker")
  );
  if (mod_load_order_file_maker) {
    return install_mod_load_order_file_maker(files);
  }

  return;
}

async function installMod(files) {
  const modFile = files.find(
    (file) => path.extname(file).toLowerCase() === MOD_FILE_EXT
  );
  const idx = modFile.indexOf(path.basename(modFile));
  const rootPath = path.dirname(modFile);
  const modName = path.basename(modFile, MOD_FILE_EXT);
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep)
  );
  const instructions = filtered.map((file) => {
    return {
      type: "copy",
      source: file,
      destination: path.join("mods", modName, file.substr(idx)),
    };
  });
  return { instructions };
}

async function installDML(files) {
  // Copy all files directly into game folder
  const instructions = files.filter(file => !file.endsWith(path.sep))
  .map((file) => {
    return {
      type: "copy",
      source: file,
      destination: file,
    };
  });
  return { instructions };
}

async function install_mod_load_order_file_maker(files) {
  const mod_load_order_file_maker = files.find(
    (file) => path.extname(file).toLowerCase() === BAT_FILE_EXT
  );
  const idx = mod_load_order_file_maker.indexOf(
    path.basename(mod_load_order_file_maker)
  );
  const rootPath = path.dirname(mod_load_order_file_maker);
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep)
  );
  const instructions = filtered.map((file) => {
    return {
      type: "copy",
      source: file,
      destination: path.join("mods", file.substr(idx)),
    };
  });
  return { instructions };
}

async function queryGame() {
  let game = await util.GameStoreHelper.findByAppId([STEAMAPP_ID, MS_APPID]);
  return game;
}

async function queryPath() {
  let game = await queryGame();
  return game.gamePath;
}

async function requiresLauncher() {
  let game = await queryGame();

  if (game.gameStoreId === "steam") {
    return undefined;
  }

  if (game.gameStoreId === "xbox") {
    return {
      launcher: "xbox",
      addInfo: {
        appId: MS_APPID,
        // appExecName is the <Application id="" in the appxmanifest.xml file
        parameters: [{ appExecName: "launcher.launcher" }],
      },
    };
  }
}

async function deserializeLoadOrder(context) {
  let gameDir = await queryPath();

  let loadOrderPath = path.join(gameDir, "mods", "mod_load_order.txt");
  let loadOrderFile = await fs.readFileAsync(loadOrderPath, {
    encoding: "utf8",
  });

  let loadOrder = loadOrderFile
    .split("\n")
    .map((line) => line.trim())
    // mod_load_order.txt supports lua comments, remove those lines
    .filter((line) => !line.startsWith("--"));

  let modFolderPath = path.join(gameDir, "mods");
  let modFolders = await fs.readdirAsync(modFolderPath);

  // Filter any files/folders out that don't contain ModName.mod
  modFolders = modFolders.filter((fileName) => {
    try {
      fs.readFileSync(path.join(modFolderPath, fileName, `${fileName}.mod`));
      return true;
    } catch (e) {
      return false;
    }
  });

  // This is the most reliable way I could find to detect if a mod
  // is managed by Vortex
  let vortexManaged = modFolders.reduce((mods, modId) => {
    try {
      fs.readFileSync(
        path.join(modFolderPath, modId, `__folder_managed_by_vortex`)
      );
      mods[modId] = true;
      return mods;
    } catch (e) {
      try {
        fs.readFileSync(
          path.join(modFolderPath, modId, `${modId}.mod.vortex_backup`)
        );
        mods[modId] = true;
        return mods;
      } catch (d) {
        mods[modId] = false;
        return mods;
      }
    }
  }, {});

  // Remove any mods from the mod_load_order that don't have corresponding
  // mods in the file system
  loadOrder = loadOrder.filter((modId) => modFolders.includes(modId));

  // Dedupes the loadOrder and the modFolders, with non-enabled mods last
  let allMods = Array.from(new Set([...loadOrder, ...modFolders]))
    // dmf is always loaded first
    .filter((modId) => modId !== "dmf");

  return allMods.map((modId) => {
    return {
      id: modId,
      // Add mod id to remove "Not managed by Vortex" message
      modId: vortexManaged[modId] ? modId : undefined,
      enabled: loadOrder.includes(modId),
    };
  });
}

async function serializeLoadOrder(_context, loadOrder) {
  let gameDir = await queryPath();
  let loadOrderPath = path.join(gameDir, "mods", "mod_load_order.txt");

  let loadOrderOutput = loadOrder
    .filter((mod) => mod.enabled)
    .map((mod) => mod.id)
    .join("\n");

  return fs.writeFileAsync(
    loadOrderPath,
    `-- File managed by Vortex mod manager\n${loadOrderOutput}`,
    { encoding: "utf8" }
  );
}

function main(context) {
  context.registerInstaller(
    "warhammer40kdarktide-mod",
    25,
    testSupportedContent,
    installContent
  );

  context.registerGame({
    id: GAME_ID,
    name: "Warhammer 40,000: Darktide",
    logo: "gameart.png",
    queryPath,
    queryModPath: () => "",
    supportedTools: tools,
    mergeMods: true,
    directoryCleaning: "tag",
    requiresCleanup: false,
    requiresLauncher,
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
    requiredFiles: [
      "launcher/Launcher.exe",
      "binaries/Darktide.exe",
      "start_protected_game.exe",
    ],
    setup: async (discovery) => await prepareForModding(discovery, context.api),
    environment: {
      SteamAPPId: STEAMAPP_ID,
    },
    details: {
      steamAppId: STEAMAPP_ID,
    },
  });

  context.registerLoadOrder({
    gameId: GAME_ID,
    validate: async () => Promise.resolve(undefined), // no validation implemented yet
    deserializeLoadOrder: async () => await deserializeLoadOrder(context),
    serializeLoadOrder: async (loadOrder) =>
      await serializeLoadOrder(context, loadOrder),
    toggleableEntries: true,
  });

  return true;
}

module.exports = {
  default: main,
};
