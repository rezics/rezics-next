import { useLayoutEffect, useRef, useState } from 'react';
import type { HistoryOrigin } from '../history-current-origin';
import type { FollowingRow } from './presentation';

export type FollowingSelection = {
  row: FollowingRow;
  trigger: HTMLButtonElement;
  id: string;
  active: boolean;
  current: () => boolean;
};

/** Separate read observation identity from the removal owner's intent equivalence. */
export function useFollowingSelection(source: object, locale: string, origin: HistoryOrigin) {
  const observation = useRef({ source, locale, parent: origin.lifetime, active: true, mounted: false });
  const selected = useRef<FollowingSelection | null>(null);
  const bookmark = useRef<{ owner: object; trigger: HTMLButtonElement } | null>(null);
  const latest = useRef(origin);
  latest.current = origin;
  const [, render] = useState(0);
  if (
    observation.current.source !== source ||
    observation.current.locale !== locale ||
    observation.current.parent !== origin.lifetime
  ) {
    observation.current.active = false;
    if (selected.current) selected.current.active = false;
    selected.current = null;
    observation.current = { source, locale, parent: origin.lifetime, active: true, mounted: false };
  }
  if (selected.current && !origin.isCurrent()) {
    selected.current.active = false;
    selected.current = null;
  }
  const owner = observation.current;
  const current = () => owner.active && owner.mounted && origin.isCurrent() && latest.current.isCurrent();
  useLayoutEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
    };
  }, [owner]);
  function close(focus = true) {
    const previous = selected.current;
    if (!previous) return;
    const restore = previous.current();
    previous.active = false;
    selected.current = null;
    render((n) => n + 1);
    // Synchronous focus has no callback that a replacement account could inherit.
    if (focus && restore && current() && previous.trigger.isConnected) previous.trigger.focus();
  }
  function select(row: FollowingRow, trigger: HTMLButtonElement) {
    if (!current()) return;
    if (selected.current) selected.current.active = false;
    const selection: FollowingSelection = {
      row,
      trigger,
      active: true,
      id: crypto.randomUUID(),
      current: () => selection.active && selected.current === selection && current(),
    };
    selected.current = selection;
    bookmark.current = { owner, trigger };
    render((n) => n + 1);
  }
  function restoreFocus() {
    if (current() && bookmark.current?.owner === owner && bookmark.current.trigger.isConnected)
      bookmark.current.trigger.focus();
  }
  return { selection: selected.current?.current() ? selected.current : null, select, close, current, restoreFocus };
}
