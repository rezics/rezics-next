import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { recordedLanguageTag, InvalidContentLanguages } from '../release/languages.ts';
import { canonicalRecord } from '../release/schema.ts';

export const REALIZATION_PROFILE = 'https://rezics.com/definition/realization-v1';
/** A single CAS, a bounded source check and a bounded page of retained texts. */
export const REALIZATION_COST = { parties: 16, stateBytes: 8192, page: 20,
  commandGraphCalls: 16, commandGraphBytes: 1024 * 1024, deadlineMs: 10_000 } as const;
const closed = { additionalProperties: false } as const;
export const realizationId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const realizationSource = t.Union([
  t.Object({ kind: t.Literal('realization'), work: realizationId, realization: realizationId,
    revision: realizationId }, closed),
  t.Object({ kind: t.Literal('main-version'), work: realizationId, mainVersion: realizationId,
    revision: realizationId }, closed),
  t.Object({ kind: t.Literal('unresolved'), work: realizationId }, closed),
]);
export const realizationWrite = t.Object({
  profile: t.Literal('realization-v1'), expectedHead: t.Nullable(realizationId),
  actingSubject: realizationId, id: realizationId,
  language: t.String({ minLength: 1, maxLength: 35 }),
  kind: t.Union([t.Literal('original'), t.Literal('translation')]),
  translators: t.Array(realizationId, { maxItems: REALIZATION_COST.parties }),
  publishers: t.Array(realizationId, { maxItems: REALIZATION_COST.parties }),
  source: realizationSource,
  status: t.Union([t.Literal('official'), t.Literal('unofficial')]),
  verification: t.Union([t.Literal('verified'), t.Literal('unverified')]),
  evidence: t.Nullable(t.Union([realizationId,
    t.String({ pattern: '^https://[^\\s<>"{}|\\\\^`]{1,2040}$', maxLength: 2048 })])),
}, closed);
export type RealizationWrite = Static<typeof realizationWrite>;
export interface RealizationRecord extends RealizationWrite { work: string }
export class InvalidRealization extends Error {}
export class StaleRealization extends Error {}
export class RealizationUnavailable extends Error {}

export function checkedRealization(input: unknown, work: string): RealizationRecord {
  if (!Value.Check(realizationWrite, input) || !Value.Check(realizationId, work)) {
    throw new InvalidRealization('Realization does not match its schema');
  }
  let language: string;
  try { language = recordedLanguageTag(input.language); }
  catch (error) {
    if (error instanceof InvalidContentLanguages) throw new InvalidRealization(error.message);
    throw error;
  }
  if (language === 'zxx') throw new InvalidRealization('A text realization has linguistic content');
  if (input.source.work !== work) throw new InvalidRealization('A realization keeps its source continuity Work');
  if (input.source.kind === 'realization' && input.source.realization === input.id) {
    throw new InvalidRealization('A realization cannot be its own source');
  }
  if ((input.kind === 'translation') !== (input.translators.length > 0)) {
    throw new InvalidRealization('A translation names its translators');
  }
  if ((input.status === 'official' || input.verification === 'verified') && !input.evidence) {
    throw new InvalidRealization('Official or verified provenance cites evidence');
  }
  for (const parties of [input.translators, input.publishers]) {
    if (new Set(parties).size !== parties.length) throw new InvalidRealization('Contributor Agents are distinct');
  }
  const record = { ...input, work, language, translators: [...input.translators].sort(),
    publishers: [...input.publishers].sort() };
  if (Buffer.byteLength(JSON.stringify(record)) > REALIZATION_COST.stateBytes) {
    throw new InvalidRealization('Realization exceeds its byte budget');
  }
  return record;
}

export function assertRealizationCorrection(before: RealizationRecord, after: RealizationRecord): void {
  if (before.id !== after.id || before.work !== after.work || before.kind !== after.kind
    || before.language !== after.language) {
    throw new InvalidRealization('A later text or translation is a new realization');
  }
  const facts = (record: RealizationRecord) => {
    const { expectedHead: ignoredHead, actingSubject: ignoredActor, evidence: ignoredEvidence, ...rest } = record;
    return rest;
  };
  if (JSON.stringify(facts(before)) !== JSON.stringify(facts(after)) && !after.evidence) {
    throw new InvalidRealization('A realization correction cites evidence');
  }
}

export function parseStoredRealization(raw: string, work?: string): RealizationRecord {
  try {
    const { work: stored, ...body } = JSON.parse(raw) as RealizationRecord;
    if (work && stored !== work) throw new Error('Work differs');
    return checkedRealization(body, stored);
  } catch { throw new RealizationUnavailable('Realization state is invalid'); }
}

export function realizationDigest(record: RealizationRecord): string {
  return createHash('sha256').update(canonicalRecord({ ...record, profile: REALIZATION_PROFILE })).digest('hex');
}
