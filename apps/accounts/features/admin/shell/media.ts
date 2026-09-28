'use client';

import { useSyncExternalStore } from 'react';

/** Whether the viewport is at most `width` pixels wide. The server and the
 * first render assume a wide screen, so a phone switches after hydration. */
export function useNarrow(width: number): boolean {
  const query = `(max-width: ${width}px)`;
  return useSyncExternalStore(listener => {
    const media = matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, () => matchMedia(query).matches, () => false);
}
