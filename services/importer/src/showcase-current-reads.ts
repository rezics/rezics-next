import { Type, type Static } from 'typebox';
import { Check } from 'typebox/schema';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import type { MediaVariantDecision, ReviewedSubjectRead } from './import-client.ts';
import { observePersonIdentity, personIdentityForSource } from './showcase-person-identity.ts';
import { sameStatementProvenance } from './statement-provenance.ts';
import { showcaseDigest, showcaseLimits, type ShowcaseRecord } from './showcase-contract.ts';

export type CandidateRank = 'normal' | 'preferred' | 'deprecated';
export type CandidateRead = {
  id: string;
  source: BatchCommand['source'] | null;
  statement: BatchStatement;
  head: number | null;
  rank?: CandidateRank | null;
  decision?: 'accepted' | 'rejected' | 'abstained' | null;
};
export type CandidatePage = {
  candidates: CandidateRead[];
  next: unknown;
  adoption: {
    head?: number | null;
    selection?: { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
  } | null;
};
export type AdoptionSnapshot = Readonly<{
  head: number;
  selection: readonly { candidate: string; rank: 'normal' | 'preferred' | 'deprecated' }[];
}>;
const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function sameAdoptionSelection(
  left: readonly { candidate: string; rank: string }[],
  right: readonly { candidate: string; rank: string }[],
): boolean {
  const sorted = (selection: readonly { candidate: string; rank: string }[]) =>
    JSON.stringify([...selection].sort((a, b) => a.candidate.localeCompare(b.candidate)));
  return sorted(left) === sorted(right);
}

/** Rebuild the live selection from candidate ranks only after the complete listing is available. */
export function currentCandidateSelection(
  candidates: readonly { id: string; rank?: CandidateRank | null }[],
): { candidate: string; rank: CandidateRank }[] {
  return candidates
    .flatMap((candidate) =>
      candidate.rank === null || candidate.rank === undefined
        ? []
        : [{ candidate: candidate.id, rank: candidate.rank }],
    )
    .sort((left, right) => left.candidate.localeCompare(right.candidate));
}

export function adoptionSnapshot(adoption: CandidatePage['adoption']): AdoptionSnapshot | null {
  return adoption && Number.isSafeInteger(adoption.head) && Array.isArray(adoption.selection)
    ? { head: adoption.head!, selection: adoption.selection }
    : null;
}

export function subjectId(read: ReviewedSubjectRead): string | null {
  const subject = read.subject as { id?: unknown } | undefined;
  return typeof subject?.id === 'string' ? subject.id : null;
}

/** Reads follow canonical identity; statement ownership and adoption stay on the sealed original. */
export function currentSourceRead(
  read: ReviewedSubjectRead,
  record: Pick<ShowcaseRecord, 'provider' | 'sourceKey' | 'subjectId' | 'nativeType'>,
): boolean {
  if (subjectType(read) !== record.nativeType) return false;
  if (subjectId(read) === record.subjectId) return true;
  const identity = personIdentityForSource(record.provider, record.sourceKey, record.nativeType ?? undefined);
  if (identity) return observePersonIdentity(identity, read).state === 'current';
  // Exact current provider facts certify native Work redirects without moving the sealed source binding.
  if (record.provider === 'bangumi' && /^[1-9][0-9]*$/u.test(record.sourceKey))
    return publicHasValue(read, 'wdt:P5732', record.sourceKey);
  if (record.provider === 'vndb' && /^v[1-9][0-9]*$/u.test(record.sourceKey))
    return publicHasValue(read, 'wdt:P3180', record.sourceKey);
  return false;
}

export function subjectType(read: ReviewedSubjectRead): string | null {
  const subject = read.subject as { type?: unknown } | undefined;
  return typeof subject?.type === 'string' ? subject.type : null;
}

export function safeCandidatePage(value: unknown): CandidatePage {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid current candidate page');
  const page = value as {
    candidates?: (CandidateRead & { deleted?: unknown })[];
    next?: unknown;
    adoption?: { mode?: unknown; head?: unknown } | null;
  };
  if (
    !Array.isArray(page.candidates) ||
    page.candidates.length > showcaseLimits.reviewPage ||
    (page.next !== null && typeof page.next !== 'string') ||
    page.candidates.some(
      (candidate) =>
        !candidate ||
        typeof candidate !== 'object' ||
        typeof candidate.id !== 'string' ||
        !nativeUuid.test(candidate.id) ||
        (candidate.deleted !== true &&
          (!candidate.statement ||
            typeof candidate.statement !== 'object' ||
            (candidate.rank !== null && !['normal', 'preferred', 'deprecated'].includes(candidate.rank as string)))),
    ) ||
    (page.adoption !== null &&
      (!page.adoption ||
        !['inherit', 'replace', 'suppress'].includes(page.adoption.mode as string) ||
        !Number.isSafeInteger(page.adoption.head) ||
        (page.adoption.head as number) < 1))
  )
    throw new TypeError('Invalid current candidate page');
  const candidates = page.candidates.filter((candidate) => candidate.deleted !== true);
  return {
    candidates,
    next: page.next,
    adoption: page.adoption
      ? {
          head: page.adoption.head as number,
          // The served page carries current ranks on candidates, not an adoption selection array.
          // A continuation cannot certify the complete selection for a replacement write.
          ...(page.next === null
            ? {
                selection: currentCandidateSelection(candidates),
              }
            : {}),
        }
      : null,
  };
}

export function statementOnPublicRead(value: unknown, expected: BatchStatement): boolean {
  return sameStatementProvenance(value, expected);
}

export function selectedSynopsisOnPublicRead(value: unknown, expected: BatchStatement, candidateId: string): boolean {
  if (expected.property.id !== 'schema:abstract' || expected.value.type !== 'value') return false;
  const authored = expected.value.content;
  if (!authored || typeof authored !== 'object' || Array.isArray(authored)) return false;
  const language = (authored as { language?: unknown }).language;
  if (typeof language !== 'string') return false;

  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.id !== candidateId || !row.property || typeof row.property !== 'object' || Array.isArray(row.property))
    return false;
  if ((row.property as { id?: unknown }).id !== 'schema:abstract') return false;
  const content =
    row.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? (row.value as { content?: unknown }).content
      : undefined;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const currentLanguage = (content as { language?: unknown }).language;
    if (typeof currentLanguage === 'string' && currentLanguage !== language) return false;
  }

  // A public document statement carries a current document locator; the authored proposal carries its snapshot.
  // The selected-slot read below validates that locator. Here, compare all remaining statement attribution exactly.
  const comparable = { type: 'value' as const, content: 'selected-synopsis-current' };
  return sameStatementProvenance({ ...row, value: comparable }, { ...expected, value: comparable });
}

