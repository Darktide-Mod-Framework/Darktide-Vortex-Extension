import { types } from "@nexusmods/vortex-api";

export interface OrderRules {
  required?: string[];
  selfAfter?: string[];
  selfBefore?: string[];
}

export type LoadOrder = types.ILoadOrderEntry<{
  orderRules?: OrderRules;
  // A new read gets a new token. Vortex's UpdateSet keeps entry data when it
  // restores indices, whereas dragging/index editing reuses the displayed token.
  readToken?: string;
  scope?: string;
  ignoredBefore?: string[];
}>[];

type Edge = [string, string];

function rules(order: LoadOrder): Edge[] {
  const enabled = new Set(order.filter((m) => m.enabled).map((m) => m.id));
  return order
    .flatMap((mod): Edge[] =>
      !mod.enabled
        ? []
        : [
            ...(mod.data?.orderRules?.selfAfter ?? []).map(
              (id): Edge => [id, mod.id],
            ),
            ...(mod.data?.orderRules?.selfBefore ?? []).map(
              (id): Edge => [mod.id, id],
            ),
          ],
    )
    .filter(([a, b]) => enabled.has(a) && enabled.has(b));
}

/** Only a reorder of the same displayed entries can create an exception. */
function isManualReorder(prev: LoadOrder, current: LoadOrder): boolean {
  if (
    prev.length !== current.length ||
    !current.some((m, i) => m.id !== prev[i]?.id)
  )
    return false;
  const previous = new Map(prev.map((m) => [m.id, m]));
  return current.every((m) => {
    const old = previous.get(m.id);
    return (
      old !== undefined &&
      m.enabled === old.enabled &&
      m.data?.readToken !== undefined &&
      m.data.readToken === old.data?.readToken &&
      m.data.scope === old.data?.scope
    );
  });
}

/** Stable dependency sort. Only deliberately reversed relationships are pinned,
 * never absolute indices or the entire chain of previously installed mods. */
export function orderMods(current: LoadOrder, prev: LoadOrder = []): LoadOrder {
  const positions = new Map(current.map((m, i) => [m.id, i]));
  const oldPositions = new Map(prev.map((m, i) => [m.id, i]));
  const manual = isManualReorder(prev, current);
  const activeRules = rules(current).sort(
    ([a, b], [c, d]) => a.localeCompare(c) || b.localeCompare(d),
  );
  const overrides = new Map<string, Set<string>>();
  for (const [before, after] of activeRules) {
    if (before === after) continue;
    const reversed = positions.get(before)! > positions.get(after)!;
    const remembered = current
      .find((m) => m.id === before)
      ?.data?.ignoredBefore?.includes(after);
    const newlyBroken =
      manual &&
      reversed &&
      oldPositions.get(before)! < oldPositions.get(after)!;
    // An automatic host restoration must not clear an exception. A deliberate
    // valid reorder does; missing/disabled targets and removed rules do too.
    if ((remembered && (!manual || reversed)) || newlyBroken) {
      const targets = overrides.get(before) ?? new Set<string>();
      targets.add(after);
      overrides.set(before, targets);
    }
  }

  const edges = new Map(current.map((m) => [m.id, new Set<string>()]));
  const reaches = (
    from: string,
    to: string,
    seen = new Set<string>(),
  ): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...edges.get(from)!].some((next) => reaches(next, to, seen));
  };
  const addEdge = (before: string, after: string) => {
    // Keep cycles deterministic and warn about the unsatisfied rules. An
    // impossible metadata cycle must never discard entries or block saves.
    if (!reaches(after, before)) edges.get(before)!.add(after);
  };
  for (const [before, targets] of overrides) {
    for (const after of targets) addEdge(after, before);
  }
  for (const [before, after] of activeRules) {
    if (!overrides.get(before)?.has(after)) addEdge(before, after);
  }
  const inDegree = new Map(current.map((m) => [m.id, 0]));
  for (const targets of edges.values()) {
    for (const id of targets) inDegree.set(id, inDegree.get(id)! + 1);
  }
  const remaining = new Map(current.map((m) => [m.id, m]));
  const result: LoadOrder = [];
  while (remaining.size > 0) {
    const id = [...remaining.keys()].find((id) => inDegree.get(id) === 0)!;
    const entry = remaining.get(id)!;
    const { ignoredBefore: _ignored, ...data } = entry.data ?? {};
    const ignoredBefore = overrides.get(id);
    result.push({
      ...entry,
      data: {
        ...data,
        ...(ignoredBefore?.size ? { ignoredBefore: [...ignoredBefore] } : {}),
      },
    });
    remaining.delete(id);
    for (const next of edges.get(id)!)
      inDegree.set(next, inDegree.get(next)! - 1);
  }
  return result;
}
