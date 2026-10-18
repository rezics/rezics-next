'use client';
import { useEffect, useRef } from 'react';
import { blocked, match } from './policy.mjs';

export function Adapter({ rows, act }: any) {
  const current = useRef({ rows, act });
  current.current = { rows, act };
  useEffect(() => {
    let prefix = 0;
    const listener = (event: KeyboardEvent) => {
      for (const row of current.current.rows) {
        if (!row.enabled || blocked(event, row.id)) continue;
        let matched = match(event, row.key);
        if (Array.isArray(row.key)) {
          if (event.key.toLowerCase() === 'g') { prefix = Date.now() + 1000; continue; }
          matched = event.key.toLowerCase() === 'h' && prefix > Date.now();
          prefix = 0;
        }
        if (!matched) continue;
        event.preventDefault();
        current.current.act(row.id, event);
        break;
      }
    };
    window.addEventListener('keydown', listener);
    (window as any).__adapter = { count: () => current.current.rows.length, kind: 'native' };
    return () => { window.removeEventListener('keydown', listener); (window as any).__adapter = { count: () => 0 }; };
  }, []);
  return null;
}
