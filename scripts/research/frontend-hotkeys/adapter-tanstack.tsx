'use client';
import { useHotkeys, HotkeyManager } from '@tanstack/react-hotkeys';
import { useEffect } from 'react';
import { blocked } from './policy.mjs';

export function Adapter({ rows, act }: any) {
  useHotkeys(rows.map((row: any) => ({ hotkey: row.key,
    options: { enabled: row.enabled, preventDefault: false, stopPropagation: false,
      capture: false, ignoreInputs: false },
    callback: (event: KeyboardEvent) => {
      if (blocked(event, row.id)) return;
      event.preventDefault(); act(row.id, event);
    },
  })));
  useEffect(() => {
    const manager = HotkeyManager.getInstance();
    (window as any).__adapter = { count: () => manager.registrations.state.size, kind: 'tanstack' };
  }, []);
  return null;
}
