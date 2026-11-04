import { copiesSubjectId } from '../copies-query';

/** Preserve only the localized copy inventory address, never a copy's private ownership fields. */
export function copyInventoryReturnHref(
  address: { subjectId: string | null; kind?: string | null; status?: string | null; cursor?: string | null },
  locale: string,
): string | undefined {
  if (address.subjectId && !copiesSubjectId(address.subjectId)) return;
  const validFilter = (value: string | null | undefined) =>
    value == null || /^[a-z][a-z0-9_.-]{0,63}(?![\s\S])/.test(value);
  if (!validFilter(address.kind) || !validFilter(address.status)) return;
  if (address.cursor && address.cursor.length > 2048) return;
  const query = new URLSearchParams();
  if (address.subjectId) query.set('subjectId', address.subjectId);
  if (address.kind) query.set('kind', address.kind);
  if (address.status) query.set('status', address.status);
  if (address.cursor) query.set('cursor', address.cursor);
  const href = `/${encodeURIComponent(locale)}/library/copies${query.size ? `?${query}` : ''}`;
  return href.length <= 2048 ? href : undefined;
}
