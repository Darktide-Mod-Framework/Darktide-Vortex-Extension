import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginUpdate,
  deserializeLoadOrder,
  MANAGED_HEADER,
  rememberDeploymentFiles,
  serializeLoadOrder,
  validate,
} from "../loadorder";
import { clearUpdateState, modUpdateState } from "../state";
import {
  addModFolder,
  fs,
  util,
  setInstalledMods,
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
  return (readFileText(ORDER_PATH) ?? "")
    .split("\n")
    .filter((line) => line !== "");
}

beforeEach(() => {
  resetAll();
  clearUpdateState();
  modUpdateState.deployedModIds.clear();
  modUpdateState.manifestPath = undefined;
  modUpdateState.manifestLoad = undefined;
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
    rememberDeploymentFiles({
      "": [
        {
          relPath: "mods\\true_level\\true_level.mod",
          source: "True Level-156-1-6-3-1719534708",
        },
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
    writeFile(
      path.join(MODS_PATH, "true_level", "__folder_managed_by_vortex"),
      "",
    );
    setOrder([HEADER_LINE, "true_level"]);

    const [entry] = await deserializeLoadOrder(api);

    expect(entry.modId).toBe("true_level");
  });

  it("honors an existing mod's self_after rule when adding its dependency", async () => {
    installMods("existing", "new_dep");
    addModFolder("existing");
    addModFolder("new_dep");
    writeFile(
      path.join(MODS_PATH, "existing", "info.json"),
      JSON.stringify({ dependencies: { self_after: ["new_dep"] } }),
    );
    setOrder([HEADER_LINE, "existing"]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["new_dep", "existing"]);
  });

  it("preserves ordering between new mods when inserting after an existing mod", async () => {
    installMods("x", "a", "b");
    addModFolder("x");
    addModFolder("a");
    addModFolder("b");
    writeFile(
      path.join(MODS_PATH, "a", "info.json"),
      JSON.stringify({ dependencies: { self_before: ["b"] } }),
    );
    writeFile(
      path.join(MODS_PATH, "b", "info.json"),
      JSON.stringify({ dependencies: { self_after: ["x"] } }),
    );
    setOrder([HEADER_LINE, "x"]);

    const loadOrder = await deserializeLoadOrder(api);
    const ids = loadOrder.map((mod) => mod.id);

    // Either relative order of a and x is valid, but both must precede b.
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("x")).toBeLessThan(ids.indexOf("b"));
  });

  it.each([
    {
      name: "inserts a dependency chain before an existing mod",
      saved: ["x"],
      rules: { x: { self_after: ["a"] }, a: { self_after: ["b"] } },
      expected: ["b", "a", "x"],
    },
    {
      name: "honors an existing mod's self_before rule",
      saved: ["x", "y"],
      rules: { x: { self_before: ["a"] }, a: { self_before: ["y"] } },
      expected: ["x", "a", "y"],
    },
    {
      name: "ignores ordering rules on disabled mods",
      saved: ["-- x"],
      rules: { x: { self_after: ["a"] } },
      expected: ["x", "a"],
    },
    {
      name: "ignores disabled dependency targets",
      saved: ["-- x"],
      rules: { a: { self_before: ["x"] } },
      expected: ["x", "a"],
    },
    {
      name: "preserves existing user order even when it violates a rule",
      saved: ["y", "x"],
      rules: { x: { self_before: ["y"] } },
      expected: ["y", "x", "a"],
    },
  ])("$name", async ({ saved, rules, expected }) => {
    installMods(...expected);
    for (const id of expected) {
      addModFolder(id);
    }
    for (const [id, dependencies] of Object.entries(rules)) {
      writeFile(
        path.join(MODS_PATH, id, "info.json"),
        JSON.stringify({ dependencies }),
      );
    }
    setOrder([HEADER_LINE, ...saved]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(expected);
  });

  it("keeps all mods and existing order when constraints conflict", async () => {
    installMods("x", "y", "a");
    for (const id of ["x", "y", "a"]) {
      addModFolder(id);
    }
    writeFile(
      path.join(MODS_PATH, "a", "info.json"),
      JSON.stringify({
        dependencies: { self_after: ["y"], self_before: ["x"] },
      }),
    );
    setOrder([HEADER_LINE, "x", "y"]);

    const loadOrder = await deserializeLoadOrder(api);
    const ids = loadOrder.map((mod) => mod.id);

    expect(ids).toEqual(["x", "y", "a"]);
    expect((await validate([], loadOrder))?.invalid).toEqual([
      { id: "a", reason: "Should be after y but before x." },
    ]);
  });

  it("reports a cycle between new mods without losing entries", async () => {
    installMods("a", "b");
    for (const [id, dep] of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      addModFolder(id);
      writeFile(
        path.join(MODS_PATH, id, "info.json"),
        JSON.stringify({ dependencies: { self_after: [dep] } }),
      );
    }
    setOrder([HEADER_LINE]);

    const loadOrder = await deserializeLoadOrder(api);

    expect(loadOrder.map((mod) => mod.id)).toEqual(["a", "b"]);
    expect((await validate([], loadOrder))?.invalid).toEqual([
      { id: "a", reason: "Should be after b." },
    ]);
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

    expect(loadOrder.find((mod) => mod.id === "true_level")?.enabled).toBe(
      false,
    );
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

describe("load order edge cases", () => {
  it.each([false, true])(
    "deduplicates saved entries with pending additions: %s",
    async (addNew) => {
      addModFolder("a");
      if (addNew) addModFolder("b");
      setOrder([HEADER_LINE, "-- a", "a"]);
      const order = await deserializeLoadOrder(api);
      expect(order.map((mod) => mod.id)).toEqual(addNew ? ["a", "b"] : ["a"]);
      expect(order[0].enabled).toBe(false);
    },
  );

  it("recognizes disabled entries with indentation and CRLF", async () => {
    addModFolder("a");
    setOrder(["\uFEFF" + HEADER_LINE + "\r", "  -- a\r"]);
    const order = await deserializeLoadOrder(api);
    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({ id: "a", enabled: false });
  });

  it("does not turn a load order read error into an empty order", async () => {
    const error = Object.assign(new Error("access denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "readFileAsync").mockRejectedValueOnce(error);
    try {
      await expect(deserializeLoadOrder(api)).rejects.toBe(error);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not drop existing mods when scanning the directory fails", async () => {
    setOrder([HEADER_LINE, "a"]);
    const error = Object.assign(new Error("access denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "readdirAsync").mockRejectedValueOnce(error);
    try {
      await expect(deserializeLoadOrder(api)).rejects.toBe(error);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not reuse metadata for the same mod in another game directory", async () => {
    const realStat = fs.statAsync;
    const spy = vi.spyOn(fs, "statAsync");
    spy.mockImplementation(async (file) => ({
      ...(await realStat(file)),
      mtimeMs: 42,
    }));
    try {
      for (const [game, dependency] of [
        [GAME_PATH, "b"],
        [path.resolve("__other_game__"), "c"],
      ]) {
        setGamePath(game);
        for (const id of ["a", "b", "c"]) addModFolder(id);
        writeFile(
          path.join(game, "mods", "a", "info.json"),
          JSON.stringify({ dependencies: { self_after: [dependency] } }),
        );
        writeFile(path.join(game, "mods", "mod_load_order.txt"), HEADER_LINE);
        const order = await deserializeLoadOrder(api);
        const ids = order.map((mod) => mod.id);
        expect(ids.indexOf(dependency)).toBeLessThan(ids.indexOf("a"));
        expect(
          order.find((mod) => mod.id === "a")?.data?.orderRules?.selfAfter,
        ).toEqual([dependency]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves a deployment source through installationPath to the actual state key", async () => {
    addModFolder("true_level");
    setInstalledMods({
      "actual-vortex-id": { installationPath: "staging-folder" },
    });
    rememberDeploymentFiles({
      "": [
        {
          relPath: "mods/true_level/true_level.mod",
          source: "staging-folder",
        },
      ],
    } as any);
    const order = await deserializeLoadOrder(api);
    expect(order[0].modId).toBe("actual-vortex-id");
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"dependencies":null}',
    '{"dependencies":{"self_after":123}}',
  ])("ignores malformed metadata: %s", async (metadata) => {
    addModFolder("a");
    writeFile(path.join(MODS_PATH, "a", "info.json"), metadata);
    const order = await deserializeLoadOrder(api);
    expect(order.map((mod) => mod.id)).toEqual(["a"]);
    expect(await validate([], order)).toBeUndefined();
  });

  it("ignores missing optional targets, reports missing required mods and self cycles", async () => {
    addModFolder("a");
    writeFile(
      path.join(MODS_PATH, "a", "info.json"),
      JSON.stringify({
        dependencies: {
          self_after: ["missing", "a", "a"],
          required: ["required"],
        },
      }),
    );
    const order = await deserializeLoadOrder(api);
    expect(order.map((mod) => mod.id)).toEqual(["a"]);
    expect((await validate([], order))?.invalid[0]).toMatchObject({ id: "a" });
    expect((await validate([], order))?.invalid[0].reason).toContain(
      "Requires required.",
    );
  });

  it("satisfies every four-mod DAG across every subset of existing mods", async () => {
    // An independent oracle checks all constraints, not one chosen sort order.
    const ids = ["d", "b", "c", "a"];
    const edges = ids.flatMap((from, i) =>
      ids.slice(i + 1).map((to) => [from, to]),
    );
    for (let graph = 0; graph < 64; graph++) {
      for (let saved = 0; saved < 16; saved++) {
        resetAll();
        setGamePath(GAME_PATH);
        for (const id of ids) addModFolder(id);
        const rules = Object.fromEntries(
          ids.map((id) => [
            id,
            { self_after: [] as string[], self_before: [] as string[] },
          ]),
        );
        const selected = edges.filter((_, bit) => graph & (1 << bit));
        selected.forEach(([from, to], i) => {
          if (i % 2) rules[from].self_before.push(to);
          else rules[to].self_after.push(from);
        });
        for (const id of ids)
          writeFile(
            path.join(MODS_PATH, id, "info.json"),
            JSON.stringify({ dependencies: rules[id] }),
          );
        const existing = ids.filter((_, bit) => saved & (1 << bit));
        setOrder([HEADER_LINE, ...existing]);
        const order = await deserializeLoadOrder(api);
        const actual = order.map((mod) => mod.id);
        expect(new Set(actual).size).toBe(4);
        expect(actual.filter((id) => existing.includes(id))).toEqual(existing);
        for (const [from, to] of selected)
          expect(actual.indexOf(from)).toBeLessThan(actual.indexOf(to));
        expect(await validate([], order)).toBeUndefined();
        await serializeLoadOrder(api, order);
        expect((await deserializeLoadOrder(api)).map((mod) => mod.id)).toEqual(
          actual,
        );
      }
    }
  });
});

describe("Vortex serialization lifecycle", () => {
  it("rejects a host-restored order that puts a dependency after its dependent", async () => {
    addModFolder("x");
    setOrder([HEADER_LINE, "x"]);
    addModFolder("a");
    addModFolder("b");
    writeFile(
      path.join(MODS_PATH, "b", "info.json"),
      JSON.stringify({ dependencies: { self_before: ["x"] } }),
    );
    const order = await deserializeLoadOrder(api);
    expect(order.map((mod) => mod.id)).toEqual(["a", "b", "x"]);
    // Vortex 6ffb794 UpdateSet.restore uses saved x.index=0 alongside
    // the new entries' indices 0 and 1, yielding a,x,b.
    const restored = [order[0], order[2], order[1]];
    await expect(serializeLoadOrder(api, restored)).rejects.toThrow(
      "Should be before x.",
    );
    expect(readOrder()).toEqual([HEADER_LINE, "x"]);
  });
});

describe("startup deployment ownership", () => {
  it("loads the persisted manifest before the first deployment event", async () => {
    addModFolder("a");
    setInstalledMods({ "actual-id": { installationPath: "staging-folder" } });
    const spy = vi.spyOn(util, "getManifest").mockResolvedValue({
      files: [{ relPath: "mods/a/a.mod", source: "staging-folder" }],
    });
    try {
      expect((await deserializeLoadOrder(api))[0].modId).toBe("actual-id");
      expect((await deserializeLoadOrder(api))[0].modId).toBe("actual-id");
      expect(spy).toHaveBeenCalledExactlyOnceWith(
        api,
        "",
        "warhammer40kdarktide",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not overwrite a deployment event with a slower startup manifest read", async () => {
    addModFolder("a");
    let finish!: (manifest: {
      files: Array<{ relPath: string; source: string }>;
    }) => void;
    const spy = vi.spyOn(util, "getManifest").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const reading = deserializeLoadOrder(api);
      rememberDeploymentFiles({
        "": [{ relPath: "mods/a/a.mod", source: "new" }],
      } as any);
      finish({ files: [{ relPath: "mods/a/a.mod", source: "old" }] });
      expect((await reading)[0].modId).toBe("new");
    } finally {
      spy.mockRestore();
    }
  });
});

it("shares a pending startup manifest read between concurrent deserializations", async () => {
  addModFolder("a");
  let finish!: (manifest: {
    files: Array<{ relPath: string; source: string }>;
  }) => void;
  const spy = vi.spyOn(util, "getManifest").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const first = deserializeLoadOrder(api);
    const second = deserializeLoadOrder(api);
    finish({ files: [{ relPath: "mods/a/a.mod", source: "owner" }] });
    const orders = await Promise.all([first, second]);
    expect(orders.map((order) => order[0].modId)).toEqual(["owner", "owner"]);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
