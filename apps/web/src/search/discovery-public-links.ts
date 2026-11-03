import { threadLocation } from '../threads/thread-href';
/** Build local owner routes from the current, already admitted summary fields. */
export function discoveryCollectionHref(id: string, locale: string): string {
  return `/${encodeURIComponent(locale)}/collections/${encodeURIComponent(id)}`;
}

export function discoveryReviewHref(id: string, title: string | null, locale: string): string {
  return threadLocation(locale, { id, title });
}

export function discoverySpaceHref(address: string, locale: string): string {
  return `/${encodeURIComponent(locale)}/spaces/${encodeURIComponent(address)}`;
}
