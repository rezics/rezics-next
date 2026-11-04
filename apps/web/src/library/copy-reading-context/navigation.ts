import { copiesSubjectId } from '../copies-query';

/** Preserve only the localized copy inventory address, never a copy's private ownership fields. */
export function copyInventoryReturnHref(
  address: { subjectId: string | null; cursor?: string | null },
  locale: string,
): string | undefined {
  if (address.subjectId && !copiesSubjectId(address.subjectId)) return;
  if (address.cursor && address.cursor.length > 2048) return;
  const query = new URLSearchParams();
  if (address.subjectId) query.set('subjectId', address.subjectId);
  if (address.cursor) query.set('cursor', address.cursor);
  const href = `/${encodeURIComponent(locale)}/library/copies${query.size ? `?${query}` : ''}`;
  return href.length <= 2048 ? href : undefined;
}
