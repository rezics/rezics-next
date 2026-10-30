import type { SitemapFamily } from './pack.ts';

/** A Web adapter result, not a native DTO. The source id and ordered family key come from the owner. */
export type CanonicalSitemapItem = {
  id: string;
  key: string;
  family: SitemapFamily | null;
};

export type CanonicalSitemapPage = { items: CanonicalSitemapItem[]; next: string | null };

/** Missing projection is a failed replacement, including when the current source page has no items. */
export function canonicalProjectionUnavailable(feed: string, missing: string): never {
  throw Object.assign(new Error(`Sitemap feed ${feed} canonical projection unavailable: ${missing}`), {
    status: 503,
  });
}