/** The served-variant fields of the cover summary a public Subject read carries; Content owns the full shape. */
const ServedCoverSummary = Type.Object({
  media: Type.String({ format: 'uuid' }),
  variants: Type.Array(
    Type.Object({
      format: Type.Union([Type.Literal('avif'), Type.Literal('webp')]),
      width: Type.Integer({ minimum: 1, maximum: 2560 }),
    }),
    { minItems: 1 },
  ),
});
export type CoverVariant = Static<typeof ServedCoverSummary>['variants'][number];
export type ServedVariantReview = {
  authorizeMediaVariant?: (mediaId: string, variant: string) => Promise<MediaVariantDecision>;
};

/** The derivatives the public Subject summary names for this exact media, in width then format order. */
export function servedCoverVariants(read: ReviewedSubjectRead, mediaId: string): readonly CoverVariant[] | undefined {
  const summary: unknown = Reflect.get(read, 'summary');
  const cover: unknown = typeof summary === 'object' && summary !== null ? Reflect.get(summary, 'cover') : undefined;
  if (!Check(ServedCoverSummary, cover) || cover.media !== mediaId) return undefined;
  return [...cover.variants].sort((left, right) => left.width - right.width || left.format.localeCompare(right.format));
}

/** A Kernel decision is current for a derivative when it names that derivative's own image type and bytes. */
export function servedVariantDecisionCurrent(decision: MediaVariantDecision, variant: CoverVariant): boolean {
  return decision.allowed && decision.mediaType === `image/${variant.format}` && decision.byteCount >= 1;
}

export function publicStatements(read: ReviewedSubjectRead, property: string): readonly unknown[] {
  const subject = read.subject as { statements?: Record<string, unknown[]> } | undefined;
  return subject?.statements?.[property] ?? [];
}

export function publicHasValue(read: ReviewedSubjectRead, property: string, expected: unknown): boolean {
  return publicStatements(read, property).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = (entry as { value?: { content?: unknown } }).value;
    return showcaseDigest(value?.content) === showcaseDigest(expected);
  });
}

