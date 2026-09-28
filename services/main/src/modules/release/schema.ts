import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { contentLanguages, languageListLiteral, originalLanguages, recordedLanguageTag, textLanguage,
  InvalidContentLanguages } from './languages.ts';

export const RELEASE_PROFILE_ID = 'release-v1';
export const RELEASE_PROFILE = 'https://rezics.com/definition/release-v1';
export const RELEASE_KINDS = ['formal', 'web', 'fixed', 'virtual'] as const;
export const RELEASE_STATUSES = ['official', 'unofficial', 'virtual', 'withdrawn', 'cancelled'] as const;
/** One release page, then at most this many snapshots on each web publication. */
export const RELEASE_COST = { languages: 8, stateBytes: 8 * 1024, snapshots: 20, page: 20,
  commandGraphCalls: 16, commandGraphBytes: 1024 * 1024, deadlineMs: 10_000 } as const;

const closed = { additionalProperties: false } as const;
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const language = t.String({ minLength: 1, maxLength: 35 });
const recorded = t.Object({ value: text(500), language }, closed);
const kind = t.Union([t.Literal('formal'), t.Literal('web'), t.Literal('fixed'), t.Literal('virtual')]);
const status = t.Union([t.Literal('official'), t.Literal('unofficial'), t.Literal('virtual'),
  t.Literal('withdrawn'), t.Literal('cancelled')]);
const coverage = t.Object({ scope: text(120), complete: t.Boolean() }, closed);

export const releaseWrite = t.Object({
  profile: t.Literal('release-v1'),
  expectedHead: t.Nullable(native),
  actingSubject: native,
  id: native,
  kind, status,
  contentLanguages: t.Array(language, { maxItems: RELEASE_COST.languages }),
  isTranslation: t.Boolean(),
  originalLanguages: t.Array(language, { maxItems: 4 }),
  titleLanguage: t.Nullable(language),
  tracklistLanguage: t.Nullable(language),
  title: recorded,
  editionStatement: t.Nullable(text(200)),
  publisher: t.Nullable(text(300)),
  publicationYear: t.Nullable(t.Integer({ minimum: 1, maximum: 9999 })),
  isbn13: t.Nullable(t.String({ pattern: '^97[89][0-9]{10}$' })),
  originalUrl: t.Nullable(t.String({ pattern: '^https://[^\\s]{1,500}$', maxLength: 512 })),
  fixedRelease: t.Nullable(native),
  coverage: t.Nullable(coverage),
  evidence: t.Nullable(native),
}, closed);

export type ReleaseWrite = Static<typeof releaseWrite>;
export type ReleaseKind = ReleaseWrite['kind'];
export type ReleaseStatus = ReleaseWrite['status'];
export interface ReleaseRecord extends ReleaseWrite { work: string }
export class InvalidRelease extends Error {}
export class StaleRelease extends Error {}
export class ReleaseUnavailable extends Error {}

function isbnOk(value: string): boolean {
  return [...value].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10 === 0;
}

/** Kind and status stay paired: virtual is never a publication claim, and a
 * publication is never given virtual status to disguise it. */
export function assertReleasePairing(releaseKind: ReleaseKind, releaseStatus: ReleaseStatus): void {
  if ((releaseKind === 'virtual') !== (releaseStatus === 'virtual')) {
    throw new InvalidRelease('A virtual release is always virtual, and only a virtual release has virtual status');
  }
}

