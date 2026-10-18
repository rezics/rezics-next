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
    (window as any).__adapter = { count: () => store.getState().commands.size, kind: 'ark' };
    // Public destroy is tested; the React hook's initialized WeakSet may prevent
    // a reused store from attaching again after Strict Mode cleanup.
    return () => store.destroy();
  }, [store]);
  return null;
}
