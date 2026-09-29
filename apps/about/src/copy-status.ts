import type { PageId } from './pages.ts';

/**
 * Whether each page's copy is final. G-480 wrote placeholders to show structure; G-481
 * wrote the final English copy for every page (translations follow in G-482). A page goes
 * back to `placeholder` while its copy is being rewritten. Rendered as `data-copy` on
 * `<main>` so a review can see it.
 */
export type CopyStatus = 'placeholder' | 'final';

export const copyStatus: Record<PageId, CopyStatus> = {
  home: 'final',
  reading: 'final',
  'light-novels': 'final',
  'serial-fiction': 'final',
  acgn: 'final',
  wikis: 'final',
  agents: 'final',
  communities: 'final',
  distribution: 'final',
  developers: 'final',
  trust: 'final',
  roadmap: 'final',
};
