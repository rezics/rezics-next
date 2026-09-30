import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { contentLanguages, languageListLiteral, originalLanguages, recordedLanguageTag, textLanguage,
  InvalidContentLanguages } from './languages.ts';

export const RELEASE_PROFILE_ID = 'release-v1';
export const RELEASE_PROFILE = 'https://rezics.com/definition/release-v1';
export const RELEASE_V2_PROFILE = 'https://rezics.com/definition/release-v2';
export const RELEASE_KINDS = ['formal', 'web', 'fixed', 'virtual'] as const;
export const RELEASE_STATUSES = ['official', 'unofficial', 'virtual', 'withdrawn', 'cancelled'] as const;
/** One release page, then at most this many snapshots on each web publication. */
export const RELEASE_COST = { languages: 8, stateBytes: 8 * 1024, snapshots: 20, page: 20,
  commandGraphCalls: 16, commandGraphBytes: 1024 * 1024, deadlineMs: 10_000 } as const;
export const RELEASE_V2_COST = { coverage: 64, identifiers: 16, stateBytes: 48 * 1024,
  page: 20, lookupCoverage: 1280 } as const;

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
export const releaseIdentifier = t.Object({ provider: t.String({ pattern: '^https://[^\\s<>"{}|\\\\^`]{1,240}$' }),
  value: text(200) }, closed);
export const releaseCoverage = t.Object({ realization: native, revision: native,
  completeness: t.Union([t.Literal('complete'), t.Literal('partial'), t.Literal('trial'), t.Literal('unknown')]),
  portion: t.Optional(text(120)) }, closed);
const { contentLanguages: ignoredLanguages, isTranslation: ignoredTranslation,
  originalLanguages: ignoredOriginals, coverage: ignoredCoverage, ...releaseFields } = releaseWrite.properties;
export const releaseV2Write = t.Object({ ...releaseFields, profile: t.Literal('release-v2'),
  identifiers: t.Array(releaseIdentifier, { maxItems: RELEASE_V2_COST.identifiers }),
  platform: t.Nullable(text(120)), territory: t.Nullable(t.String({ pattern: '^(?:[A-Z]{2}|[0-9]{3})$' })),
  coverage: t.Array(releaseCoverage, { minItems: 1, maxItems: RELEASE_V2_COST.coverage }),
}, closed);
export type ReleaseV2Write = Static<typeof releaseV2Write>;
export interface CoveredRealization { realization: string; revision: string; work: string;
  language: string; kind: 'original' | 'translation'; status: 'official' | 'unofficial' }
export interface ReleaseV2Record extends ReleaseV2Write {
  work: string; contentLanguages: string[]; isTranslation: boolean; originalLanguages: string[];
  resolvedCoverage: CoveredRealization[];
}
export type AnyReleaseRecord = ReleaseRecord | ReleaseV2Record;
export class InvalidRelease extends Error {}
export class StaleRelease extends Error {}
export class ReleaseUnavailable extends Error {}

export function isbnOk(value: string): boolean {
  return [...value].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0) % 10 === 0;
}

export function checkedReleaseV2(input: unknown, work: string): ReleaseV2Write & { work: string } {
  if (!Value.Check(releaseV2Write, input) || !Value.Check(native, work)) {
    throw new InvalidRelease('Release does not match release-v2');
  }
  // Reuse the closed publication rules; v2 coverage is independent of virtual scope.
  const { identifiers: ignoredIdentifiers, platform: ignoredPlatform, territory: ignoredTerritory,
    coverage: ignoredEntries, ...publication } = input;
  const checked = checkedRelease({ ...publication, profile: 'release-v1',
    contentLanguages: [], isTranslation: false, originalLanguages: [],
    coverage: input.kind === 'virtual' ? { scope: 'realization coverage', complete: false } : null }, work);
  if (new Set(input.coverage.map(entry => entry.realization)).size !== input.coverage.length) {
    throw new InvalidRelease('A release covers each realization once; use a portion label');
  }
  if (new Set(input.identifiers.map(entry => JSON.stringify([entry.provider, entry.value]))).size !== input.identifiers.length) {
    throw new InvalidRelease('Release identifiers are distinct provider-qualified values');
  }
  return { ...input, title: checked.title, titleLanguage: checked.titleLanguage,
    tracklistLanguage: checked.tracklistLanguage, work,
    identifiers: [...input.identifiers].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    coverage: [...input.coverage].sort((a, b) => a.realization.localeCompare(b.realization)) };
}

