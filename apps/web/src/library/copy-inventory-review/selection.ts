import { useLayoutEffect, useRef, useState } from 'react';
import type { CopyItem } from '../copies-read';

export const copyComparisonLimit = 4;
export type ObservedCopy = Pick<CopyItem, 'id' | 'revision'>;
export type RetiredCopy = ObservedCopy & { reason: 'changed' | 'missing' };

type Selection = {
  scope: string;
  lifetime: object;
  selected: (ObservedCopy & { trigger: HTMLButtonElement })[];
  retired: RetiredCopy[];
  open: boolean;
  denied: boolean;
};

const emptySelection = (scope: string): Selection => ({
  scope,
  lifetime: {},
  selected: [],
  retired: [],
  open: false,
  denied: false,
});

/** Only exact observations are retained. Private values always come from the current received rows. */
export function useCopyInventoryReview({
  copies,
  scope,
  current,
}: {
  copies: CopyItem[];
  scope: string;
  current: () => boolean;
}) {
  const [stored, setStored] = useState(() => emptySelection(scope));
  const mounted = useRef(true);
  const launcher = useRef<HTMLButtonElement | null>(null);
  let selection = stored;
  // The address includes locale and the native subject/kind/status/cursor tuple.
  // A fresh token prevents A/B/A from accepting callbacks from the first A.
  if (selection.scope !== scope) {
    selection = emptySelection(scope);
    launcher.current = null;
  }
  if (!current() && !selection.denied) {
    selection = { ...emptySelection(scope), denied: true };
    launcher.current = null;
  }
  if (selection.selected.length) {
    const selected: Selection['selected'] = [];
    const retired = [...selection.retired];
    for (const observation of selection.selected) {
      const row = copies.find((copy) => copy.id === observation.id);
      if (row?.revision === observation.revision) selected.push(observation);
      else retired.push({ id: observation.id, revision: observation.revision, reason: row ? 'changed' : 'missing' });
    }
    if (selected.length !== selection.selected.length) selection = { ...selection, selected, retired };
  }
  if (selection !== stored) setStored(selection);
  const latest = useRef(selection);
  latest.current = selection;
  const rows = useRef(copies);
  rows.current = copies;
  const origin = useRef(current);
  origin.current = current;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      launcher.current = null;
    };
  }, []);

  const available = () =>
    mounted.current &&
    current() &&
    origin.current() &&
    latest.current.lifetime === selection.lifetime &&
    !latest.current.denied;
  const exact = (observation: ObservedCopy) =>
    rows.current.find((copy) => copy.id === observation.id && copy.revision === observation.revision);
  const update = (next: Selection) => {
    latest.current = next;
    setStored(next);
  };
  const has = (copy: ObservedCopy) =>
    selection.selected.some((item) => item.id === copy.id && item.revision === copy.revision);

  return {
    open: selection.open,
    retired: selection.retired,
    // Filtering the native page rather than the selection preserves received ordering.
    copies: copies.filter(has),
    count: selection.selected.length,
    selected: has,
    canSelect: (copy: ObservedCopy) => has(copy) || selection.selected.length < copyComparisonLimit,
    toggle(copy: ObservedCopy, trigger: HTMLButtonElement) {
      if (!available() || !exact(copy)) return;
      const state = latest.current;
      const selected = state.selected.some((item) => item.id === copy.id && item.revision === copy.revision);
      if (!selected && state.selected.length === copyComparisonLimit) return;
      launcher.current = trigger;
      update({
        ...state,
        selected: selected
          ? state.selected.filter((item) => item.id !== copy.id)
          : [...state.selected, { id: copy.id, revision: copy.revision, trigger }],
        retired: state.retired.filter((item) => item.id !== copy.id),
      });
    },
    show() {
      if (available()) update({ ...latest.current, open: true });
    },
    remove(copy: ObservedCopy) {
      if (!available()) return;
      update({ ...latest.current, selected: latest.current.selected.filter((item) => item.id !== copy.id) });
    },
    reset() {
      if (available()) update({ ...latest.current, selected: [], retired: [] });
    },
    dismissRetired() {
      if (available()) update({ ...latest.current, retired: [] });
    },
    close() {
      if (!available()) return;
      update({ ...latest.current, open: false });
      const trigger = launcher.current;
      if (trigger?.isConnected) trigger.focus();
    },
    handoff(copy: ObservedCopy, run: (row: CopyItem, trigger: HTMLButtonElement | null) => void) {
      if (!available()) return;
      const row = exact(copy);
      if (!row || !latest.current.selected.some((item) => item.id === row.id && item.revision === row.revision)) return;
      const trigger = latest.current.selected.find((item) => item.id === row.id)?.trigger;
      run(row, trigger?.isConnected ? trigger : null);
    },
  };
}

export type CopyInventorySelection = ReturnType<typeof useCopyInventoryReview>;
