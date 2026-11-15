import {
  canonicalLanguageKey,
  parseLanguagePreferences,
  MAX_LANGUAGE_PREFERENCES_LENGTH,
} from '@rezics/definitions/language';
import * as v from 'valibot';
import { locales, type Locale } from '../../paraglide/runtime.js';
import { hostedId } from './native-api';
import type { BookAddress, BookContentsAddress } from './source';
import { bookLanguagePreferenceWithinBounds, type BookLanguagePreference } from './languages';

const cursor = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const language = v.pipe(
  v.string(),
  v.check((value) => canonicalLanguageKey(value) === value),
);
export const bookLanguagePreferenceSchema = v.pipe(
  v.strictObject({
    language: v.nullable(language),
    preferredLanguages: v.array(language),
  }),
  v.check(bookLanguagePreferenceWithinBounds),
);

const searchSchema = v.pipe(
  v.object({
    release: v.optional(hostedId),
    bodyLanguage: v.optional(language),
    bodyPost: v.optional(hostedId),
    bodyRevision: v.optional(hostedId),
    bodySha256: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
    language: v.optional(v.union([v.literal('automatic'), language])),
    preferred: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(MAX_LANGUAGE_PREFERENCES_LENGTH),
        v.check((value) => parseLanguagePreferences(value) !== null),
      ),
    ),
    occurrence: v.optional(hostedId),
    view: v.optional(v.picklist(['chapter', 'contents', 'catalogues'])),
    subject: v.optional(hostedId),
    parent: v.optional(hostedId),
    cursor: v.optional(cursor),
    returnParent: v.optional(hostedId),
    returnCursor: v.optional(cursor),
    catalogueReturn: v.optional(v.literal('1')),
    catalogueCursor: v.optional(cursor),
  }),
  v.check((search) => {
    const pinned = [search.bodyPost, search.bodyRevision, search.bodySha256].filter(
      (value) => value !== undefined,
    ).length;
    return (
      (pinned === 0 || (pinned === 3 && !!search.release && !!search.occurrence)) &&
      (search.preferred === undefined || search.language !== undefined) &&
      (search.bodyLanguage === undefined || pinned === 3)
    );
  }),
);
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

export function bookPreferenceFromSearch(search: HostedBookSearch): BookLanguagePreference | undefined {
  return search.language === undefined
    ? undefined
    : {
        language: search.language === 'automatic' ? null : search.language,
        preferredLanguages: parseLanguagePreferences(search.preferred) ?? [],
      };
}

export function hostedBookSearch(address: BookAddress, contentsReturn?: BookContentsAddress | null): HostedBookSearch {
  const release = address.publication.releaseRevisionId;
  const occurrence = address.selection?.occurrenceId;
  const exact = address.selection
    ? {
        ...(address.selection.bodyLanguage ? { bodyLanguage: address.selection.bodyLanguage } : {}),
        bodyPost: address.selection.body.postId,
        bodyRevision: address.selection.body.revisionId,
        bodySha256: address.selection.body.sha256,
      }
    : {};
  const languagePreference = address.languagePreference
    ? {
        language: address.languagePreference.language ?? 'automatic',
        ...(address.languagePreference.preferredLanguages.length
          ? { preferred: address.languagePreference.preferredLanguages.join(',') }
          : {}),
      }
    : {};
  if (address.kind === 'contents')
    return {
      release,
      occurrence,
      ...exact,
      ...languagePreference,
      view: 'contents',
      ...(address.parentOccurrenceId ? { parent: address.parentOccurrenceId } : {}),
      ...(address.cursor ? { cursor: address.cursor } : {}),
    };
  return {
    release,
    occurrence,
    ...exact,
    ...languagePreference,
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
