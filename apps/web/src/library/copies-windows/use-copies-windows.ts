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
  const [, setRevision] = useState(0);
  const current = useRef(createCopiesWindows(address, reader, viewer));
  const reconciled = reconcileCopiesWindows(current.current, address, reader, viewer, active);
  current.current = reconciled;

  const move = useCallback(
    (direction: CopiesWindowMove, target: string | null, keyboard: boolean) => {
      const next = stageCopiesWindowMove(current.current, address, direction, target, keyboard);
      if (next === current.current) return false;
      current.current = next;
      setRevision((revision) => revision + 1);
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
        setRevision((revision) => revision + 1);
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
