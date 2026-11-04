import { isDeepStrictEqual } from 'node:util';
import { bangumiPublicTagScheme, reviewedReferenceKey } from '../../../packages/conversion/src/support.ts';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { createReviewedCatalogueLookup, inspectReviewedBangumiBinding } from './reviewed-catalogue.ts';
import type { ReviewedCataloguePort } from './reviewed-catalogue.ts';
import { reviewedCatalogueSource } from './reviewed-catalogue.ts';
import type { RecordBindings } from './record-bindings.ts';
import type { ImportIdentifierLookup, ImportIdentifierResolution } from './importer.ts';
import { ImportTransportError, type ReviewedCandidatePage } from './import-client.ts';
import { createSourceRegistration } from './source-registry.ts';
import type { ShowcaseAcknowledgement, ShowcaseAssertion, ShowcaseVocabularyRecord } from './showcase-manifest.ts';
import { showcaseDigest } from './showcase-manifest.ts';

const HAREM_EDITOR_TAG = '后宫';
const globalContext = '00000000-0000-8000-8000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const bindingKeys = new Set(['source-scheme', 'source-harem', 'canonical-scheme', 'canonical-harem']);
type CurrentReviewedCandidate = Extract<ReviewedCandidatePage['candidates'][number], { statement: unknown }>;

export type BangumiGenreDiagnostic = Readonly<{
  sourceKey: string;
  code: 'reviewed-binding-unavailable' | 'reviewed-binding-withdrawn' | 'source-claim-unavailable';
}>;

export type BangumiGenrePublication = Readonly<{
  acknowledgements: readonly ShowcaseAcknowledgement[];
  candidateIds: readonly string[];
  ownerKeys: readonly string[];
  vocabulary: readonly ShowcaseVocabularyRecord[];
  diagnostics: readonly BangumiGenreDiagnostic[];
}>;

type BangumiSourceRecord = Readonly<{ key: string; revision: string | null; payload: Record<string, unknown> }>;

function hasReviewedTag(record: BangumiSourceRecord): boolean {
  const tags = record.payload.meta_tags;
  return Array.isArray(tags) && tags.includes(HAREM_EDITOR_TAG);
}

function citations(statement: ShowcaseAssertion['statement']): string[] {
  const result = new Set<string>();
  for (const reference of statement.references ?? [])
    for (const part of reference.parts)
      if (part.property.id === 'schema:url' && part.value.type === 'value' && typeof part.value.content === 'string')
        result.add(part.value.content);
  return [...result].sort();
}

function assertion(candidateId: string, command: Extract<BatchCommand, { op: 'propose' }>): ShowcaseAssertion {
  return {
    commandKey: command.key,
    candidateId,
    candidateDigest: showcaseDigest({ source: command.source, statement: command.statement }),
    property: command.statement.property.id,
    source: command.source,
    statement: command.statement,
    citations: citations(command.statement),
  };
}

function toVocabularyRecords(
  evidence: Awaited<ReturnType<typeof inspectReviewedBangumiBinding>> & { state: 'bound' },
): { records: ShowcaseVocabularyRecord[]; acknowledgements: ShowcaseAcknowledgement[] } {
  const schemes = new Map(evidence.evidence.vocabulary.map((row) => [row.key, row.subjectId]));
  const records = evidence.evidence.vocabulary
    .filter((row) => bindingKeys.has(row.key))
    .map((row) => ({
      provider: 'bangumi' as const,
      sourceAlias: reviewedCatalogueSource,
      sourceKey: row.owner.external_id,
      sourceUri: row.sourceUri,
      subjectId: row.subjectId,
      nativeType: row.nativeType,
      schemeId: row.schemeKey ? (schemes.get(row.schemeKey) ?? null) : null,
      schemeUri: row.schemeURI,
      provenance: 'reviewed-catalogue' as const,
      assertions: row.facts.map((fact) => assertion(fact.candidateId, fact.command)),
    }));
  const acknowledgements = evidence.evidence.vocabulary
    .filter((row) => bindingKeys.has(row.key))
    .flatMap((row) =>
      row.facts.map(({ candidateId, command }) => ({
        command,
        subjectId: row.subjectId,
        candidateId,
        commandDigest: showcaseDigest(command),
      })),
    );
  return { records, acknowledgements };
}

/** Adapts only the trusted cross-media registration alias to the existing Bangumi lookup. */
export function createShowcaseBangumiGenreLookup(
  sourceAlias: string,
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>,
  port: ReviewedCataloguePort,
) {
  const reviewedLookup = createReviewedCatalogueLookup(bindings, port, { preserveKeywordOnUnavailable: true });
  const diagnostics = new Map<string, BangumiGenreDiagnostic>();
  const reference = reviewedReferenceKey(bangumiPublicTagScheme, HAREM_EDITOR_TAG);
  const lookup: ImportIdentifierLookup = {
    async resolve({ owner, conversion, signal }) {
      if (owner.source !== sourceAlias || conversion.source !== sourceAlias) return {};
      const record = conversion.normalized as { meta_tags?: unknown };
      if (!Array.isArray(record.meta_tags) || !record.meta_tags.includes(HAREM_EDITOR_TAG)) return {};
      const adapted = { ...conversion, source: 'bangumi' } as typeof conversion;
      const result: ImportIdentifierResolution = await reviewedLookup.resolve({
        owner,
        conversion: adapted,
        signal,
      });
      if ('status' in result && result.status === 'unavailable') {
        diagnostics.set(owner.external_id, { sourceKey: owner.external_id, code: 'reviewed-binding-unavailable' });
      } else if (Object.hasOwn(result, reference)) diagnostics.delete(owner.external_id);
      else diagnostics.set(owner.external_id, { sourceKey: owner.external_id, code: 'reviewed-binding-withdrawn' });
      return result;
    },
  };
  return {
    lookup,
    diagnostics: () => [...diagnostics.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)).slice(0, 256),
  };
}

