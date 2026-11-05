/** Native coordinates only: no facts, snapshots or command authority live here. */
export type HistorySection = 'changes' | 'units';
export type HistoryMovement = 'previous' | 'first' | 'more';
export type HistoryPath = { current: string | undefined; previous: (string | undefined)[] };
export type HistoryTarget = { section: HistorySection; movement: HistoryMovement; cursor: string | undefined };
export type HistoryPaths = Record<HistorySection, HistoryPath>;

export function historyPaths(changes?: string, units?: string): HistoryPaths {
  return { changes: { current: changes, previous: [] }, units: { current: units, previous: [] } };
}

/** Native recovery may admit different positions from the URL. Carry only those accepted coordinates. */
export function historySearch<T extends { changes?: string; units?: string; logs?: string }>(
  previous: T,
  admitted: { changes?: string; units?: string; logs?: string },
) {
  const next = { ...previous };
  delete next.changes;
  delete next.units;
  delete next.logs;
  return { ...next, ...admitted };
}

/** Call only after the owning private reader admits this exact destination. */
export function admitHistory(paths: HistoryPaths, target: HistoryTarget | undefined, changes?: string, units?: string) {
  for (const section of ['changes', 'units'] as const) {
    const actual = section === 'changes' ? changes : units;
    const path = paths[section];
    if (target?.section === section) {
      if (actual !== target.cursor || target.movement === 'first') path.previous = [];
      else if (target.movement === 'previous') path.previous.pop();
      else path.previous = [...path.previous, path.current].slice(-8);
      path.current = actual;
    } else if (actual !== path.current) {
      // The producer restarted just this section; the sibling keeps its path.
      paths[section] = { current: actual, previous: [] };
    }
  }
}
