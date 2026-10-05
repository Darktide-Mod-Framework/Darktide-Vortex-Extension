import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createLoadOrderRow } from "../LoadOrderRow";
import { createUsageInstructions } from "../UsageInstructions";
import * as loadorder from "../loadorder";
import { type LoadOrder } from "../ordering";
import { GAME_ID, resetAll, vortexState } from "./mocks/vortex-api";

beforeEach(resetAll);
afterEach(() => vi.restoreAllMocks());

it("shares one warning pass and subscription across many rows and instructions, including virtualized remounts", async () => {
  const order: LoadOrder = Array.from({ length: 300 }, (_, index) => ({
    id: `mod${index}`,
    name: `Mod ${index}`,
    enabled: true,
    locked: index === 0 ? "always" : undefined,
    data: { orderRules: { selfAfter: index > 0 ? [`mod${index - 1}`] : [] } },
  }));
  vortexState.profiles.p = { id: "p", gameId: GAME_ID };
  vortexState.profiles.q = { id: "q", gameId: GAME_ID };
  vortexState.activeProfileId = "p";
  vortexState.persistent.loadOrder = { p: order, q: order };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });
  const api = {
    getState: () => vortexState,
    store: { subscribe, dispatch: vi.fn() },
  };
  const compute = vi.spyOn(loadorder, "getOrderWarnings");
  const Row = createLoadOrderRow(api as any);
  const Instructions = createUsageInstructions(api as any);
  const renderRows = (entries: LoadOrder, instructions = true) =>
    React.createElement(
      "div",
      null,
      instructions && React.createElement(Instructions),
      entries.map((entry) =>
        React.createElement(Row, {
          key: entry.id,
          item: { loEntry: entry, displayCheckboxes: true },
        }),
      ),
    );
  let view!: ReactTestRenderer;
  const notify = () => listeners.forEach((listener) => listener());
  await act(async () => {
    view = create(renderRows(order));
  });
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(1);
  expect(compute).toHaveBeenCalledTimes(1);
  const indices = () =>
    view.root.findAllByType("vortex-load-order-index" as any);
  expect(indices()).toHaveLength(300);
  expect(indices()[299].props.currentPosition).toBe(300);
  expect(indices()[299].props.lockedEntriesCount).toBe(1);

  // Redux activity outside this profile's order does no warning work.
  await act(async () => {
    notify();
    notify();
  });
  expect(compute).toHaveBeenCalledTimes(1);

  // Keeping only a viewport's rows mounted preserves full-order positions.
  await act(async () => {
    view.update(renderRows(order.slice(290), false));
  });
  expect(unsubscribe).not.toHaveBeenCalled();
  expect(indices()[0].props.currentPosition).toBe(291);
  expect(compute).toHaveBeenCalledTimes(1);
  await act(async () => {
    view.update(renderRows(order));
  });
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(compute).toHaveBeenCalledTimes(1);

  const reversed = [...order].reverse();
  await act(async () => {
    vortexState.persistent.loadOrder.p = reversed;
    notify();
  });
  expect(compute).toHaveBeenCalledTimes(2);
  expect(indices()[299].props.currentPosition).toBe(1);
  expect(view.root.findAllByProps({ role: "img" })).toHaveLength(299);
  expect(view.root.findAllByProps({ role: "status" })).toHaveLength(1);

  await act(async () => {
    vortexState.activeProfileId = "q";
    notify();
  });
  expect(compute).toHaveBeenCalledTimes(3);
  expect(view.root.findAllByProps({ role: "img" })).toHaveLength(0);
  expect(indices()[299].props.currentPosition).toBe(300);
  await act(async () => {
    view.unmount();
  });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);

  // Orders can change while no consumer is mounted; a later mount must read it.
  vortexState.persistent.loadOrder.q = reversed;
  await act(async () => {
    view = create(renderRows(reversed.slice(0, 10)));
  });
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(compute).toHaveBeenCalledTimes(4);
  expect(indices()[0].props.currentPosition).toBe(1);
  expect(view.root.findAllByProps({ role: "img" })).toHaveLength(10);
  await act(async () => {
    view.unmount();
  });
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
});

it("catches an order change between render and effect subscription", async () => {
  const a = { id: "a", name: "A", enabled: true };
  const b = {
    id: "b",
    name: "B",
    enabled: true,
    data: { orderRules: { selfAfter: ["a"] } },
  };
  vortexState.profiles.p = { id: "p", gameId: GAME_ID };
  vortexState.activeProfileId = "p";
  vortexState.persistent.loadOrder = { p: [a, b] };
  const unsubscribe = vi.fn();
  const api = {
    getState: () => vortexState,
    store: {
      subscribe: () => {
        vortexState.persistent.loadOrder.p = [b, a];
        return unsubscribe;
      },
    },
  };
  const Instructions = createUsageInstructions(api as any);
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(React.createElement(Instructions));
  });
  expect(view.root.findByType("li").children).toEqual([
    "b: Should be after a.",
  ]);
  await act(async () => {
    view.unmount();
  });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it("publishes a snapshot read by a newly mounted row to existing consumers", async () => {
  const a = { id: "a", name: "A", enabled: true };
  const b = {
    id: "b",
    name: "B",
    enabled: true,
    data: { orderRules: { selfAfter: ["a"] } },
  };
  vortexState.profiles.p = { id: "p", gameId: GAME_ID };
  vortexState.activeProfileId = "p";
  vortexState.persistent.loadOrder = { p: [a, b] };
  const listeners = new Set<() => void>();
  const api = {
    getState: () => vortexState,
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const Instructions = createUsageInstructions(api as any);
  const Row = createLoadOrderRow(api as any);
  let instructions!: ReactTestRenderer;
  let row!: ReactTestRenderer;
  await act(async () => {
    instructions = create(React.createElement(Instructions));
  });
  expect(instructions.root.findAllByProps({ role: "status" })).toHaveLength(0);

  // A parent subscribed to Redux can mount a row before our listener runs.
  vortexState.persistent.loadOrder.p = [b, a];
  await act(async () => {
    row = create(
      React.createElement(Row, {
        item: { loEntry: b, displayCheckboxes: true },
      }),
    );
    listeners.forEach((listener) => listener());
  });
  expect(instructions.root.findByType("li").children).toEqual([
    "b: Should be after a.",
  ]);
  expect(row.root.findAllByProps({ role: "img" })).toHaveLength(1);
  await act(async () => {
    instructions.unmount();
    row.unmount();
  });
  expect(listeners.size).toBe(0);
});
