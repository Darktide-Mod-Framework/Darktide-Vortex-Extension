import * as React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { createUsageInstructions } from "../UsageInstructions";
import { type LoadOrder } from "../ordering";
import { GAME_ID, resetAll, vortexState } from "./mocks/vortex-api";

beforeEach(resetAll);

it("updates advisory warnings for reorders, toggles and profile switches, then unsubscribes", async () => {
  const a = { id: "a", name: "a", enabled: true };
  const b = {
    id: "b",
    name: "b",
    enabled: true,
    data: { orderRules: { selfAfter: ["a"] } },
  };
  vortexState.profiles.p = { id: "p", gameId: GAME_ID };
  vortexState.profiles.q = { id: "q", gameId: GAME_ID };
  vortexState.activeProfileId = "p";
  vortexState.persistent.loadOrder = { p: [b, a], q: [a, b] };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const api = {
    getState: () => vortexState,
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    },
    sendNotification: vi.fn(),
  };
  const Instructions = createUsageInstructions(api as any);
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(React.createElement(Instructions));
  });
  const warnings = () => view.root.findAllByProps({ role: "status" });
  const update = async (order?: LoadOrder, profile = "p") => {
    await act(async () => {
      if (order) vortexState.persistent.loadOrder[profile] = order;
      vortexState.activeProfileId = profile;
      listeners.forEach((listener) => listener());
    });
  };
  expect(warnings()).toHaveLength(1);
  expect(view!.root.findByType("li").children).toEqual([
    "b: Should be after a.",
  ]);
  await update([a, b]);
  expect(warnings()).toHaveLength(0);
  await update([b, a]);
  expect(warnings()).toHaveLength(1);
  await update([{ ...b, enabled: false }, a]);
  expect(warnings()).toHaveLength(0);
  await update([b, a]);
  expect(warnings()).toHaveLength(1);
  await update(undefined, "q");
  expect(warnings()).toHaveLength(0);
  await update(undefined, "p");
  expect(warnings()).toHaveLength(1);
  await act(async () => {
    vortexState.activeProfileId = undefined;
    listeners.forEach((listener) => listener());
  });
  expect(warnings()).toHaveLength(0);
  expect(api.sendNotification).not.toHaveBeenCalled();
  await act(async () => {
    view.unmount();
  });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});
