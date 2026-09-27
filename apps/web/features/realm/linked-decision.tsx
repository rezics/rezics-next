'use client';

import { useEffect } from 'react';

/**
 * Marks the Decision a "Why here?" link opened. `:target` cannot do it: the
 * link is a client navigation, and `pushState` never updates `:target`. The
 * entry gets `data-linked` and is brought to the middle of the screen.
 */
export function LinkedDecision({ listId }: { listId: string }) {
  useEffect(() => {
    function mark() {
      const list = document.getElementById(listId);
      const id = decodeURIComponent(location.hash.slice(1));
      for (const item of list?.querySelectorAll('[data-linked]') ?? []) item.removeAttribute('data-linked');
      const target = id ? list?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) : null;
      if (!target) return;
      target.setAttribute('data-linked', '');
      target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto' : 'smooth' });
    }
    mark();
    addEventListener('hashchange', mark);
    addEventListener('popstate', mark);
    return () => { removeEventListener('hashchange', mark); removeEventListener('popstate', mark); };
  }, [listId]);
  return null;
}
