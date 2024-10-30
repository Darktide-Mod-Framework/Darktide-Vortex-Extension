const path = require("path");
const { fs, util, selectors } = require("vortex-api");

const child_process = require("child_process");

// Nexus Mods domain for the game. e.g. nexusmods.com/warhammer40kdarktide
const GAME_ID = "warhammer40kdarktide";
// Steam app id
const STEAMAPP_ID = "1361210";
// Microsoft Store app id (gamepass)
const MS_APPID = "FatsharkAB.Warhammer40000DarktideNew";

// for mod update to keep them in the load order and not uncheck them
let mod_update_all_profile = false;
let updatemodid = "";
// used to see if it's a mod update or not
let updating_mod = false;
// used to display the name of the currently installed mod
let mod_install_name = "";

let api = false; // useful where we can't access context or API

function warning_root_install() {
  if (!api) {
    console.log(
      "Darktide-Root-Install : api is not defined could not send notif",
    );
    return;
  }
  api.sendNotification({
    id: "Darktide-Root-Install-" + mod_install_name, // added the name to the id otherwise in case of bulk install it would delete the one before
    type: "warning",
    message:
      mod_install_name +
      " will be installed in the root directory of the game. If it's normal just ignore this warning",
    allowSuppress: true,
  });
}

function not_supported_root_install() {
  if (!api) {
    console.log(
      "Darktide not supported root install : api is not defined could not send notif",
    );
    return;
  }
  api.sendNotification({
    id: "Darktide-Unsupported-Root-Install-" + mod_install_name, //same as before
    type: "warning",
    message:
      mod_install_name +
      " could not pass our support test, it'll be installed in the root directory",
    allowSuppress: true,
  });
}

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

// Not sure if there is a more elegant way to get this for patching later
let GAME_PATH = null;

async function prepareForModding(discovery, api) {
  GAME_PATH = discovery.path;

  // Ensure the mods directory exists
  await fs.ensureDirWritableAsync(path.join(discovery.path, "mods"));

  // Ensure the mod load order file exists
  await fs.ensureFileAsync(
    path.join(discovery.path, "mods", "mod_load_order.txt"),
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
        (path.extname(file).toLowerCase() === BAT_FILE_EXT &&
          file.includes("toggle_darktide_mods")) ||
        (path.extname(file).toLowerCase() === BAT_FILE_EXT &&
          file.includes("_mod_load_order_file_maker")),
    ) !== undefined;

  // Do not resend the alert in case of updates
  if (!supported && !updating_mod) {
    not_supported_root_install();
  }

  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

async function installContent(files) {
  const modFile = files.find(
    (file) => path.extname(file).toLowerCase() === MOD_FILE_EXT,
  );

  // other checks to see if it should be installed only in the /mods folder
  if (modFile && modFile.split("\\").length < 3) {
    return installMod(files);
  }

  const mod_load_order_file_maker = files.find(
    (file) =>
      path.extname(file).toLowerCase() === BAT_FILE_EXT &&
      file.includes("_mod_load_order_file_maker"),
  );

  if (mod_load_order_file_maker) {
    return install_mod_load_order_file_maker(files);
  }

  return root_game_install(files);
}

async function root_game_install(files) {
  // check for DML, we could add other mod here as well
  const supported_root = files.find(
    (file) =>
      path.extname(file).toLowerCase() === BAT_FILE_EXT &&
      file.includes("toggle_darktide_mods"),
  );

  // Do not resend the alert in case of updates
  if (!supported_root && !updating_mod) {
    warning_root_install();
  }

  // you always need to filter and everything
  const rootPath = "";
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep),
  );
  const instructions = filtered.map((file) => {
    return {
      type: "copy",
      source: file,
      destination: path.join("", file),
    };
  });
  return { instructions };
}

async function installMod(files) {
  const modFile = files.find(
    (file) => path.extname(file).toLowerCase() === MOD_FILE_EXT,
  );
  const idx = modFile.indexOf(path.basename(modFile));
  const rootPath = path.dirname(modFile);
  const modName = path.basename(modFile, MOD_FILE_EXT);
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep),
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

