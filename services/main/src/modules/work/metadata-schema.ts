import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { hash } from './activate.ts';

export const METADATA_PROFILE = 'https://rezics.com/definition/work-metadata-details-v1';
/** Per command: one component, ≤20 locales, ≤64 KiB UTF-8. Edition pages select ≤20
 * identities before payload hydration. These are logical bounds, not Jena seek guarantees. */
export const WORK_METADATA_COST = { locales: 20, stateBytes: 64 * 1024,
  commandGraphCalls: 24, commandGraphBytes: 2 * 1024 * 1024, deadlineMs: 10_000 } as const;
const closed = { additionalProperties: false } as const;
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const language = t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
export const recordedText = t.Object({ value: text(500), language }, closed);
export const localizedMetadata = t.Object({ language, title: t.Nullable(text(500)),
  description: t.Nullable(text(4000)), mainVersionLabel: t.Nullable(text(200)) }, closed);
export const metadataHeaderState = t.Object({ kind: t.Literal('header'),
  originalTitle: t.Nullable(recordedText),
  localized: t.Array(localizedMetadata, { maxItems: WORK_METADATA_COST.locales }) }, closed);
/** Edition facts follow https://schema.org/Book (consulted 2026-09-28).
 * An edition has its own identity; it does not imply a native release or translation link. */
export const metadataEditionState = t.Object({ kind: t.Literal('edition'), id: native,
  status: t.Union([t.Literal('active'), t.Literal('withdrawn')]), title: recordedText,
  contentLanguage: t.Nullable(language), editionStatement: t.Nullable(text(200)),
  publisher: t.Nullable(text(300)), publicationYear: t.Nullable(t.Integer({ minimum: 1, maximum: 9999 })),
  isbn13: t.Nullable(t.String({ pattern: '^97[89][0-9]{10}$' })) }, closed);
export const relevanceLevel = t.Union([t.Literal('incidental'), t.Literal('substantial'), t.Literal('central')]);
/** Product policy, not a statistical score: incidental = passing treatment;
 * substantial = sustained treatment of one part; central = the Work's main subject.
 * The Work editor records it. It never grants classification acceptance or curator authority.
 * Like https://www.w3.org/TR/vocab-dqv/#dqv:QualityMeasurement, the value names its
 * policy and evaluated basis; a changed decision invalidates that basis. */
export const RELEVANCE_POLICY = 'work-editor-topical-relevance-v1';
export const metadataRelevanceState = t.Object({ kind: t.Literal('relevance'), sense: native,
  context: t.Union([t.Object({ kind: t.Literal('global') }, closed),
    t.Object({ kind: t.Literal('realm-classification'), id: native }, closed)]),
  decision: native, level: t.Nullable(relevanceLevel) }, closed);
export const metadataState = t.Union([metadataHeaderState, metadataEditionState, metadataRelevanceState]);
export const metadataWrite = t.Object({ profile: t.Literal('work-metadata-details-v1'),
  expectedHead: t.Nullable(native), state: metadataState, actingSubject: native }, closed);
export const recordedRelevance = t.Object({ level: relevanceLevel,
  policy: t.Literal(RELEVANCE_POLICY), basis: t.Literal('work-editor-assessment'), revision: native }, closed);
export type MetadataState = Static<typeof metadataState>;
export type MetadataHeaderState = Static<typeof metadataHeaderState>;
export type MetadataEditionState = Static<typeof metadataEditionState>;
export type MetadataRelevanceState = Static<typeof metadataRelevanceState>;
export interface MetadataIntent { work: string; expectedHead: string | null; state: MetadataState }
export class InvalidWorkMetadata extends Error {}
export class StaleWorkMetadata extends Error {}
export class WorkMetadataUnavailable extends Error {}

const canonicalLanguage = (value: string) => {
  try { return Intl.getCanonicalLocales(value)[0]!.toLowerCase(); }
  catch { throw new InvalidWorkMetadata('Language tag is invalid'); }
};
const canonicalText = (value: Static<typeof recordedText>) => ({ value: value.value,
  language: canonicalLanguage(value.language) });
export function checkedMetadataState(input: unknown): MetadataState {
  if (!Value.Check(metadataState, input)) throw new InvalidWorkMetadata('Metadata does not match its schema');
  let state: MetadataState;
  if (input.kind === 'header') {
    const localized = input.localized.map(row => ({ language: canonicalLanguage(row.language),
      title: row.title, description: row.description, mainVersionLabel: row.mainVersionLabel }))
      .sort((a, b) => a.language < b.language ? -1 : a.language > b.language ? 1 : 0);
    if (new Set(localized.map(row => row.language)).size !== localized.length
      || localized.some(row => row.title === null && row.description === null && row.mainVersionLabel === null)) {
      throw new InvalidWorkMetadata('Locale entries must be unique and record at least one value');
    }
    state = { kind: 'header', originalTitle: input.originalTitle === null ? null : canonicalText(input.originalTitle), localized };
  } else if (input.kind === 'edition') {
    if (input.isbn13 && [...input.isbn13].reduce((sum, digit, index) =>
      sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10 !== 0) {
      throw new InvalidWorkMetadata('ISBN-13 checksum is invalid');
    }
    state = { kind: 'edition', id: input.id, status: input.status, title: canonicalText(input.title),
      contentLanguage: input.contentLanguage === null ? null : canonicalLanguage(input.contentLanguage),
      editionStatement: input.editionStatement, publisher: input.publisher,
      publicationYear: input.publicationYear, isbn13: input.isbn13 };
  } else {
    state = { kind: 'relevance', sense: input.sense,
      context: input.context.kind === 'global' ? { kind: 'global' } : { kind: 'realm-classification', id: input.context.id },
      decision: input.decision, level: input.level };
  }
  if (Buffer.byteLength(JSON.stringify(state)) > WORK_METADATA_COST.stateBytes) {
    throw new InvalidWorkMetadata('Metadata exceeds its byte budget');
  }
  return state;
}
export function metadataComponent(work: string, state: MetadataState): string {
  if (state.kind === 'edition') return state.id;
  const key = state.kind === 'header' ? 'header'
    : `relevance\0${state.sense}\0${state.context.kind === 'global' ? 'global' : state.context.id}`;
  return `urn:rezics:work-metadata:${hash(`${work}\0${key}`)}`;
}
export function checkedMetadataIntent(input: MetadataIntent): MetadataIntent {
  if (!Value.Check(native, input.work) || input.expectedHead !== null && !Value.Check(native, input.expectedHead)) {
    throw new InvalidWorkMetadata('Work and expected revision must be native identities');
  }
  return { work: input.work, expectedHead: input.expectedHead, state: checkedMetadataState(input.state) };
}
export const metadataDigest = (input: MetadataIntent) => hash(JSON.stringify({ profile: METADATA_PROFILE,
  ...checkedMetadataIntent(input) }));
