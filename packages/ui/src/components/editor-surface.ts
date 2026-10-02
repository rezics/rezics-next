import { useEffect, useState } from 'react';

// Tiptap initializes its menu as absolute. Matching that strategy keeps the first placement
// in the same coordinate system as later updates inside a positioned writing surface.
export const bubbleOptions = { placement: 'top' as const, strategy: 'absolute' as const, offset: 8, flip: true, shift: { padding: 8 } };

export type PointerMode = 'auto' | 'fine' | 'coarse';

const coarseQuery = '(hover: none) and (pointer: coarse)';

/**
 * Whether the primary input is a finger. Selection menus belong to a pointer; a phone's own
 * selection handles and system menu occupy the same place, so touch gets a keyboard toolbar instead.
 */
export function useCoarsePointer(mode: PointerMode = 'auto'): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (mode !== 'auto') return;
    const query = window.matchMedia(coarseQuery);
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [mode]);
  return mode === 'auto' ? coarse : mode === 'coarse';
}