export function resolvedReleaseV2(input: ReleaseV2Write & { work: string },
  resolved: CoveredRealization[]): ReleaseV2Record {
  if (resolved.length !== input.coverage.length || input.coverage.some(entry =>
    !resolved.some(row => row.realization === entry.realization && row.revision === entry.revision))
    || !resolved.some(row => row.work === input.work)) {
    throw new InvalidRelease('Release coverage requires exact realizations, including its editing Work');
  }
  if (input.status === 'official' && resolved.some(row => row.status !== 'official')) {
    throw new InvalidRelease('An unofficial realization cannot be presented as an official release');
  }
  const record: ReleaseV2Record = { ...input, resolvedCoverage: resolved,
    contentLanguages: [...new Set(resolved.map(row => row.language))].sort(),
    isTranslation: resolved.some(row => row.kind === 'translation'), originalLanguages: [] };
  if (Buffer.byteLength(JSON.stringify(record)) > RELEASE_V2_COST.stateBytes) {
    throw new InvalidRelease('Release exceeds its byte budget');
  }
  return record;
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
export function assertReleaseCorrection(before: AnyReleaseRecord, after: AnyReleaseRecord): void {
  if (before.id !== after.id || before.work !== after.work || before.kind !== after.kind) {
    throw new InvalidRelease('A correction keeps the release and its kind');
  }
  assertReleasePairing(after.kind, after.status);
  if (before.profile !== after.profile) throw new InvalidRelease('A correction keeps its release profile');
  if (!releaseChanged(before, after)) return;
  if (before.profile === 'release-v2' && after.profile === 'release-v2' && before.kind !== 'virtual'
    && after.coverage.some(entry => !before.coverage.some(old => old.realization === entry.realization))) {
    throw new InvalidRelease('A later realization is a new release, not an extension of a closed record');
  }
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

export function releaseChanged(before: AnyReleaseRecord, after: AnyReleaseRecord): boolean {
  const facts = (record: AnyReleaseRecord) => {
    const { evidence: ignoredEvidence, expectedHead: ignoredHead, actingSubject: ignoredActor, ...rest } = record;
    return rest;
  };
  return JSON.stringify(facts(before)) !== JSON.stringify(facts(after));
}

export function parseStoredRelease(raw: string, work?: string): AnyReleaseRecord {
  try {
    const value = JSON.parse(raw) as AnyReleaseRecord;
    const { work: stored, ...body } = value;
    if (work && stored !== work) throw new ReleaseUnavailable('Release state is invalid');
    if (body.profile === 'release-v2') {
      const { resolvedCoverage, contentLanguages: languages, isTranslation, originalLanguages: originals, ...input } = body;
      const record = resolvedReleaseV2(checkedReleaseV2(input, stored), resolvedCoverage);
      if (JSON.stringify(record.contentLanguages) !== JSON.stringify(languages)
        || record.isTranslation !== isTranslation || originals.length) throw new Error('Derived coverage differs');
      return record;
    }
    return checkedRelease(body, stored);
  } catch (error) {
    if (error instanceof ReleaseUnavailable) throw error;
    throw new ReleaseUnavailable('Release state is invalid');
  }
}

export function releaseDigest(record: AnyReleaseRecord | (ReleaseV2Write & { work: string })): string {
  if (record.profile === 'release-v2') {
    const payload = Object.fromEntries(Object.entries(record).filter(([key]) =>
      !['resolvedCoverage', 'contentLanguages', 'isTranslation', 'originalLanguages'].includes(key)));
    return createHash('sha256').update(canonicalRecord({ ...payload, profile: RELEASE_V2_PROFILE })).digest('hex');
  }
  const payload = { ...record, profile: releaseProfileOf(record) };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Request member order never changes a new Versioned command's retry identity.
 * Retain release-v1's installed digest format for its existing receipts. */
export function canonicalRecord(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecord).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRecord(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function identifierLiteral(identifier: { provider: string; value: string }): string {
  return JSON.stringify([identifier.provider, identifier.value]);
}

export function releaseProfileOf(record: AnyReleaseRecord): string {
  return record.profile === 'release-v2' ? RELEASE_V2_PROFILE : RELEASE_PROFILE;
}

export function releaseLanguageLiteral(record: AnyReleaseRecord): string | null {
  return languageListLiteral(record.contentLanguages);
}
