import { ProblemError } from '../http/problem-error.ts';
import {
  HOSTED_READING_POSITION_BLOCK_MAX,
  HOSTED_READING_POSITION_OFFSET_MAX,
  type HostedReadingAddress,
  type HostedReadingClearInput,
  type HostedReadingDocumentPosition,
  type HostedReadingSaveInput,
} from './contract/hosted-reading.ts';

const MAX_REVISION = 9_223_372_036_854_775_807n;
export const HOSTED_READING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type HostedReadingRow = Readonly<{
  catalogue_id: string;
  publication_revision_id: string;
  occurrence_id: string;
  target_revision_id: string;
  target_sha256: string;
  document_block_id: string | null;
  document_offset: number | null;
  revision: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hostedReadingUuid(value: unknown): value is string {
  return typeof value === 'string' && HOSTED_READING_UUID.test(value);
}

export function hostedReadingPositionFromRow(
  blockId: string | null,
  offset: number | null,
): HostedReadingDocumentPosition | null {
  if (blockId === null && offset === null) return null;
  if (blockId === null || offset === null) throw new TypeError('Hosted reading position columns are unpaired');
  return { blockId, offset };
}

export function addressFromRow(row: HostedReadingRow): HostedReadingAddress {
  return {
    catalogueId: row.catalogue_id,
    publicationRevisionId: row.publication_revision_id,
    occurrenceId: row.occurrence_id,
    targetRevisionId: row.target_revision_id,
    targetSha256: row.target_sha256,
    documentPosition: hostedReadingPositionFromRow(row.document_block_id, row.document_offset),
  };
}

export function parseHostedReadingPosition(value: unknown): HostedReadingDocumentPosition | null {
  if (value === null || value === undefined) return null;
  if (!record(value)) throw new ProblemError('invalid_request');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('blockId') || !keys.includes('offset'))
    throw new ProblemError('invalid_request');
  if (
    typeof value.blockId !== 'string' ||
    value.blockId.length < 1 ||
    value.blockId.length > HOSTED_READING_POSITION_BLOCK_MAX ||
    !value.blockId.isWellFormed() ||
    /[\u0000-\u001f\u007f]/.test(value.blockId) ||
    !Number.isInteger(value.offset) ||
    (value.offset as number) < 0 ||
    (value.offset as number) > HOSTED_READING_POSITION_OFFSET_MAX
  )
    throw new ProblemError('invalid_request');
  return { blockId: value.blockId, offset: value.offset as number };
}

export function validateHostedReadingSave(value: unknown): HostedReadingSaveInput {
  if (!record(value)) throw new ProblemError('invalid_request');
  const keys = Object.keys(value);
  const allowed = [
    'subjectId',
    'catalogueId',
    'publicationRevisionId',
    'occurrenceId',
    'targetRevisionId',
    'targetSha256',
    'documentPosition',
    'expectedRevision',
  ];
  if (keys.some((key) => !allowed.includes(key)) || keys.length < 7 || keys.length > 8)
    throw new ProblemError('invalid_request');
  if (
    !hostedReadingUuid(value.subjectId) ||
    !hostedReadingUuid(value.catalogueId) ||
    !hostedReadingUuid(value.publicationRevisionId) ||
    !hostedReadingUuid(value.occurrenceId) ||
    !hostedReadingUuid(value.targetRevisionId) ||
    typeof value.targetSha256 !== 'string' ||
    !DIGEST.test(value.targetSha256) ||
    (value.expectedRevision !== null &&
      (typeof value.expectedRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.expectedRevision)))
  )
    throw new ProblemError('invalid_request');
  if (value.expectedRevision !== null && BigInt(value.expectedRevision as string) > MAX_REVISION)
    throw new ProblemError('invalid_request');
  return {
    subjectId: value.subjectId,
    catalogueId: value.catalogueId,
    publicationRevisionId: value.publicationRevisionId,
    occurrenceId: value.occurrenceId,
    targetRevisionId: value.targetRevisionId,
    targetSha256: value.targetSha256,
    documentPosition: parseHostedReadingPosition(value.documentPosition ?? null),
    expectedRevision: value.expectedRevision as string | null,
  };
}

export function validateHostedReadingClear(value: unknown): HostedReadingClearInput {
  if (!record(value)) throw new ProblemError('invalid_request');
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !hostedReadingUuid(value.subjectId) ||
    typeof value.expectedRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.expectedRevision)
  )
    throw new ProblemError('invalid_request');
  if (BigInt(value.expectedRevision) > MAX_REVISION) throw new ProblemError('invalid_request');
  return { subjectId: value.subjectId, expectedRevision: value.expectedRevision };
}
