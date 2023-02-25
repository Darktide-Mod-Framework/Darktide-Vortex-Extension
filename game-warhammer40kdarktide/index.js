// Import some assets from Vortex we'll need.
const path = require("path");
const { fs, util } = require("vortex-api");

// Nexus Mods domain for the game. e.g. nexusmods.com/warhammer40kdarktide
const GAME_ID = "warhammer40kdarktide";
// Steam app id
const STEAM_APPID = "1361210";
// Microsoft Store app id (gamepass)
const MS_APPID = "FatsharkAB.Warhammer40000DarktideNew";

async function queryGame() {
  let game = await util.GameStoreHelper.findByAppId([STEAM_APPID, MS_APPID]);
  return game;
}

async function queryPath() {
  // Find the game folder
  let game = await queryGame();
  return game.gamePath;
}

async function setup(discovery) {
  // Ensure the mods directory exists
  await fs.ensureDirAsync(path.join(discovery.path, "mods"));
  await fs.ensureFileAsync(
    path.join(discovery.path, "mods", "mod_load_order.txt")
  );
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
  const state = context.api.store.getState();
  const vortexManagedMods = util.getSafe(
    state,
    ["persistent", "mods", GAME_ID],
    {}
  );
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
      // This lets us show "Not managed by Vortex" in the load order screen
      modId: Object.values(vortexManagedMods).some(
        (mod) => mod.attributes.logicalFileName === modId
      )
        ? modId
        : undefined,
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

let supportedTools = [
  {
    id: "dtkit-patch",
    name: "Toggle modding (patch/unpatch game files)",
    executable: () => "tools/dtkit-patch.exe",
    requiredFiles: ["tools/dtkit-patch.exe"],
    queryPath,
  },
];

function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: "Warhammer 40,000: Darktide",
    shortName: "Darktide",
    logo: "gameart.png",

    // Removes Nexus/Vortex top level folder
    mergeMods: true,
    // Only delete folders tagged as created by Vortex when cleaning up
    directoryCleaning: "tag",
    // Not required when mergeMods is false
    requiresCleanup: false,

    supportedTools,

    setup,
    requiresLauncher,
    queryPath,
    queryModPath: () => "mods",
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
    requiredFiles: ["binaries/Darktide.exe"],
    environment: {
      SteamAPPId: STEAM_APPID,
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
