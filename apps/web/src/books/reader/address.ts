import * as v from 'valibot';
import { locales, type Locale } from '../../paraglide/runtime.js';
import { hostedId } from './native-api';
import type { BookAddress, BookContentsAddress } from './source';

const cursor = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const searchSchema = v.object({
  release: v.optional(hostedId),
  occurrence: v.optional(hostedId),
  view: v.optional(v.picklist(['chapter', 'contents', 'catalogues'])),
  subject: v.optional(hostedId),
  parent: v.optional(hostedId),
  cursor: v.optional(cursor),
  returnParent: v.optional(hostedId),
  returnCursor: v.optional(cursor),
});
export type HostedBookSearch = v.InferOutput<typeof searchSchema>;
export const hostedBookVisitSchema = v.strictObject({
  catalogueId: hostedId,
  locale: v.picklist(locales),
  search: searchSchema,
});
export type HostedBookVisitInput = v.InferOutput<typeof hostedBookVisitSchema>;

/** HTTP selections only. Publication, exact body and viewer are resolved by the native host. */
export function parseHostedBookSearch(search: Record<string, unknown>): HostedBookSearch {
  return v.parse(searchSchema, search);
}

export function hostedBookSearch(address: BookAddress, contentsReturn?: BookContentsAddress | null): HostedBookSearch {
  const release = address.publication.releaseRevisionId;
  const occurrence = address.selection?.occurrenceId;
  if (address.kind === 'contents')
    return {
      release,
      occurrence,
      view: 'contents',
      ...(address.parentOccurrenceId ? { parent: address.parentOccurrenceId } : {}),
      ...(address.cursor ? { cursor: address.cursor } : {}),
    };
  return {
    release,
    occurrence,
    view: 'chapter',
    ...(contentsReturn?.parentOccurrenceId ? { returnParent: contentsReturn.parentOccurrenceId } : {}),
    ...(contentsReturn?.cursor ? { returnCursor: contentsReturn.cursor } : {}),
  };
}

/** One localized public path for catalogue, Studio, native links and the mounted route. */
export function hostedBookHref(catalogueId: string, locale: Locale, search: HostedBookSearch = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) if (value !== undefined) query.set(key, value);
  return `/${locale}/books/${encodeURIComponent(catalogueId)}/read${query.size ? `?${query}` : ''}`;
}

export function hostedBookAddressHref(
  address: BookAddress,
  locale: Locale,
  contentsReturn?: BookContentsAddress | null,
  subjectId?: string,
) {
  return hostedBookHref(address.publication.id, locale, {
    ...hostedBookSearch(address, contentsReturn),
    ...(subjectId ? { subject: subjectId } : {}),
  });
}

/** Subject discovery uses the same route; the path operand is a Subject only in this view. */
export function hostedBookSubjectHref(subjectId: string, locale: Locale, cursor?: string) {
  return hostedBookHref(subjectId, locale, { view: 'catalogues', ...(cursor ? { cursor } : {}) });
}
