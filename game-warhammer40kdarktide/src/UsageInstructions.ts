import * as React from "react";
import { types } from "@nexusmods/vortex-api";
import { useLoadOrderWarnings } from "./loadOrderWarnings";

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
