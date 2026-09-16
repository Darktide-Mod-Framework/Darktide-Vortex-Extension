import { types } from "@nexusmods/vortex-api";

// Nexus Mods domain for the game. e.g. nexusmods.com/warhammer40kdarktide
export const GAME_ID = "warhammer40kdarktide";

// Steam app id
export const STEAMAPP_ID = "1361210";

// Microsoft Store app id (gamepass)
export const MS_APPID = "FatsharkAB.Warhammer40000DarktideNew";

export const TOOLS: types.ITool[] = [
  {
    id: "ToggleMods",
    name: "Darktide Mod Patcher",
    shortName: "DML",
    logo: "dmf.png",
    executable: () => "tools/dtkit-patch.exe",
    requiredFiles: ["tools/dtkit-patch.exe"],
    parameters: ["--toggle", "..\\bundle"],
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
