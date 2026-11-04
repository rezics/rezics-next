import { useEffect, useRef } from 'react';

/** A return can focus only an occurrence in this mounted response, never load intervening pages. */
export function useCollectionComparisonReturn(members: readonly { id?: string }[], currentHref: string | undefined) {
  const restored = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!currentHref) return;
    function restore() {
      const hash = window.location.hash;
      if (!hash || restored.current === hash) return;
      const member = members.find((member) => member.id && hash === `#collection-member-${member.id}`);
      if (!member?.id) return;
      const element = document.getElementById(`collection-member-${member.id}`);
      if (!element || (document.activeElement !== document.body && document.activeElement !== element)) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: 'nearest' });
      restored.current = hash;
    }
    restore();
    window.addEventListener('hashchange', restore);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('hashchange', restore);
      window.removeEventListener('pageshow', restore);
    };
  }, [members, currentHref]);
}
