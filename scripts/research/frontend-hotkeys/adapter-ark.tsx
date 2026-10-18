'use client';
import { createHotkeyStore, useHotkeys } from '@ark-ui/react/hotkeys';
import { useEffect, useState } from 'react';
import { blocked } from './policy.mjs';

export function Adapter({ rows, act }: any) {
  const [store] = useState(() => createHotkeyStore());
  useHotkeys({ store, commands: rows.map((row: any) => ({ id: row.id,
    hotkey: Array.isArray(row.key) ? row.key.join(' > ') : row.key,
    enabled: row.enabled,
    // Library consumption occurs before callbacks. Shared event policy must get
    // the original event, so disable automatic consumption and use bubble.
    options: { capture: false, preventDefault: false, stopPropagation: false,
      enableOnFormTags: true, enableOnContentEditable: true },
    action: (event: KeyboardEvent) => {
      if (blocked(event, row.id)) return;
      event.preventDefault(); act(row.id, event);
    },
  })) });
  useEffect(() => {
    // Pair public init/destroy ourselves: the hook's one-time WeakSet does not
    // reinitialize a destroyed store during Strict Mode effect replay.
    store.init({ target: document });
    (window as any).__adapter = { count: () => store.getState().commands.size, kind: 'ark' };
    return () => store.destroy();
  }, [store]);
  return null;
}