/** Compose only current tagged proposals and the finite reviewed inventory's exact journal candidates. */
export async function prepareShowcaseBangumiGenres(input: {
  sourceAlias: string;
  records: readonly BangumiSourceRecord[];
  bindings: Pick<RecordBindings, 'claim' | 'candidates'>;
  port: ReviewedCataloguePort;
  lookupDiagnostics: readonly BangumiGenreDiagnostic[];
}): Promise<BangumiGenrePublication> {
  const tagged = input.records.filter(hasReviewedTag);
  const diagnostics = new Map(input.lookupDiagnostics.map((item) => [item.sourceKey, item]));
  if (!tagged.length)
    return { acknowledgements: [], candidateIds: [], ownerKeys: [], vocabulary: [], diagnostics: [...diagnostics.values()] };

  const current = await inspectReviewedBangumiBinding(input.bindings, input.port);
  if (current.state !== 'bound') {
    const code = current.state === 'unavailable' ? 'reviewed-binding-unavailable' : 'reviewed-binding-withdrawn';
    for (const row of tagged) diagnostics.set(row.key, { sourceKey: row.key, code });
    return {
      acknowledgements: [],
      candidateIds: [],
      ownerKeys: tagged.map((row) => row.key),
      vocabulary: [],
      diagnostics: [...diagnostics.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)).slice(0, 256),
    };
  }

  const reference = reviewedReferenceKey(bangumiPublicTagScheme, HAREM_EDITOR_TAG);
  const registration = createSourceRegistration('bangumi', {
    source: input.sourceAlias,
    converterRevision: entityRevision,
  });
  const acknowledgements: ShowcaseAcknowledgement[] = [];
  for (const row of tagged) {
    const owner = { source: input.sourceAlias, external_id: row.key };
    const claim = input.bindings.claim(owner);
    if (claim?.state !== 'bound' || !uuid.test(claim.subject)) {
      diagnostics.set(row.key, { sourceKey: row.key, code: 'source-claim-unavailable' });
      continue;
    }
    const conversion = registration.convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      {
        source: input.sourceAlias,
        subjectId: claim.subject,
        resolvedReferences: { [reference]: current.evidence.binding.sourceConcept },
      },
    );
    const proposals = conversion.proposals.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' &&
        command.subject === claim.subject &&
        command.statement.property.id === 'schema:keywords' &&
        command.statement.value.type === 'value' &&
        command.statement.value.content === current.evidence.binding.sourceConcept,
    );
    for (const proposal of proposals) {
      const local = input.bindings.candidates(owner, 'facts', { limit: 100 });
      const exact = local.flatMap((candidate) => {
        if (candidate.subject !== claim.subject) return [];
        try {
          const command = (JSON.parse(candidate.bytes) as { commands?: BatchCommand[] }).commands?.[0];
          return command?.op === 'propose' &&
            command.source.source === proposal.source.source &&
            command.source.external_id === proposal.source.external_id &&
            isDeepStrictEqual(command.source, proposal.source) &&
            isDeepStrictEqual(command.statement, proposal.statement)
            ? [{ candidate, command }]
            : [];
        } catch {
          return [];
        }
      });
      if (!exact.length) continue;
      let page: ReviewedCandidatePage;
      try {
        page = await input.port.reviewedCandidates(
          claim.subject,
          { property: 'schema:keywords', target: current.evidence.binding.sourceConcept, context: globalContext, limit: 100 },
        );
      } catch (error) {
        if (error instanceof ImportTransportError || error instanceof TypeError) {
          diagnostics.set(row.key, { sourceKey: row.key, code: 'reviewed-binding-unavailable' });
          continue;
        }
        throw error;
      }
      if (page.next !== null) {
        diagnostics.set(row.key, { sourceKey: row.key, code: 'reviewed-binding-unavailable' });
        continue;
      }
      const live = page.candidates.filter(
        (candidate): candidate is CurrentReviewedCandidate =>
          'statement' in candidate &&
          exact.some((entry) => entry.candidate.candidate === candidate.id) &&
          isDeepStrictEqual(candidate.source, proposal.source) &&
          isDeepStrictEqual(candidate.statement, proposal.statement) &&
          candidate.retracted === null &&
          candidate.retraction === null &&
          candidate.decision !== 'rejected' &&
          candidate.rank !== 'deprecated',
      );
      if (live.length !== 1) continue;
      const owned = exact.find((entry) => entry.candidate.candidate === live[0]!.id)!;
      acknowledgements.push({
        command: owned.command,
        subjectId: claim.subject,
        candidateId: live[0]!.id,
        commandDigest: showcaseDigest(owned.command),
      });
      diagnostics.delete(row.key);
    }
    if (!acknowledgements.some((ack) => ack.command.source.external_id === row.key))
      diagnostics.set(row.key, { sourceKey: row.key, code: 'source-claim-unavailable' });
  }

  const candidateIds = [...new Set(acknowledgements.map((ack) => ack.candidateId!).filter(Boolean))].sort();
  const catalogue = toVocabularyRecords(current);
  return {
    acknowledgements: [...catalogue.acknowledgements, ...acknowledgements],
    candidateIds,
    ownerKeys: tagged.map((row) => row.key),
    vocabulary: candidateIds.length ? catalogue.records : [],
    diagnostics: [...diagnostics.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)).slice(0, 256),
  };
}
