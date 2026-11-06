import type { CrossMediaPlan, CrossMediaReading, CrossMediaSelection } from './cross-media-seed.ts';
import { graphEdgeKey, type GraphEdgeEvidence } from './cross-media-bindings.ts';
import type { ShowcaseAcknowledgement, ShowcaseAssertion, ShowcaseOmission } from './showcase-manifest.ts';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { bangumiVocabularyRevision } from '@rezics/conversion/bangumi-vocabulary';
import type { ShowcaseReviewPort } from './showcase-publication.ts';

/** Exact additional members observed in the pinned Archive, not a title-based franchise expansion. */
export const showcaseFranchiseMembers = Object.freeze({
  // 3154: Game; 129807: television sequel; 247445: side-story book. 84148 stays the manga series.
  bangumi: [3154, 129807, 247445] as const,
  // Preserve the actual v2002 -> v17102 side endpoint for the existing VNDB relation owner.
  vndb: ['v17102'] as const,
});

/** Called inside the existing local seed only; its persona keeps the original five collection roots. */
export function showcaseFranchiseSelection(roots: CrossMediaSelection): CrossMediaSelection {
  if (!roots.bangumi.includes(10380) || !roots.bangumi.includes(84148) || !roots.vndb.includes('v2002')) return roots;
  return {
    ...roots,
    bangumi: [...new Set([...roots.bangumi, ...showcaseFranchiseMembers.bangumi])],
    vndb: [...new Set([...roots.vndb, ...showcaseFranchiseMembers.vndb])],
  };
}

function envelopeKey(source: ShowcaseAcknowledgement['command']['source']): string {
  return [
    source.source,
    source.external_id,
    source.record_revision,
    source.digest,
    source.converter_revision,
    source.field_group,
  ].join('\0');
}

type Target = NonNullable<ShowcaseAssertion['graphTarget']>;

/** Reopen must observe today's source authority even when the graph command was already acknowledged. */
export async function showcaseFranchiseFence(
  review: Pick<ShowcaseReviewPort, 'fence'>,
  source: string,
  endpoints: readonly string[],
): Promise<'open' | 'fenced' | 'unavailable'> {
  if (!review.fence) return 'unavailable';
  for (const externalId of new Set(endpoints)) {
    if ((await review.fence({ source, externalId, fieldGroup: 'facts' })).fenced) return 'fenced';
  }
  return 'open';
}

/**
 * Compose the graph owner's result, never remap or publish a second graph. Acknowledgement alone is insufficient:
 * the exact current source row and both independently returned native endpoint identities must still agree.
 */
export function showcaseFranchiseAssertions(input: {
  plan: CrossMediaPlan;
  evidence: readonly GraphEdgeEvidence[];
  readings: readonly CrossMediaReading[];
  acknowledgements: readonly ShowcaseAcknowledgement[];
}): { targets: Map<string, Target>; envelopes: Set<string>; omissions: ShowcaseOmission[] } {
  const targets = new Map<string, Target>();
  const envelopes = new Set<string>();
  const omissions: ShowcaseOmission[] = [];
  const selected = new Set([...input.plan.records.bangumi, ...input.plan.entities.bangumi].map((row) => row.key));
  const reads = new Map(input.readings.filter((row) => row.source === 'bangumi').map((row) => [row.externalId, row]));
  const results = new Map(input.evidence.map((row) => [graphEdgeKey(row.draft), row]));
  const acknowledged = new Map(input.acknowledgements.map((row) => [row.command.key, row]));

  for (const draft of input.plan.edges) {
    if (!draft.relation) continue;
    const relation = draft.relation;
    // Every current relation envelope is gated, including rows whose delivery has no result yet.
    for (const externalId of [relation.sourceSubject, relation.sourceEndpoint])
      envelopes.add(
        envelopeKey({
          source: draft.alias,
          external_id: externalId,
          record_revision: 'unversioned',
          converter_revision: `${bangumiVocabularyRevision}:relation-${relation.family}@2:${relation.code}:${relation.reciprocalCode ?? 'one-sided'}`,
          digest: sourceDigest(relation.evidence),
          field_group: 'facts',
        }),
      );
    const result = results.get(graphEdgeKey(draft));
    const command = result?.command;
    const ack = command && acknowledged.get(command.key);
    if (
      result?.status !== 'proposed' ||
      command?.op !== 'propose' ||
      !ack ||
      result.candidate !== ack.candidateId ||
      sourceDigest(command) !== sourceDigest(ack.command)
    ) {
      omissions.push({ provider: 'bangumi', sourceKey: draft.holder, code: 'candidate-ack-missing' });
      continue;
    }
    const ownerKey = command.source.external_id;
    const targetKey = ownerKey === relation.sourceSubject ? relation.sourceEndpoint : relation.sourceSubject;
    const ownerReading = reads.get(ownerKey);
    const targetReading = reads.get(targetKey);
    const owner = ownerReading?.subject.subject;
    const target = targetReading?.subject.subject;
    if (!selected.has(ownerKey) || !selected.has(targetKey) || !owner || !target) {
      omissions.push({ provider: 'bangumi', sourceKey: ownerKey, code: 'graph-endpoint-unavailable' });
      continue;
    }
    const ownerId = ownerReading?.boundSubjectId ?? owner.id;
    const targetId = targetReading?.boundSubjectId ?? target.id;
    if (
      (ownerKey !== relation.sourceSubject && ownerKey !== relation.sourceEndpoint) ||
      command.source.source !== draft.alias ||
      command.subject !== ownerId ||
      command.statement.property.id !== draft.property ||
      command.statement.value.type !== 'value' ||
      command.statement.value.content !== targetId ||
      ownerId === targetId ||
      owner.id === target.id
    ) {
      omissions.push({ provider: 'bangumi', sourceKey: ownerKey, code: 'graph-endpoint-mismatch' });
      continue;
    }
    targets.set(command.key, {
      provider: 'bangumi',
      sourceKey: targetKey,
      subjectId: targetId,
      nativeType: target.type,
      factsFence: true,
    });
  }
  return { targets, envelopes, omissions };
}
