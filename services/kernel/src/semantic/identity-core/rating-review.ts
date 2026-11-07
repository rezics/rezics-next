import {
  classifyIdentityMappings,
  comparableIdentityEvidence,
  type IdentityMappingEvidence,
  type IdentityMappingRequest,
} from './mapping.ts';
import type { IdentityMapping } from './values.ts';
import { serializeIdentityValue } from './encoding.ts';
import {
  IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS,
  IDENTITY_RATING_REVIEW_MAX_KEYS,
  IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES,
} from './rating-review-bounds.ts';

export {
  IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS,
  IDENTITY_RATING_REVIEW_MAX_KEYS,
  IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES,
} from './rating-review-bounds.ts';

import type {
  IdentityRatingControlLocator,
  IdentityRatingReviewOperand,
  IdentityRatingReviewUnavailableReason,
  IdentityRatingReviewResult,
} from '../contract/index.ts';
export type {
  IdentityRatingControlLocator,
  IdentityRatingReviewOperand,
  IdentityRatingReviewUnavailableReason,
  IdentityRatingReviewResult,
} from '../contract/index.ts';

export type IdentityRatingSubjectDisclosure = Readonly<{ subject_id: string; visibility: string }>;
export type IdentityRatingNativeEvidence = Readonly<{
  mapping: IdentityMappingEvidence;
  subjects: readonly IdentityRatingSubjectDisclosure[];
  controlLocators: readonly IdentityRatingControlLocator[];
}>;

function sortedEvidence(value: IdentityMappingEvidence): IdentityMappingEvidence {
  return {
    sourceOwners: [...value.sourceOwners].sort((left, right) => left.partition_no - right.partition_no),
    sourceRows: [...value.sourceRows].sort((left, right) => left.subject_id.localeCompare(right.subject_id)),
    controlOwners: [...value.controlOwners].sort((left, right) => left.partition_no - right.partition_no),
    pendingRows: [...value.pendingRows].sort(
      (left, right) => left.partition_no - right.partition_no || left.terminal.localeCompare(right.terminal),
    ),
    currentRows: [...value.currentRows].sort(
      (left, right) =>
        left.partition_no - right.partition_no ||
        left.terminal.localeCompare(right.terminal) ||
        left.requested_original.localeCompare(right.requested_original),
    ),
  };
}

function sortSubjects(rows: readonly IdentityRatingSubjectDisclosure[]): IdentityRatingSubjectDisclosure[] {
  return [...rows].sort((left, right) => left.subject_id.localeCompare(right.subject_id));
}

export function identityRatingReviewEvidence(value: IdentityRatingNativeEvidence): string {
  return serializeIdentityValue({
    mapping: comparableIdentityEvidence(sortedEvidence(value.mapping)),
    subjects: sortSubjects(value.subjects),
  });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Classifies acquired mapping and disclosure evidence; never acquires facts or native authority. */
export function classifyIdentityRatingReviewEvidence(
  requestedOriginalId: string,
  canonicalTerminalId: string,
  sourceIdentities: readonly string[],
  sourceHomes: readonly number[],
  evidence: IdentityRatingNativeEvidence,
  mappingRequests: readonly IdentityMappingRequest[],
): IdentityRatingReviewResult {
  const evidenceSourceIds = evidence.mapping.sourceRows.map((row) => row.subject_id);
  if (
    new Set(evidenceSourceIds).size !== evidenceSourceIds.length ||
    new Set(evidence.subjects.map((row) => row.subject_id)).size !== evidence.subjects.length ||
    new Set(evidence.mapping.sourceOwners.map((row) => row.partition_no)).size !==
      evidence.mapping.sourceOwners.length ||
    new Set(evidence.mapping.controlOwners.map((row) => row.partition_no)).size !==
      evidence.mapping.controlOwners.length ||
    new Set(evidence.mapping.pendingRows.map((row) => `${row.partition_no}:${row.terminal}`)).size !==
      evidence.mapping.pendingRows.length ||
    new Set(evidence.mapping.currentRows.map((row) => `${row.partition_no}:${row.terminal}:${row.requested_original}`))
      .size !== evidence.mapping.currentRows.length
  )
    return { state: 'unavailable', reason: 'bootstrap' };
  if (evidence.subjects.some((row) => row.visibility !== 'visible')) return { state: 'undisclosed' };
  if (evidence.subjects.length !== sourceIdentities.length) return { state: 'absent' };
  if (evidence.mapping.currentRows.some((row) => row.redirected))
    return { state: 'unavailable', reason: 'redirect-chain' };

  const mapped = classifyIdentityMappings(mappingRequests, evidence.mapping);
  const pendingMapping = mapped.find(
    (row): row is Extract<IdentityMapping, { state: 'pending' }> => row.state === 'pending',
  );
  if (pendingMapping)
    return { state: 'pending', jobId: pendingMapping.job.jobId, epoch: pendingMapping.job.epoch.toString() };
  const unavailableMapping = mapped.find(
    (row): row is Extract<IdentityMapping, { state: 'unavailable' }> => row.state === 'unavailable',
  );
  if (unavailableMapping?.reason === 'moved-owner') {
    const owner = [...evidence.mapping.sourceOwners, ...evidence.mapping.controlOwners].find(
      (row) => row.write_state === 'moved',
    );
    const home = owner?.partition_no ?? sourceHomes[0]!;
    return { state: 'moved', home };
  }
  if (unavailableMapping)
    return {
      state: 'unavailable',
      reason: unavailableMapping.reason === 'missing-owner' ? 'missing-owner' : 'bootstrap',
    };
  if (mapped.some((row) => row.state === 'absent')) return { state: 'absent' };

  const requested = mapped.find(
    (row): row is Extract<IdentityMapping, { state: 'mapped' }> =>
      row.state === 'mapped' && row.original === requestedOriginalId,
  );
  const canonical = mapped.find(
    (row): row is Extract<IdentityMapping, { state: 'mapped' }> =>
      row.state === 'mapped' && row.original === canonicalTerminalId,
  );
  if (!requested || !canonical) return { state: 'absent' };
  if (requested.terminal !== canonicalTerminalId || canonical.terminal !== canonicalTerminalId)
    return {
      state: 'changed',
      canonicalTerminalId: requested.terminal !== canonicalTerminalId ? requested.terminal : canonical.terminal,
    };
  if (evidence.controlLocators.length > IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS)
    return { state: 'unavailable', reason: 'control-limit' };
  if (!evidence.controlLocators.length) return { state: 'unavailable', reason: 'bootstrap' };

  const operand: IdentityRatingReviewOperand = Object.freeze({
    version: 1,
    requestedOriginalId,
    canonicalTerminalId,
    sourceIdentities: Object.freeze([...sourceIdentities]),
    sourceHomes: Object.freeze([...sourceHomes]),
    controlLocators: Object.freeze(
      evidence.controlLocators.map((row) => Object.freeze({ partition: row.partition, group: row.group })),
    ),
    evidence: identityRatingReviewEvidence(evidence),
  });
  if (utf8Bytes(serializeIdentityValue(operand)) > IDENTITY_RATING_REVIEW_MAX_OPERAND_BYTES)
    return { state: 'unavailable', reason: 'operand-too-large' };
  return { state: 'reviewed', operand };
}
