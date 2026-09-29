import type { PageId } from './pages.ts';

/**
 * Whether each page's copy is final. Everything G-480 wrote is a placeholder that
 * shows the intended structure and length; G-481 writes the final copy and flips
 * its pages here. Rendered as `data-copy` on `<main>` so a review can see it.
 */
export type CopyStatus = 'placeholder' | 'final';

export const copyStatus: Record<PageId, CopyStatus> = {
  home: 'placeholder',
  reading: 'placeholder',
  'light-novels': 'placeholder',
  'serial-fiction': 'placeholder',
  acgn: 'placeholder',
  wikis: 'placeholder',
  communities: 'placeholder',
  distribution: 'placeholder',
  developers: 'placeholder',
  trust: 'placeholder',
  roadmap: 'placeholder',
};