async function install_mod_load_order_file_maker(files) {
  const mod_load_order_file_maker = files.find(
    (file) => path.extname(file).toLowerCase() === BAT_FILE_EXT,
  );
  const idx = mod_load_order_file_maker.indexOf(
    path.basename(mod_load_order_file_maker),
  );
  const rootPath = path.dirname(mod_load_order_file_maker);
  const filtered = files.filter(
    (file) => file.indexOf(rootPath) !== -1 && !file.endsWith(path.sep),
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
  // on mod update for all profile it would cause the mod if it was selected to be unselected
  if (mod_update_all_profile) {
    let allMods = Array("mod_update");

    return allMods.map((modId) => {
      return {
        id: "mod update in progress, please wait. Refresh when finished. \n To avoid this wait, only update current profile",
        modId: modId,
        enabled: false,
      };
    });
  }

  let gameDir = await queryPath();

  let loadOrderPath = path.join(gameDir, "mods", "mod_load_order.txt");
  let loadOrderFile = await fs.readFileAsync(loadOrderPath, {
    encoding: "utf8",
  });

  let modFolderPath = path.join(gameDir, "mods");
  let modFolders = fs
    .readdirSync(modFolderPath)
    // Filter any files/folders out that don't contain ModName.mod
    .filter((fileName) => {
      try {
        fs.readFileSync(path.join(modFolderPath, fileName, `${fileName}.mod`));
        return true;
      } catch (e) {
        return false;
      }
    })
    // Ignore case when sorting
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // This is the most reliable way I could find to detect if a mod
  // is managed by Vortex
  function isVortexManaged(modId) {
    try {
      fs.readFileSync(
        path.join(modFolderPath, modId, `__folder_managed_by_vortex`),
      );
      return true;
    } catch (e) {
      try {
        fs.readFileSync(
          path.join(modFolderPath, modId, `${modId}.mod.vortex_backup`),
        );
        return true;
      } catch (d) {
        return false;
      }
    }
  }

  let loadOrder = loadOrderFile
    .split("\n")
    .map((line) => {
      const id = line.replace(/-- /g, "").trim();
      return {
        id,
        modId: isVortexManaged(id) ? id : undefined,
        enabled: !line.startsWith("--"),
      };
    })
    // Remove any mods from the mod_load_order that don't have corresponding
    // mods in the file system
    .filter((mod) => modFolders.includes(mod.id))
    .filter((mod) => mod.id !== "dmf" && mod.id !== "base");

  for (let folder of modFolders) {
    if (folder !== "dmf" && folder !== "base") {
      if (!loadOrder.find((mod) => mod.id === folder)) {
        loadOrder.push({
          id: folder,
          modId: undefined,
          enabled: true,
        });
      }
    }
  }

  return loadOrder;
}

async function serializeLoadOrder(_context, loadOrder) {
  if (mod_update_all_profile) {
    return;
  }

  let gameDir = await queryPath();
  let loadOrderPath = path.join(gameDir, "mods", "mod_load_order.txt");

  let loadOrderOutput = loadOrder
    .map((mod) => (mod.enabled ? mod.id : `-- ${mod.id}`))
    .join("\n");

  return fs.writeFileAsync(
    loadOrderPath,
    `-- File managed by Vortex mod manager\n${loadOrderOutput}`,
    { encoding: "utf8" },
  );
}

function main(context) {
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
    requiredFiles: ["launcher/Launcher.exe", "binaries/Darktide.exe"],
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

  // Didn't check if below events trigger on profiles for other games, so make sure it is for this
  const should_patch = (profileId) =>
    selectors.profileById(context.api.getState(), profileId)?.gameId ===
      GAME_ID && GAME_PATH;

  context.once(() => {
    api = context.api;
    // Patch on deploy
    context.api.onAsync("did-deploy", (profileId) => {
      if (mod_update_all_profile) {
        mod_update_all_profile = false;
        updating_mod = false;
      }
      if (should_patch(profileId)) {
        const proc = child_process.spawn(
          path.join(GAME_PATH, "tools", "dtkit-patch.exe"),
          ["--patch"],
        );
        proc.on("error", () => {});
      }
    });

    // Unpatch on purge
    context.api.events.on("will-purge", (profileId) => {
      if (should_patch(profileId)) {
        try {
          child_process.spawnSync(
            path.join(GAME_PATH, "tools", "dtkit-patch.exe"),
            ["--unpatch"],
          );
        } catch (e) {}
      }
    });

    context.api.events.on("mod-update", (gameId, modId, fileId) => {
      if (GAME_ID == gameId) {
        updatemodid = modId;
        updating_mod = false;
        mod_update_all_profile = false;
      }
    });

    context.api.events.on("will-remove-mods", (gameId, modId, err) => {
      if (GAME_ID == gameId && modId.includes("-" + updatemodid + "-")) {
        mod_update_all_profile = true;
      }
    });

    context.api.events.on("will-install-mod", (gameId, _, modId) => {
      mod_install_name = modId.split("-")[0];
      if (GAME_ID == gameId && modId.includes("-" + updatemodid + "-")) {
        updating_mod = true;
      } else {
        updating_mod = false;
      }
    });

    context.api.events.on(
      "did-install-mod",
      async (gameId, archiveId, modId) => {
        if (GAME_ID == gameId && modId.includes("-" + updatemodid + "-")) {
          mod_update_all_profile = false;
          updating_mod = false;
        }
      },
    );
  });

  return true;
}

module.exports = {
  default: main,
};
