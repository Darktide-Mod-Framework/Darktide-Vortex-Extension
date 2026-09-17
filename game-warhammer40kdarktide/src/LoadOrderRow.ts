import * as React from "react";
import {
  actions,
  Icon,
  LoadOrderIndexInput,
  types,
} from "@nexusmods/vortex-api";
import { getOrderWarnings } from "./loadorder";
import { useLoadOrderWarnings } from "./UsageInstructions";

type RowProps = React.ComponentProps<
  NonNullable<types.ILoadOrderGameInfo["customItemRenderer"]>
>;
const isLocked = (entry: types.ILoadOrderEntry) =>
  entry.locked === true || entry.locked === "true" || entry.locked === "always";

export function createLoadOrderRow(
  api: types.IExtensionApi,
): React.ComponentType<RowProps> {
  return function LoadOrderRow({ item, className, forwardedRef }) {
    const { loadOrder, profileId } = useLoadOrderWarnings(api);
    const entry =
      loadOrder.find((mod) => mod.id === item.loEntry.id) ?? item.loEntry;
    const warnings = React.useMemo(
      () => getOrderWarnings(loadOrder),
      [loadOrder],
    ).filter((warning) => warning.id === entry.id);
    const position = loadOrder.findIndex((mod) => mod.id === entry.id) + 1;
    const locked = isLocked(entry);
    const external = entry.modId === undefined;
    const name = entry.name || entry.id;
    const setRef = React.useCallback(
      (node: any) => {
        item.setRef?.(node);
        if (forwardedRef !== item.setRef) forwardedRef?.(node);
      },
      [item.setRef, forwardedRef],
    );

    const applyIndex = (index: number) => {
      if (
        !profileId ||
        locked ||
        !position ||
        index === position ||
        !Number.isInteger(index) ||
        index < 1 ||
        index > loadOrder.length
      )
        return;
      const reordered = loadOrder.filter((mod) => mod.id !== entry.id);
      reordered.splice(index - 1, 0, entry);
      api.store?.dispatch(actions.setFBLoadOrder(profileId, reordered));
    };

    return React.createElement(
      "li",
      {
        ref: setRef,
        className: [
          "list-group-item load-order-entry",
          className,
          external ? "external" : "",
        ]
          .filter(Boolean)
          .join(" "),
      },
      React.createElement(Icon, {
        className: "drag-handle-icon",
        name: "drag-handle",
      }),
      React.createElement(LoadOrderIndexInput, {
        className: "load-order-index",
        api,
        item: entry,
        loadOrder,
        currentPosition: position || item.position || 1,
        lockedEntriesCount: loadOrder.filter(isLocked).length,
        isLocked,
        onApplyIndex: applyIndex,
      }),
      warnings.map(({ kind, reason }) => {
        const label =
          kind === "ordering" ? "Ordering conflict" : "Missing dependency";
        const explanation =
          kind === "dependency"
            ? `${reason} Required mods are missing or disabled.`
            : reason;
        return React.createElement(
          "span",
          {
            key: kind,
            className: "darktide-order-warning text-warning",
            title: explanation,
            "aria-label": `${label}: ${explanation}`,
            role: "img",
            tabIndex: 0,
            style: { color: "#f0ad4e", marginRight: "0.5em", flexShrink: 0 },
          },
          kind === "ordering" ? "⚡" : "⚠",
        );
      }),
      React.createElement(
        "p",
        { className: "load-order-name", title: name },
        name,
      ),
      external &&
        React.createElement(
          "div",
          { className: "load-order-unmanaged-banner" },
          React.createElement(Icon, {
            className: "external-caution-logo",
            name: "feedback-warning",
          }),
          React.createElement(
            "span",
            { className: "external-text-area" },
            "Not managed by Vortex",
          ),
        ),
      item.displayCheckboxes &&
        React.createElement(
          "div",
          { className: "entry-checkbox checkbox" },
          React.createElement(
            "label",
            null,
            React.createElement("input", {
              type: "checkbox",
              checked: entry.enabled,
              disabled: locked || !profileId,
              "aria-label": `Enable ${name}`,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                if (profileId && !locked)
                  api.store?.dispatch(
                    actions.setFBLoadOrderEntry(profileId, {
                      ...entry,
                      enabled: event.target.checked,
                    }),
                  );
              },
            }),
          ),
        ),
      locked &&
        React.createElement(Icon, {
          className: "locked-entry-logo",
          name: "locked",
        }),
    );
  };
}