export function checkedRelease(input: unknown, work: string): ReleaseRecord {
  if (!Value.Check(releaseWrite, input) || !Value.Check(native, work)) {
    throw new InvalidRelease('Release does not match its schema');
  }
  let languages: string[];
  let originals: string[];
  let titleLanguage: string | null;
  let tracklistLanguage: string | null;
  try {
    languages = contentLanguages(input.contentLanguages);
    originals = originalLanguages(input.originalLanguages, input.isTranslation);
    titleLanguage = textLanguage(input.titleLanguage);
    tracklistLanguage = textLanguage(input.tracklistLanguage);
    recordedLanguage(input.title.language);
  } catch (error) {
    if (error instanceof InvalidContentLanguages) throw new InvalidRelease(error.message);
    throw error;
  }
  assertReleasePairing(input.kind, input.status);
  if (input.isbn13 && !isbnOk(input.isbn13)) throw new InvalidRelease('ISBN-13 checksum is invalid');
  if (input.kind === 'web' && !input.originalUrl) throw new InvalidRelease('A web publication records its original URL');
  if (input.kind !== 'web' && input.originalUrl) throw new InvalidRelease('Only a web publication records an original URL');
  if (input.kind === 'fixed' && !input.fixedRelease) throw new InvalidRelease('A fixed release points at its seal');
  if (input.kind !== 'fixed' && input.fixedRelease) throw new InvalidRelease('Only a fixed release points at a seal');
  if (input.kind === 'virtual' && !input.coverage) throw new InvalidRelease('A virtual release states its coverage');
  if (input.kind !== 'virtual' && input.coverage) throw new InvalidRelease('Coverage is stated by a virtual release');
  if (input.expectedHead === null && input.evidence) throw new InvalidRelease('A new release has no correction evidence');
  const record: ReleaseRecord = { ...input, work, contentLanguages: languages, originalLanguages: originals,
    titleLanguage, tracklistLanguage, title: { value: input.title.value, language: recordedLanguage(input.title.language) } };
  if (Buffer.byteLength(JSON.stringify(record)) > RELEASE_COST.stateBytes) {
    throw new InvalidRelease('Release exceeds its byte budget');
  }
  return record;
}

function recordedLanguage(value: string): string {
  try { return recordedLanguageTag(value); }
  catch (error) {
    if (error instanceof InvalidContentLanguages) throw new InvalidRelease(error.message);
    throw error;
  }
}

/** A closed external record can be corrected with evidence. It cannot gain a later
 * translation or an extra content language. A virtual release may gain languages. */
export function assertReleaseCorrection(before: ReleaseRecord, after: ReleaseRecord): void {
  if (before.id !== after.id || before.work !== after.work || before.kind !== after.kind) {
    throw new InvalidRelease('A correction keeps the release and its kind');
  }
  assertReleasePairing(after.kind, after.status);
  if (!releaseChanged(before, after)) return;
  if (before.kind === 'virtual') {
    if (after.status !== 'virtual') throw new InvalidRelease('Virtual status cannot become a publication claim');
    if (before.contentLanguages.some(tag => !after.contentLanguages.includes(tag))) {
      throw new InvalidRelease('A virtual release keeps the content versions it already carries');
    }
    if (!releaseChanged({ ...before, contentLanguages: after.contentLanguages }, after)) return;
  } else if (after.isTranslation && !before.isTranslation) {
    throw new InvalidRelease('A later translation is a new release, not an extension of a closed record');
  } else if (after.contentLanguages.length > before.contentLanguages.length
    || after.originalLanguages.length > before.originalLanguages.length) {
    throw new InvalidRelease('A closed release cannot gain languages');
  }
  if (!after.evidence) throw new InvalidRelease('A correction of a closed release cites evidence');
}

export function releaseChanged(before: ReleaseRecord, after: ReleaseRecord): boolean {
  const facts = (record: ReleaseRecord) => {
    const { evidence: ignoredEvidence, expectedHead: ignoredHead, actingSubject: ignoredActor, ...rest } = record;
    return rest;
  };
  return JSON.stringify(facts(before)) !== JSON.stringify(facts(after));
}

export function parseStoredRelease(raw: string, work: string): ReleaseRecord {
  try {
    const value = JSON.parse(raw) as { work?: string };
    const { work: stored, ...body } = value;
    if (stored && stored !== work) throw new ReleaseUnavailable('Release state is invalid');
    return checkedRelease(body, work);
  } catch (error) {
    if (error instanceof ReleaseUnavailable) throw error;
    throw new ReleaseUnavailable('Release state is invalid');
  }
}

export function releaseDigest(record: ReleaseRecord): string {
  return createHash('sha256').update(JSON.stringify({ ...record, profile: RELEASE_PROFILE })).digest('hex');
}

export function releaseLanguageLiteral(record: ReleaseRecord): string | null {
  return languageListLiteral(record.contentLanguages);
}
