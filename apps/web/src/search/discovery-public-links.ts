import { threadLocation } from '../threads/thread-href';
import type { PublicDiscoveryHit } from './discovery';

/** Build only the local owner route from the admitted current summary. */
export function discoveryPublicHref(hit: PublicDiscoveryHit, locale: string): string {
  switch (hit.summary.kind) {
    case 'collection':
      return `/${encodeURIComponent(locale)}/collections/${encodeURIComponent(hit.key.id)}`;
    case 'review':
      return threadLocation(locale, { id: hit.key.id, title: hit.summary.value.title });
    case 'space':
      return `/${encodeURIComponent(locale)}/spaces/${encodeURIComponent(hit.summary.value.address)}`;
  }
}
