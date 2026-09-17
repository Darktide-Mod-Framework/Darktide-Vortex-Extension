import * as React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { createLoadOrderRow } from "../LoadOrderRow";
import { LoadOrder } from "../ordering";
import { GAME_ID, resetAll, vortexState } from "./mocks/vortex-api";

beforeEach(resetAll);

async function setup() {
  const a = { id: "a", name: "A", enabled: true, modId: "a-id" };
  const b = {
    id: "b",
    name: "B",
    enabled: true,
    modId: "b-id",
    data: { orderRules: { selfAfter: ["a"], required: ["c"] } },
  };
  const c = { id: "c", name: "C", enabled: true };
  vortexState.profiles.p = { id: "p", gameId: GAME_ID };
  vortexState.profiles.q = { id: "q", gameId: GAME_ID };
  vortexState.activeProfileId = "p";
  vortexState.persistent.loadOrder = { p: [b, a], q: [a, c, b] };
  const listeners = new Set<() => void>();
  const dispatch = vi.fn();
  const api = {
    getState: () => vortexState,
    store: {
      dispatch,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
  const Row = createLoadOrderRow(api as any);
  const setRef = vi.fn();
  const forwardedRef = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      React.createElement(Row, {
        className: "dragging",
        item: { loEntry: b, displayCheckboxes: true, setRef },
        forwardedRef,
      }),
      { createNodeMock: () => ({ node: "row" }) },
    );
  });
  const update = async (order?: LoadOrder, profile = "p") => {
    await act(async () => {
      vortexState.activeProfileId = profile;
      if (order) vortexState.persistent.loadOrder[profile] = order;
      listeners.forEach((fn) => fn());
    });
  };
  return { a, b, c, view, update, dispatch, setRef, forwardedRef, listeners };
}

it("distinguishes ordering and dependency warnings and clears them on reorder, toggle and profile changes", async () => {
  const { a, b, c, view, update, listeners } = await setup();
  const icons = () => view.root.findAllByProps({ role: "img" });
  expect(icons().map((icon) => icon.children.join(""))).toEqual(["⚡", "⚠"]);
  expect(icons().map((icon) => icon.props.title)).toEqual([
    "Should be after a.",
    "Requires c. Required mods are missing or disabled.",
  ]);
  await update([a, b]);
  expect(icons().map((icon) => icon.children.join(""))).toEqual(["⚠"]);
  await update([a, c, b]);
  expect(icons()).toHaveLength(0);
  await update([a, { ...c, enabled: false }, b]);
  expect(icons()).toHaveLength(1);
  await update([b, a]);
  expect(icons()).toHaveLength(2);
  await update([{ ...b, enabled: false }, a]);
  expect(icons()).toHaveLength(0);
  await update([b, a]);
  await update(undefined, "q");
  expect(icons()).toHaveLength(0);
  await act(async () => view.unmount());
  expect(listeners.size).toBe(0);
});

it("forwards drag refs and preserves toggle and position actions, including locks", async () => {
  const { a, b, view, update, dispatch, setRef, forwardedRef } = await setup();
  expect(setRef).toHaveBeenCalledWith({ node: "row" });
  expect(forwardedRef).toHaveBeenCalledWith({ node: "row" });
  expect(view.root.findByType("li").props.className).toContain("dragging");
  view.root.findByType("input").props.onChange({ target: { checked: false } });
  expect(dispatch).toHaveBeenLastCalledWith({
    type: "SET_FB_LOAD_ORDER_ENTRY",
    payload: { profileId: "p", loEntry: { ...b, enabled: false } },
  });
  const index = () => view.root.findByType("vortex-load-order-index" as any);
  index().props.onApplyIndex(2);
  expect(dispatch).toHaveBeenLastCalledWith({
    type: "SET_FB_LOAD_ORDER",
    payload: { profileId: "p", loadOrder: [a, b] },
  });
  dispatch.mockClear();
  await update([{ ...b, locked: "always" }, a]);
  expect(view.root.findByType("input").props.disabled).toBe(true);
  expect(index().props.lockedEntriesCount).toBe(1);
  view.root.findByType("input").props.onChange({ target: { checked: false } });
  index().props.onApplyIndex(2);
  expect(dispatch).not.toHaveBeenCalled();
  await act(async () => view.unmount());
  expect(setRef).toHaveBeenLastCalledWith(null);
  expect(forwardedRef).toHaveBeenLastCalledWith(null);
});
