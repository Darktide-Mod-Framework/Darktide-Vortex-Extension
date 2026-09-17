import * as React from "react";
import { selectors, types } from "@nexusmods/vortex-api";

import { GAME_ID } from "./constants";
import { validate } from "./loadorder";
import { type LoadOrder } from "./ordering";

const EMPTY_ORDER: LoadOrder = [];

export function useLoadOrderWarnings(api: types.IExtensionApi) {
  const [snapshot, setSnapshot] = React.useState<{
    loadOrder: LoadOrder;
    profileId?: string;
    warnings: types.IValidationResult["invalid"];
  }>({ loadOrder: EMPTY_ORDER, warnings: [] });

  React.useEffect(() => {
    let revision = 0;
    let previous: LoadOrder | undefined;
    let previousProfile: string | undefined;
    const update = () => {
      const state = api.getState() as types.IState & {
        persistent: { loadOrder?: Record<string, LoadOrder> };
      };
      const profile = selectors.activeProfile(state);
      const current: LoadOrder =
        profile?.gameId === GAME_ID
          ? (state.persistent.loadOrder?.[profile.id] ?? EMPTY_ORDER)
          : EMPTY_ORDER;
      if (current === previous && profile?.id === previousProfile) return;
      const request = ++revision;
      const result = validate(previous ?? EMPTY_ORDER, current);
      previous = current;
      previousProfile = profile?.id;
      void result.then((validation) => {
        if (request === revision)
          setSnapshot({
            loadOrder: current,
            profileId: profile?.gameId === GAME_ID ? profile.id : undefined,
            warnings: validation?.invalid ?? [],
          });
      });
    };
    // The types-only API package omits the Redux Store base declaration.
    const store = api.store as
      | { subscribe(listener: () => void): () => void }
      | undefined;
    const unsubscribe = store?.subscribe(update);
    update();
    return () => {
      ++revision;
      unsubscribe?.();
    };
  }, [api]);

  return snapshot;
}

// Capture the API once at registration; Vortex renders this component without props.
export function createUsageInstructions(
  api: types.IExtensionApi,
): React.ComponentType {
  return function UsageInstructions() {
    const { warnings } = useLoadOrderWarnings(api);

    return React.createElement(
      "div",
      null,
      React.createElement(
        "p",
        null,
        "Drag and drop to reorder mods. Mods lower in the list are loaded later and win conflicts. " +
          "Mods are automatically ordered using info.json rules. Deliberately moving a mod across a rule " +
          "keeps that exception and displays a warning. Moving it back clears the exception; no position is pinned. " +
          "Use the toggles to enable or disable mods.",
      ),
      warnings.length > 0 &&
        React.createElement(
          "div",
          {
            className: "alert alert-warning",
            role: "status",
            "aria-live": "polite",
          },
          React.createElement("strong", null, "⚠ Load order warnings"),
          React.createElement(
            "ul",
            null,
            warnings.map(({ id, reason }) =>
              React.createElement("li", { key: id }, `${id}: ${reason}`),
            ),
          ),
        ),
    );
  };
}
