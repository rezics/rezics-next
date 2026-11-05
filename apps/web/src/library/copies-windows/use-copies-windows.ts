import { useCallback, useRef, useState } from 'react';
import type { CopiesAddress } from '../copies-query';
import type { CopiesPageData } from '../copies-read';
import {
  admitCopiesWindowRead,
  createCopiesWindows,
  reconcileCopiesWindows,
  stageCopiesWindowMove,
  type CopiesWindowMove,
} from './model';

export function useCopiesWindows({
  address,
  reader,
  viewer,
  active,
}: {
  address: CopiesAddress;
  reader: string;
  viewer: number;
  active: boolean;
}) {
  const [state, setState] = useState(() => createCopiesWindows(address, reader, viewer));
  const current = useRef(state);
  const reconciled = reconcileCopiesWindows(current.current, address, reader, viewer, active);
  if (reconciled !== current.current) {
    current.current = reconciled;
    setState(reconciled);
  }

  const move = useCallback(
    (direction: CopiesWindowMove, target: string | null, keyboard: boolean) => {
      const next = stageCopiesWindowMove(current.current, address, direction, target, keyboard);
      if (next === current.current) return false;
      current.current = next;
      setState(next);
      return true;
    },
    [address],
  );

  const admit = useCallback(
    (page: CopiesPageData, stillCurrent: () => boolean) => {
      if (!active || !stillCurrent()) return;
      const result = admitCopiesWindowRead(current.current, address, reader, viewer, page);
      if (result.state !== current.current) {
        current.current = result.state;
        setState(result.state);
      }
      if (result.focus && stillCurrent()) {
        document.getElementById('copies-inventory-heading')?.focus();
      }
    },
    [active, address, reader, viewer],
  );

  const visible = current.current;
  return {
    current: visible.current,
    previous: visible.predecessors.at(-1),
    move,
    admit,
  };
}
