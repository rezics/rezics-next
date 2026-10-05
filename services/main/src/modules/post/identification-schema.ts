import { t } from 'elysia';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { readId, readLanguage } from '../work/read-contract.ts';
import { hash } from '../work/activate.ts';

const closed = { additionalProperties: false } as const;
const text = (maximum: number) => t.String({ minLength: 1, maxLength: maximum,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
export const identificationEvidence = t.Object({ kind: t.Union([
  t.Literal('separate-authorship'), t.Literal('standalone-title'), t.Literal('separate-translation'),
  t.Literal('separate-publication'), t.Literal('independent-citation')]),
  source: t.Optional(t.Union([
    t.Object({ kind: t.Literal('url'), value: t.String({ maxLength: 2048,
      pattern: '^https?://[^\\s<>"{}|\\\\^`]+$' }) }, closed),
    t.Object({ kind: t.Literal('citation'), value: text(2048) }, closed),
  ])) }, closed);
export const identificationInput = t.Object({ profile: t.Literal('post-identification-v1'),
  /** Select an exact use: a reused Post must never silently select one Book. */
  placement: t.Object({ book: readId, occurrence: readId }, closed),
  evidence: identificationEvidence,
  work: t.Union([
    t.Object({ kind: t.Literal('existing'), id: readId }, closed),
    t.Object({ kind: t.Literal('new'), type: t.Literal('https://schema.org/Book'),
      titles: t.Array(t.Object({ language: readLanguage, value: text(200) }, closed),
        { minItems: 1, maxItems: 20 }) }, closed),
  ]), actingSubject: readId }, closed);
export type IdentificationInput = Static<typeof identificationInput>;
export class InvalidPostIdentification extends Error {}
export class PostIdentificationConflict extends Error {}
export class PostIdentificationUnavailable extends Error {}

/** Fixed fan-out. Structure's own page/write contract bounds its one insertion.
 * Caller tokens identify intent, rather than inferring duplicates from content:
 * https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/ */
export const POST_IDENTIFICATION_COST = { ownerCommands: 8, placements: 1,
  relationParticipants: 2, titles: 20, page: 20, scan: 100 } as const;

export function checkedIdentification(input: unknown): IdentificationInput {
  if (!Value.Check(identificationInput, input)) throw new InvalidPostIdentification('Invalid identification intent');
  if (input.work.kind === 'new' && new Set(input.work.titles.map(title => title.language.toLowerCase())).size
    !== input.work.titles.length) throw new InvalidPostIdentification('Title languages must be unique');
  return input;
}
export function identificationDigest(post: string, input: IdentificationInput) {
  return hash(JSON.stringify({ post, profile: input.profile, placement: input.placement,
    evidence: { kind: input.evidence.kind, source: input.evidence.source ?? null },
    work: input.work.kind === 'existing' ? input.work : { kind: 'new', type: input.work.type,
      titles: [...input.work.titles].sort((a, b) => a.language.localeCompare(b.language)) },
    actingSubject: input.actingSubject }));
}

/** The relation's retained evidence URL resolves to this same paged read. */
export function identificationEvidenceLink(post: string, operation: string, evidence: IdentificationInput['evidence']) {
  const url = new URL(`https://rezics.com/v1/posts/${post.slice(-36)}/identifications`);
  url.searchParams.set('operation', operation);
  url.searchParams.set('kind', evidence.kind);
  if (evidence.source) {
    url.searchParams.set('sourceKind', evidence.source.kind);
    url.searchParams.set('source', evidence.source.value);
  }
  if (url.href.length > 2040) throw new InvalidPostIdentification('Evidence exceeds the relation URL budget');
  return url.href;
}
