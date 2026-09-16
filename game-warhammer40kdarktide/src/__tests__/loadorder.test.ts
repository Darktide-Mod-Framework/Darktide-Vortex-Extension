import path from "path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  beginUpdate,
  deserializeLoadOrder,
  MANAGED_HEADER,
  rememberDeploymentManifest,
  serializeLoadOrder,
} from "../loadorder";
import { clearUpdateState, modUpdateState } from "../state";
import {
  addModFolder,
  installMods,
  readFileText,
  removeModFolder,
  resetAll,
  setGamePath,
  vortexState,
  writeFile,
} from "./mocks/vortex-api";

const GAME_PATH = path.resolve("__test_game__");
const MODS_PATH = path.join(GAME_PATH, "mods");
const ORDER_PATH = path.join(MODS_PATH, "mod_load_order.txt");
const api = { getState: () => vortexState } as any;

const HEADER_LINE = `-- ${MANAGED_HEADER}`;

function setOrder(lines: string[]): void {
  writeFile(ORDER_PATH, lines.join("\n"));
}

function readOrder(): string[] {
  return (readFileText(ORDER_PATH) ?? "").split("\n").filter((line) => line !== "");
}

beforeEach(() => {
  resetAll();
  clearUpdateState();
  modUpdateState.deployedModIds.clear();
  setGamePath(GAME_PATH);
});

describe("deserializeLoadOrder", () => {
  it("skips the generated header", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "true_level", "b"]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);
    expect(loadOrder.some((mod) => mod.id === MANAGED_HEADER)).toBe(false);
  });

  it("drops entries that are missing when no update is in progress", async () => {
    installMods("a");
    addModFolder("a");
    setOrder([HEADER_LINE, "a", "ghost"]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["a"]);
  });

  it("maps a folder to the real Vortex mod id from the deployment manifest", async () => {
    installMods("true_level");
    addModFolder("true_level");
    setOrder([HEADER_LINE, "true_level"]);

    // The mod's installationPath is its staging folder, not the deployed
    // folder, so the manifest's `source` is the link between the two.
    rememberDeploymentManifest({
      files: [
        { relPath: "mods\\true_level\\true_level.mod", source: "True Level-156-1-6-3-1719534708" },
      ],
    } as any);

    const [entry] = await deserializeLoadOrder(api);

    expect(entry).toMatchObject({
      id: "true_level",
      name: "true_level",
      modId: "True Level-156-1-6-3-1719534708",
    });
  });

  it("falls back to the folder name for a managed mod with no manifest entry", async () => {
    installMods("true_level");
    addModFolder("true_level");
    writeFile(path.join(MODS_PATH, "true_level", "__folder_managed_by_vortex"), "");
    setOrder([HEADER_LINE, "true_level"]);

    const [entry] = await deserializeLoadOrder(api);

    expect(entry.modId).toBe("true_level");
  });

  it("inserts new mods in dependency order regardless of folder name", async () => {
    installMods("alpha", "zeta");
    addModFolder("alpha");
    addModFolder("zeta");
    writeFile(
      path.join(MODS_PATH, "alpha", "info.json"),
      JSON.stringify({ dependencies: { self_after: ["zeta"] } }),
    );
    setOrder([HEADER_LINE]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["zeta", "alpha"]);
  });
});

describe("update preservation", () => {
  it("keeps a temporarily absent mod at its position through an intermediate read/write", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "true_level", "b"]);

    // Pre-undeployment the update begins...
    beginUpdate(api);
    // ...then the old version's folder disappears.
    removeModFolder("true_level");

    const during = await deserializeLoadOrder(api);
    expect(during.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);

    await serializeLoadOrder(api, during);
    expect(readOrder()).toEqual([HEADER_LINE, "a", "true_level", "b"]);

    // The replacement appears; it is still in the same place.
    addModFolder("true_level");
    const after = await deserializeLoadOrder(api);
    expect(after.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);
  });

  it("preserves a disabled entry as disabled", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "-- true_level", "b"]);

    beginUpdate(api);
    removeModFolder("true_level");

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.find((mod) => mod.id === "true_level")?.enabled).toBe(false);
  });
});

describe("serializeLoadOrder", () => {
  it("writes the order it is given instead of re-sorting", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "true_level", "b"]);

    const loadOrder = await deserializeLoadOrder(api);
    // Simulate the user dragging `true_level` to the top.
    const reordered = [loadOrder[1], loadOrder[0], loadOrder[2]];
    await serializeLoadOrder(api, reordered);

    expect(readOrder()).toEqual([HEADER_LINE, "true_level", "a", "b"]);

    const roundTripped = await deserializeLoadOrder(api);
    expect(roundTripped.map((mod) => mod.id)).toEqual(["true_level", "a", "b"]);
  });
});
