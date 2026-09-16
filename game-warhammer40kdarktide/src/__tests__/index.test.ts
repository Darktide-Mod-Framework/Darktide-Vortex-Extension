import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
  spawnSync: vi.fn(),
}));

import { spawn, spawnSync } from "child_process";

import main from "../index";
import { beginUpdate, deserializeLoadOrder } from "../loadorder";
import { clearUpdateState, modUpdateState } from "../state";
import {
  addModFolder,
  installMods,
  removeModFolder,
  resetAll,
  setGamePath,
  vortexState,
  writeFile,
  GAME_ID,
} from "./mocks/vortex-api";

const GAME_PATH = path.resolve("__test_game__");
const ORDER_PATH = path.join(GAME_PATH, "mods", "mod_load_order.txt");
const HEADER_LINE = "-- File managed by Vortex mod manager";
const api = { getState: () => vortexState } as any;

type Handler = (...args: any[]) => any;

function createContext() {
  const asyncHandlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  let once: (() => void) | undefined;

  const context = {
    api: {
      getState: () => vortexState,
      sendNotification: vi.fn(),
      showErrorNotification: vi.fn(),
      onAsync: (name: string, handler: Handler) => asyncHandlers.set(name, handler),
      events: {
        on: (name: string, handler: Handler) => eventHandlers.set(name, handler),
      },
    },
    registerInstaller: vi.fn(),
    registerGame: vi.fn(),
    registerLoadOrder: vi.fn(),
    once: (callback: () => void) => {
      once = callback;
    },
  };

  return { context, asyncHandlers, eventHandlers, runOnce: () => once?.() };
}

function setOrder(lines: string[]): void {
  writeFile(ORDER_PATH, lines.join("\n"));
}

beforeEach(() => {
  resetAll();
  clearUpdateState();
  modUpdateState.deployedModIds.clear();
  setGamePath(GAME_PATH);
  vi.clearAllMocks();
});

describe("deployment event scoping", () => {
  it("ignores did-deploy for another game", async () => {
    vortexState.profiles["p-skyrim"] = { id: "p-skyrim", gameId: "skyrim" };
    beginUpdate(api);

    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("did-deploy")?.("p-skyrim");

    expect(modUpdateState.updateInProgress).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("clears preservation, caches the manifest and patches on Darktide's did-deploy", async () => {
    vortexState.profiles["p-dt"] = { id: "p-dt", gameId: GAME_ID };
    beginUpdate(api);

    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("did-deploy")?.("p-dt", {
      files: [
        { relPath: "mods\\true_level\\true_level.mod", source: "True Level-156-1-6-3-1719534708" },
      ],
    });

    expect(modUpdateState.updateInProgress).toBe(false);
    expect(modUpdateState.deployedModIds.get("true_level")).toBe(
      "True Level-156-1-6-3-1719534708",
    );
    expect(spawn).toHaveBeenCalled();
  });

  it("only unpatches for Darktide's own purge", async () => {
    vortexState.profiles["p-skyrim"] = { id: "p-skyrim", gameId: "skyrim" };
    vortexState.profiles["p-dt"] = { id: "p-dt", gameId: GAME_ID };

    const { context, eventHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    eventHandlers.get("will-purge")?.("p-skyrim");
    expect(spawnSync).not.toHaveBeenCalled();

    eventHandlers.get("will-purge")?.("p-dt");
    expect(spawnSync).toHaveBeenCalled();
  });
});

describe("update preservation events", () => {
  it("activates preservation on the pre-undeployment will-remove-mods event", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "true_level", "b"]);

    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("will-remove-mods")?.(GAME_ID, ["True Level-156"], {
      willBeReplaced: true,
    });
    removeModFolder("true_level");

    const loadOrder = await deserializeLoadOrder(api);
    expect(loadOrder.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);
  });

  it("keeps the guard active across the later singular will-remove-mod", async () => {
    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("will-remove-mods")?.(GAME_ID, ["True Level-156"], {
      willBeReplaced: true,
    });
    await asyncHandlers.get("will-remove-mod")?.(GAME_ID, "True Level-156", {
      willBeReplaced: true,
    });

    expect(modUpdateState.updateInProgress).toBe(true);
  });

  it("ignores removals for other games and plain removals", async () => {
    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("will-remove-mods")?.("skyrim", ["a-id"], { willBeReplaced: true });
    await asyncHandlers.get("will-remove-mods")?.(GAME_ID, ["a-id"], {});

    expect(modUpdateState.updateInProgress).toBe(false);
  });
});
