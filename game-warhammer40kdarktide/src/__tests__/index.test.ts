import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
  spawnSync: vi.fn(),
}));

import { spawn, spawnSync } from "child_process";

import main from "../index";
import { beginUpdate, deserializeLoadOrder } from "../loadorder";
import {
  clearUpdateState,
  modUpdateState,
  resetLoadOrderState,
} from "../state";
import {
  addModFolder,
  installMods,
  removeModFolder,
  readFileText,
  resetAll,
  setGamePath,
  vortexState,
  writeFile,
  fs,
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
  const stateHandlers = new Map<string, Handler>();
  let once: (() => void) | undefined;

  const context = {
    api: {
      getState: () => vortexState,
      sendNotification: vi.fn(),
      showErrorNotification: vi.fn(),
      onAsync: (name: string, handler: Handler) =>
        asyncHandlers.set(name, handler),
      onStateChange: (statePath: string[], handler: Handler) =>
        stateHandlers.set(statePath.join("."), handler),
      events: {
        on: (name: string, handler: Handler) =>
          eventHandlers.set(name, handler),
      },
    },
    registerActionCheck: vi.fn(),
    registerInstaller: vi.fn(),
    registerGame: vi.fn(),
    registerLoadOrder: vi.fn(),
    once: (callback: () => void) => {
      once = callback;
    },
  };

  return {
    context,
    asyncHandlers,
    eventHandlers,
    stateHandlers,
    runOnce: () => once?.(),
  };
}

function setOrder(lines: string[]): void {
  writeFile(ORDER_PATH, lines.join("\n"));
}

