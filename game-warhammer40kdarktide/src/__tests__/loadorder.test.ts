import path from "path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  captureEntriesForUpdate,
  deserializeLoadOrder,
  MANAGED_HEADER,
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
  setInstalledMods,
  vortexState,
  writeFile,
  GAME_ID,
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
  return (readFileText(ORDER_PATH) ?? "")
    .split("\n")
    .filter((line) => line !== "");
}

beforeEach(() => {
  resetAll();
  clearUpdateState();
  setGamePath(GAME_PATH);
});

describe("deserializeLoadOrder", () => {
  it("skips the generated header, including while an update is in progress", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "true_level", "b"]);

    await captureEntriesForUpdate(api, ["true_level-id"]);
    removeModFolder("true_level");

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);
    expect(loadOrder.some((mod) => mod.id === MANAGED_HEADER)).toBe(false);
  });

  it("drops entries that are missing and not part of an update", async () => {
    installMods("a");
    addModFolder("a");
    setOrder([HEADER_LINE, "a", "ghost"]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["a"]);
  });

  it("does not preserve a missing mod that was not part of the update", async () => {
    installMods("a", "other");
    addModFolder("a");
    addModFolder("other");
    setOrder([HEADER_LINE, "a", "other"]);

    await captureEntriesForUpdate(api, ["a-id"]);
    removeModFolder("other");

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["a"]);
  });

  it("maps a folder to the real installed Vortex mod id", async () => {
    setInstalledMods({
      "archive-123": { installationPath: path.join("mods", "true_level") },
    });
    addModFolder("true_level");
    setOrder([HEADER_LINE, "true_level"]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder[0]).toMatchObject({
      id: "true_level",
      name: "true_level",
      modId: "archive-123",
    });
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
  it("keeps position and enabled state across an intermediate read/write", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "true_level", "b"]);

    // Pre-undeployment (plural) event captures the affected entry...
    await captureEntriesForUpdate(api, ["true_level-id"]);
    // ...then the folder disappears while the old version is undeployed.
    removeModFolder("true_level");

    const during = await deserializeLoadOrder(api);
    expect(during.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);
    expect(during.find((mod) => mod.id === "true_level")).toMatchObject({
      enabled: true,
      modId: "true_level-id",
    });

    // An intermediate read/write must not lose the entry.
    await serializeLoadOrder(api, during);
    expect(readOrder()).toEqual([HEADER_LINE, "a", "true_level", "b"]);

    // The later singular event repeats the same mod idempotently.
    await captureEntriesForUpdate(api, ["true_level-id"]);
    expect(modUpdateState.preservedEntries.size).toBe(1);
    expect(modUpdateState.preservedEntries.get("true_level")).toMatchObject({
      enabled: true,
      modId: "true_level-id",
    });

    // Replacement shows up on disk -> preservation is no longer needed.
    addModFolder("true_level");
    const after = await deserializeLoadOrder(api);
    expect(after.map((mod) => mod.id)).toEqual(["a", "true_level", "b"]);
    expect(modUpdateState.preservedEntries.size).toBe(0);
  });

  it("preserves a disabled entry as disabled", async () => {
    installMods("a", "true_level", "b");
    addModFolder("a");
    addModFolder("true_level");
    addModFolder("b");
    setOrder([HEADER_LINE, "a", "-- true_level", "b"]);

    await captureEntriesForUpdate(api, ["true_level-id"]);
    removeModFolder("true_level");

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.find((mod) => mod.id === "true_level")?.enabled).toBe(
      false,
    );
  });
});

describe("serializeLoadOrder", () => {
  it("writes the order it is given instead of re-sorting new mods", async () => {
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