beforeEach(() => {
  resetAll();
  clearUpdateState();
  resetLoadOrderState();
  modUpdateState.deployedModIds.clear();
  modUpdateState.manifestPath = undefined;
  modUpdateState.manifestLoad = undefined;
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

    modUpdateState.deployedModIds.set("true_level", "darktide-source");
    await asyncHandlers.get("did-deploy")?.("p-skyrim", {
      "": [{ relPath: "mods/true_level/true_level.mod", source: "other-game" }],
    });

    expect(modUpdateState.deployedModIds.get("true_level")).toBe(
      "darktide-source",
    );

    expect(modUpdateState.updateInProgress).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("clears preservation, caches deployment files and patches on Darktide's did-deploy", async () => {
    vortexState.profiles["p-dt"] = { id: "p-dt", gameId: GAME_ID };
    beginUpdate(api);

    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("did-deploy")?.("p-dt", {
      "": [
        {
          relPath: "mods\\true_level\\true_level.mod",
          source: "True Level-156-1-6-3-1719534708",
        },
      ],
    });

    expect(modUpdateState.updateInProgress).toBe(false);
    expect(modUpdateState.deployedModIds.get("true_level")).toBe(
      "True Level-156-1-6-3-1719534708",
    );
    expect(spawn).toHaveBeenCalled();
  });

  it("refreshes mappings across will-deploy and did-deploy using all mod types", async () => {
    vortexState.profiles["p-dt"] = { id: "p-dt", gameId: GAME_ID };
    addModFolder("true_level");
    setOrder([HEADER_LINE, "true_level"]);
    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("will-deploy")?.("p-dt", {
      "": [
        { relPath: "mods/true_level/true_level.mod", source: "old-version" },
      ],
      extra: [
        { relPath: "mods/removed/removed.mod", source: "removed-version" },
      ],
    });
    expect((await deserializeLoadOrder(api))[0].modId).toBe("old-version");
    expect(modUpdateState.deployedModIds.get("removed")).toBe(
      "removed-version",
    );

    await asyncHandlers.get("did-deploy")?.("p-dt", {
      "": [
        { relPath: "mods/true_level/true_level.mod", source: "new-version" },
      ],
      extra: [
        { relPath: "mods/other/other.mod", source: "other-version" },
        { relPath: "mods/ignored/info.json", source: "metadata-only" },
      ],
    });

    expect((await deserializeLoadOrder(api))[0].modId).toBe("new-version");
    expect([...modUpdateState.deployedModIds]).toEqual([
      ["true_level", "new-version"],
      ["other", "other-version"],
    ]);

    await asyncHandlers.get("did-deploy")?.("p-dt", {});
    expect(modUpdateState.deployedModIds.size).toBe(0);
  });

  it("ignores will-deploy for another game", async () => {
    vortexState.profiles["p-skyrim"] = { id: "p-skyrim", gameId: "skyrim" };
    modUpdateState.deployedModIds.set("true_level", "darktide-source");
    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("will-deploy")?.("p-skyrim", {});
    expect(modUpdateState.deployedModIds.get("true_level")).toBe(
      "darktide-source",
    );
  });

  it("only unpatches for Darktide's own purge", async () => {
    vortexState.profiles["p-skyrim"] = { id: "p-skyrim", gameId: "skyrim" };
    vortexState.profiles["p-dt"] = { id: "p-dt", gameId: GAME_ID };

    const { context, asyncHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();

    await asyncHandlers.get("will-purge")?.("p-skyrim");
    expect(spawnSync).not.toHaveBeenCalled();

    await asyncHandlers.get("will-purge")?.("p-dt");
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

    await asyncHandlers.get("will-remove-mods")?.("skyrim", ["a-id"], {
      willBeReplaced: true,
    });
    await asyncHandlers.get("will-remove-mods")?.(GAME_ID, ["a-id"], {});

    expect(modUpdateState.updateInProgress).toBe(false);
  });
});

describe("installation event contract", () => {
  it("accepts Vortex's full will-install-mod arguments and ignores other games", () => {
    const { context, eventHandlers, runOnce } = createContext();
    main(context as any);
    runOnce();
    const handler = eventHandlers.get("will-install-mod")!;
    handler(GAME_ID, "archive-id", "True Level-156", { download: {} });
    expect(modUpdateState.modInstallName).toBe("True Level");
    handler("skyrim", "archive-id", "Other-123", {});
    expect(modUpdateState.modInstallName).toBe("True Level");
  });
});

describe("Vortex load-order action integration", () => {
  async function setup() {
    vortexState.profiles["p-dt"] = { id: "p-dt", gameId: GAME_ID };
    vortexState.lastActiveProfile[GAME_ID] = "p-dt";
    const { context } = createContext();
    main(context as any);
    const checks = new Map(context.registerActionCheck.mock.calls);
    const registration = context.registerLoadOrder.mock.calls[0][0];
    const apply = async (incoming: any, type = "SET_FB_LOAD_ORDER") => {
      const previous = vortexState.persistent.loadOrder?.["p-dt"] ?? [];
      const action = { type, payload: { profileId: "p-dt", ...incoming } };
      expect(checks.get(type)?.(vortexState, action)).toBeUndefined();
      // Match reduxSanity -> reducer -> FBLO state watcher -> serializer -> validate.
      expect(action.type).toBe("SET_FB_LOAD_ORDER");
      vortexState.persistent.loadOrder = { "p-dt": action.payload.loadOrder };
      await registration.serializeLoadOrder(action.payload.loadOrder, previous);
      expect(
        await registration.validate(
          action.payload.loadOrder,
          action.payload.loadOrder,
        ),
      ).toBeUndefined();
      return action.payload.loadOrder;
    };
    for (const id of ["a", "b", "c"]) addModFolder(id);
    writeFile(
      path.join(GAME_PATH, "mods", "b", "info.json"),
      JSON.stringify({ dependencies: { self_after: ["a"] } }),
    );
    setOrder([HEADER_LINE, "a", "b", "c"]);
    const shown = await registration.deserializeLoadOrder();
    await apply({ loadOrder: shown });
    return { context, registration, apply, shown, checks };
  }

  it("keeps UI, disk and warnings consistent for a drag and repair", async () => {
    const { shown, apply, registration, context } = await setup();
    const broken = await apply({ loadOrder: [shown[1], shown[0], shown[2]] });
    expect(broken.map((m: any) => m.id)).toEqual(["b", "a", "c"]);
    expect(
      (await registration.deserializeLoadOrder()).map((m: any) => m.id),
    ).toEqual(["b", "a", "c"]);
    expect(context.api.sendNotification).not.toHaveBeenCalled();
    expect(typeof registration.usageInstructions).toBe("function");
    expect(registration.uniformRowHeight).toBe(true);
    const repaired = await apply({
      loadOrder: [broken[1], broken[0], broken[2]],
    });
    expect(repaired.every((m: any) => m.data.ignoredBefore === undefined)).toBe(
      true,
    );
    expect(
      (await registration.deserializeLoadOrder()).map((m: any) => m.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("repairs UpdateSet restoration before Redux stores it", async () => {
    const { apply, registration } = await setup();
    const fresh = await registration.deserializeLoadOrder();
    const stored = await apply({ loadOrder: [fresh[1], fresh[0], fresh[2]] });
    expect(stored.map((m: any) => m.id)).toEqual(["a", "b", "c"]);
    expect(readFileText(ORDER_PATH)).toBe(`${HEADER_LINE}\na\nb\nc`);
    expect(stored.every((m: any) => m.data.ignoredBefore === undefined)).toBe(
      true,
    );
  });

  it("normalizes the individual-entry toggle action without creating an override", async () => {
    const { shown, apply } = await setup();
    await apply(
      { loEntry: { ...shown[0], enabled: false } },
      "SET_FB_LOAD_ORDER_ENTRY",
    );
    let stored = vortexState.persistent.loadOrder["p-dt"];
    stored = await apply({ loadOrder: [stored[1], stored[0], stored[2]] });
    expect(stored.map((m: any) => m.id)).toEqual(["b", "a", "c"]);
    stored = await apply(
      { loEntry: { ...stored[1], enabled: true } },
      "SET_FB_LOAD_ORDER_ENTRY",
    );
    expect(stored.map((m: any) => m.id)).toEqual(["a", "b", "c"]);
    expect(readFileText(ORDER_PATH)).toBe(`${HEADER_LINE}\na\nb\nc`);
    expect(stored.every((m: any) => m.data.ignoredBefore === undefined)).toBe(
      true,
    );
  });

  it("leaves other games' actions untouched", async () => {
    const { checks } = await setup();
    vortexState.profiles.other = { gameId: "skyrim" };
    const action = {
      type: "SET_FB_LOAD_ORDER",
      payload: { profileId: "other", loadOrder: [] },
    };
    const payload = action.payload;
    checks.get(action.type)?.(vortexState, action);
    expect(action.payload).toBe(payload);
  });
});

describe("purge and profile switching", () => {
  async function setupProfiles() {
    vortexState.profiles.a = { id: "a", gameId: GAME_ID };
    vortexState.profiles.b = { id: "b", gameId: GAME_ID };
    vortexState.activeProfileId = "a";
    vortexState.lastActiveProfile[GAME_ID] = "a";
    const handlers = createContext();
    main(handlers.context as any);
    handlers.runOnce();
    const registration = handlers.context.registerLoadOrder.mock.calls[0][0];
    return { ...handlers, registration };
  }

  it.each([false, true])(
    "keeps disabled entries and overrides across purge/redeploy (manual mod survives: %s)",
    async (manualSurvives) => {
      const { asyncHandlers, eventHandlers, registration } =
        await setupProfiles();
      for (const id of ["first", "second", "disabled", "manual"])
        addModFolder(id);
      writeFile(
        path.join(GAME_PATH, "mods", "second", "info.json"),
        JSON.stringify({ dependencies: { self_after: ["first"] } }),
      );
      setOrder([HEADER_LINE, "first", "second", "-- disabled", "manual"]);
      const initial = await registration.deserializeLoadOrder();
      await registration.serializeLoadOrder(
        [initial[1], initial[0], ...initial.slice(2)],
        initial,
      );
      const stored = await registration.deserializeLoadOrder();
      vortexState.persistent.loadOrder = { a: stored };
      const beforePurge = readFileText(ORDER_PATH);
      vortexState.session = { base: { activity: { mods: ["purging"] } } };
      await (asyncHandlers.get("will-purge") ??
        eventHandlers.get("will-purge"))!("a");
      for (const id of ["first", "second", "disabled"]) removeModFolder(id);
      if (!manualSurvives) removeModFolder("manual");
      await asyncHandlers.get("did-purge")?.("a");
      vortexState.session.base.activity.mods = [];

      // FBLO reads on did-purge, retaining Redux's stored order for an empty read.
      const purged = await registration.deserializeLoadOrder();
      const hostOrder = purged.length ? purged : stored;
      if (hostOrder !== stored)
        await registration.serializeLoadOrder(hostOrder, stored);
      expect(readFileText(ORDER_PATH)).toBe(beforePurge);
      await asyncHandlers.get("will-deploy")!("a", {});
      // Reads during deployment must also preserve the old file.
      await registration.deserializeLoadOrder();
      expect(readFileText(ORDER_PATH)).toBe(beforePurge);
      for (const id of ["first", "second", "disabled", "manual"])
        addModFolder(id);
      writeFile(
        path.join(GAME_PATH, "mods", "second", "info.json"),
        JSON.stringify({ dependencies: { self_after: ["first"] } }),
      );
      // Core FBLO's callback may start before this extension's did-deploy callback.
      const [redeployed] = await Promise.all([
        registration.deserializeLoadOrder(),
        asyncHandlers.get("did-deploy")!("a", {}),
      ]);
      expect(redeployed.map((m: any) => m.id)).toEqual([
        "second",
        "first",
        "disabled",
        "manual",
      ]);
      expect(redeployed.find((m: any) => m.id === "disabled").enabled).toBe(
        false,
      );
      expect(
        redeployed.find((m: any) => m.id === "first").data.ignoredBefore,
      ).toEqual(["second"]);
      expect(readFileText(ORDER_PATH)).toBe(beforePurge);
      // Preservation must end after deployment: a real uninstall is still removed.
      removeModFolder("disabled");
      const removed = await registration.deserializeLoadOrder();
      expect(removed.some((m: any) => m.id === "disabled")).toBe(false);
      expect(readFileText(ORDER_PATH)).not.toContain("-- disabled");
    },
  );

  it("recovers saved choices when purge removes the load-order file too", async () => {
    const { asyncHandlers, eventHandlers, registration } =
      await setupProfiles();
    addModFolder("disabled");
    setOrder([HEADER_LINE, "-- disabled"]);
    vortexState.persistent.loadOrder = {
      a: await registration.deserializeLoadOrder(),
    };
    vortexState.session = { base: { activity: { mods: ["purging"] } } };
    await (asyncHandlers.get("will-purge") ?? eventHandlers.get("will-purge"))!(
      "a",
    );
    removeModFolder("disabled");
    await fs.removeAsync(ORDER_PATH);
    await asyncHandlers.get("did-purge")?.("a");
    vortexState.session.base.activity.mods = [];
    await registration.deserializeLoadOrder();
    await asyncHandlers.get("will-deploy")!("a", {});
    addModFolder("disabled");
    // A deployed archive may contain a default load-order file.
    setOrder(["disabled"]);
    const [redeployed] = await Promise.all([
      registration.deserializeLoadOrder(),
      asyncHandlers.get("did-deploy")!("a", {}),
    ]);
    expect(redeployed[0].enabled).toBe(false);
    expect(readFileText(ORDER_PATH)).toBe(`${HEADER_LINE}\n-- disabled`);
  });

  it.each([false, true])(
    "recovers a purge after restarting Vortex (load-order file removed: %s)",
    async (fileRemoved) => {
      const { asyncHandlers, registration } = await setupProfiles();
      for (const id of ["first", "second", "disabled"]) addModFolder(id);
      const metadataPath = path.join(GAME_PATH, "mods", "second", "info.json");
      const metadata = JSON.stringify({
        dependencies: { self_after: ["first"] },
      });
      writeFile(metadataPath, metadata);
      setOrder([HEADER_LINE, "first", "second", "-- disabled"]);
      const initial = await registration.deserializeLoadOrder();
      await registration.serializeLoadOrder(
        [initial[1], initial[0], initial[2]],
        initial,
      );
      vortexState.persistent.loadOrder = {
        a: await registration.deserializeLoadOrder(),
      };
      const saved = readFileText(ORDER_PATH);
      vortexState.session = { base: { activity: { mods: ["purging"] } } };
      await asyncHandlers.get("will-purge")!("a");
      for (const id of ["first", "second", "disabled"]) removeModFolder(id);
      if (fileRemoved) await fs.removeAsync(ORDER_PATH);
      await asyncHandlers.get("did-purge")?.("a");
      vortexState.session.base.activity.mods = [];

      // A new extension session has no in-memory purge flags or file snapshot.
      resetLoadOrderState();
      clearUpdateState();
      modUpdateState.manifestPath = undefined;
      modUpdateState.manifestLoad = undefined;
      const restarted = createContext();
      main(restarted.context as any);
      restarted.runOnce();
      const restartedRegistration =
        restarted.context.registerLoadOrder.mock.calls[0][0];
      const absent = await restartedRegistration.deserializeLoadOrder();
      expect(absent.map((m: any) => m.id)).toEqual([
        "second",
        "first",
        "disabled",
      ]);
      expect(absent[2].enabled).toBe(false);
      expect(readFileText(ORDER_PATH)).toBe(fileRemoved ? undefined : saved);

      await restarted.asyncHandlers.get("will-deploy")!("a", {});
      for (const id of ["first", "second", "disabled"]) addModFolder(id);
      writeFile(metadataPath, metadata);
      const [restored] = await Promise.all([
        restartedRegistration.deserializeLoadOrder(),
        restarted.asyncHandlers.get("did-deploy")!("a", {}),
      ]);
      expect(restored.map((m: any) => m.id)).toEqual([
        "second",
        "first",
        "disabled",
      ]);
      expect(restored[2].enabled).toBe(false);
      expect(readFileText(ORDER_PATH)).toBe(saved);
      expect(
        readFileText(
          path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
        ),
      ).toBeUndefined();
    },
  );

  it("uses the deployed profile before last-active changes and preserves the outgoing override", async () => {
    const { asyncHandlers, eventHandlers, registration } =
      await setupProfiles();
    for (const id of ["first", "second"]) addModFolder(id);
    const metadataPath = path.join(GAME_PATH, "mods", "second", "info.json");
    const metadata = JSON.stringify({
      dependencies: { self_after: ["first"] },
    });
    writeFile(metadataPath, metadata);
    setOrder([HEADER_LINE, "first", "second"]);
    const initial = await registration.deserializeLoadOrder();
    await registration.serializeLoadOrder([initial[1], initial[0]], initial);
    vortexState.settings = { profiles: { nextProfileId: "b" } };

    // Vortex deploys the outgoing profile while the next profile is already B.
    await asyncHandlers.get("will-deploy")!("a", {});
    expect(
      (await registration.deserializeLoadOrder()).map((m: any) => m.id),
    ).toEqual(["second", "first"]);
    await asyncHandlers.get("will-deploy")!("b", {});
    removeModFolder("second");
    const [incoming] = await Promise.all([
      registration.deserializeLoadOrder(),
      asyncHandlers.get("did-deploy")!("b", {}),
    ]);
    expect(vortexState.lastActiveProfile[GAME_ID]).toBe("a");
    expect(incoming[0].data.scope).toBe(JSON.stringify([GAME_PATH, "b"]));
    expect(readFileText(ORDER_PATH)).toContain(
      JSON.stringify([GAME_PATH, "a"]).replaceAll('"', '\\"'),
    );

    // Confirmation happens after deployment callbacks complete.
    vortexState.activeProfileId = "b";
    vortexState.lastActiveProfile[GAME_ID] = "b";
    eventHandlers.get("profile-did-change")?.("b");
    await asyncHandlers.get("will-deploy")!("a", {});
    addModFolder("second");
    writeFile(metadataPath, metadata);
    const [returned] = await Promise.all([
      registration.deserializeLoadOrder(),
      asyncHandlers.get("did-deploy")!("a", {}),
    ]);
    expect(returned.map((m: any) => m.id)).toEqual(["second", "first"]);
  });

  it("keeps a read's captured profile when another deployment starts during metadata lookup", async () => {
    const { asyncHandlers, registration } = await setupProfiles();
    addModFolder("first");
    setOrder([HEADER_LINE, "first"]);
    await asyncHandlers.get("will-deploy")!("a", {});
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalStat = fs.statAsync;
    const stat = vi
      .spyOn(fs, "statAsync")
      .mockImplementation(async (filePath) => {
        if (filePath.endsWith("info.json")) {
          entered();
          await gate;
        }
        return originalStat(filePath);
      });
    try {
      const pending = registration.deserializeLoadOrder();
      await reading;
      await asyncHandlers.get("will-deploy")!("b", {});
      release();
      expect((await pending)[0].data.scope).toBe(
        JSON.stringify([GAME_PATH, "a"]),
      );
    } finally {
      release();
      stat.mockRestore();
    }
  });

  it("clears the last entry after a genuine uninstall without a purge", async () => {
    const { registration } = await setupProfiles();
    addModFolder("last");
    setOrder([HEADER_LINE, "-- last"]);
    await registration.deserializeLoadOrder();
    removeModFolder("last");
    expect(await registration.deserializeLoadOrder()).toEqual([]);
    expect(readFileText(ORDER_PATH)).toBe(`${HEADER_LINE}\n`);
  });

  it.each([false, true])(
    "saves to the game after a purge aborts before removal (restart: %s)",
    async (restart) => {
      const { asyncHandlers, stateHandlers, registration } =
        await setupProfiles();
      addModFolder("test_mod");
      setOrder([HEADER_LINE, "test_mod"]);
      const initial = await registration.deserializeLoadOrder();
      vortexState.session = { base: { activity: { mods: ["purging"] } } };
      await asyncHandlers.get("will-purge")!("a");
      // External-change handling fails; no files disappear and no did-purge fires.
      vortexState.session.base.activity.mods = [];
      if (restart) {
        resetLoadOrderState();
        modUpdateState.manifestPath = undefined;
        modUpdateState.manifestLoad = undefined;
      } else {
        await stateHandlers.get("session.base.activity.mods")?.(
          ["purging"],
          [],
        );
      }
      await registration.serializeLoadOrder(
        [{ ...initial[0], enabled: false }],
        initial,
      );
      expect(readFileText(ORDER_PATH)).toBe(`${HEADER_LINE}\n-- test_mod`);
      expect(
        readFileText(
          path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
        ),
      ).toBeUndefined();
      resetLoadOrderState();
      expect((await registration.deserializeLoadOrder())[0].enabled).toBe(
        false,
      );
      // Recovery must not leave a guard masking a later genuine uninstall.
      removeModFolder("test_mod");
      expect(await registration.deserializeLoadOrder()).toEqual([]);
    },
  );

  it.each([false, true])(
    "writes changes to surviving mods after a partial purge failure and retains removed choices (restart before edit: %s)",
    async (restart) => {
      const { asyncHandlers, stateHandlers, registration } =
        await setupProfiles();
      addModFolder("survivor");
      addModFolder("removed");
      setOrder([HEADER_LINE, "survivor", "-- removed"]);
      const initial = await registration.deserializeLoadOrder();
      vortexState.session = { base: { activity: { mods: ["purging"] } } };
      await asyncHandlers.get("will-purge")!("a");
      removeModFolder("removed");
      vortexState.session.base.activity.mods = [];
      if (restart) resetLoadOrderState();
      else
        await stateHandlers.get("session.base.activity.mods")?.(
          ["purging"],
          [],
        );
      await registration.serializeLoadOrder(
        [{ ...initial[0], enabled: false }, initial[1]],
        initial,
      );
      expect(readFileText(ORDER_PATH)).toBe(
        `${HEADER_LINE}\n-- survivor\n-- removed`,
      );
      expect(
        readFileText(
          path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
        ),
      ).toBeDefined();
      resetLoadOrderState();
      expect(
        (await registration.deserializeLoadOrder()).map((entry: any) => [
          entry.id,
          entry.enabled,
        ]),
      ).toEqual([
        ["survivor", false],
        ["removed", false],
      ]);
      await asyncHandlers.get("will-deploy")!("a", {});
      addModFolder("removed");
      const [restored] = await Promise.all([
        registration.deserializeLoadOrder(),
        asyncHandlers.get("did-deploy")!("a", {}),
      ]);
      expect(restored.map((entry: any) => entry.enabled)).toEqual([
        false,
        false,
      ]);
      expect(
        readFileText(
          path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
        ),
      ).toBeUndefined();
    },
  );

  it("resumes saving after a canceled purge emits did-purge without removing files", async () => {
    const { asyncHandlers, registration } = await setupProfiles();
    addModFolder("test_mod");
    setOrder([HEADER_LINE, "test_mod"]);
    const initial = await registration.deserializeLoadOrder();
    vortexState.session = { base: { activity: { mods: ["purging"] } } };
    await asyncHandlers.get("will-purge")!("a");
    // Vortex emits this even for ProcessCanceled; activity stops afterwards.
    await asyncHandlers.get("did-purge")!("a");
    vortexState.session.base.activity.mods = [];
    await registration.serializeLoadOrder(
      [{ ...initial[0], enabled: false }],
      initial,
    );
    expect(readFileText(ORDER_PATH)).toBe(`${HEADER_LINE}\n-- test_mod`);
    expect(
      readFileText(
        path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
      ),
    ).toBeUndefined();
  });

  it("restores surviving mods from a pending snapshot after restarting during a partial purge", async () => {
    const { asyncHandlers, registration } = await setupProfiles();
    addModFolder("survivor");
    addModFolder("removed");
    setOrder([HEADER_LINE, "survivor", "-- removed"]);
    const initial = await registration.deserializeLoadOrder();
    vortexState.session = { base: { activity: { mods: ["purging"] } } };
    await asyncHandlers.get("will-purge")!("a");
    // A save during the active purge must only update the recovery snapshot.
    await registration.serializeLoadOrder(
      [{ ...initial[0], enabled: false }, initial[1]],
      initial,
    );
    expect(readFileText(ORDER_PATH)).toBe(
      `${HEADER_LINE}\nsurvivor\n-- removed`,
    );
    removeModFolder("removed");
    setOrder([HEADER_LINE, "survivor"]);
    resetLoadOrderState();
    vortexState.session.base.activity.mods = [];
    const restored = await registration.deserializeLoadOrder();
    expect(restored.map((entry: any) => [entry.id, entry.enabled])).toEqual([
      ["survivor", false],
      ["removed", false],
    ]);
    // FBLO can skip serialize when Redux already matches; the read must repair disk.
    expect(readFileText(ORDER_PATH)).toBe(
      `${HEADER_LINE}\n-- survivor\n-- removed`,
    );
    expect(
      readFileText(
        path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
      ),
    ).toBeDefined();
  });

  it.each([false, true])(
    "saves surviving mods after did-purge while preserving removed choices (manual survivor: %s)",
    async (manual) => {
      const { asyncHandlers, registration } = await setupProfiles();
      addModFolder("survivor");
      addModFolder("removed");
      if (!manual)
        writeFile(
          path.join(
            GAME_PATH,
            "mods",
            "survivor",
            "__folder_managed_by_vortex",
          ),
          "",
        );
      setOrder([HEADER_LINE, "survivor", "-- removed"]);
      const initial = await registration.deserializeLoadOrder();
      vortexState.session = { base: { activity: { mods: ["purging"] } } };
      await asyncHandlers.get("will-purge")!("a");
      removeModFolder("removed");
      // The hardlink activator can swallow an unlink failure and report success.
      await asyncHandlers.get("did-purge")!("a");
      const disabled = [{ ...initial[0], enabled: false }, initial[1]];
      await registration.serializeLoadOrder(disabled, initial);
      expect(readFileText(ORDER_PATH)).toBe(
        `${HEADER_LINE}\nsurvivor\n-- removed`,
      );
      vortexState.session.base.activity.mods = [];
      // Snapshot choices also repair disk when FBLO skips a redundant save.
      expect((await registration.deserializeLoadOrder())[0].enabled).toBe(
        false,
      );
      expect(readFileText(ORDER_PATH)).toBe(
        `${HEADER_LINE}\n-- survivor\n-- removed`,
      );
      await registration.serializeLoadOrder(initial, disabled);
      expect(readFileText(ORDER_PATH)).toBe(
        `${HEADER_LINE}\nsurvivor\n-- removed`,
      );
      expect(
        readFileText(
          path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
        ),
      ).toBeDefined();
      // An incoming deployment must still get snapshot-only saves until it finishes.
      vortexState.session.base.activity.mods = ["deployment"];
      await asyncHandlers.get("will-deploy")!("a", {});
      await registration.serializeLoadOrder(disabled, initial);
      await registration.deserializeLoadOrder();
      expect(readFileText(ORDER_PATH)).toBe(
        `${HEADER_LINE}\nsurvivor\n-- removed`,
      );
      addModFolder("removed");
      const [restored] = await Promise.all([
        registration.deserializeLoadOrder(),
        asyncHandlers.get("did-deploy")!("a", {}),
      ]);
      expect(restored.map((entry: any) => entry.enabled)).toEqual([
        false,
        false,
      ]);
      expect(readFileText(ORDER_PATH)).toBe(
        `${HEADER_LINE}\n-- survivor\n-- removed`,
      );
      expect(
        readFileText(
          path.join(GAME_PATH, "mods", ".vortex_load_order_purge.json"),
        ),
      ).toBeUndefined();
    },
  );
});
