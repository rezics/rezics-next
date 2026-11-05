import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  RECOVERY_CURSOR_CHARS,
  RECOVERY_ID,
  RECOVERY_PAGE_ROWS,
  RECOVERY_SELECTED_OCCURRENCES,
  RECOVERY_UPLOAD_BASE64_CHARS,
} from './contract';
import type { RecoveryApplyBody, RecoveryPageQuery, RecoveryReviewBody, RecoveryUploadBody } from './contract';
import { kernelArchiveCollectionRecoveryPort } from './native';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !RECOVERY_ID.test(value)) throw new Error('Invalid Collection recovery request');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) {
    throw new Error('Invalid Collection recovery request');
  }
  return value;
}

function validateUpload(value: unknown): { key: string; body: RecoveryUploadBody } {
  if (
    !object(value) ||
    typeof value.archiveBase64 !== 'string' ||
    value.archiveBase64.length > RECOVERY_UPLOAD_BASE64_CHARS
  )
    throw new Error('Invalid Collection recovery request');
  return {
    key: requireKey(value.key),
    body: { archiveBase64: value.archiveBase64 },
  };
}

function validatePage(value: unknown): { uploadId: string; cursor?: string } {
  if (!object(value)) throw new Error('Invalid Collection recovery request');
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > RECOVERY_CURSOR_CHARS))
    throw new Error('Invalid Collection recovery request');
  return {
    uploadId: requireId(value.uploadId),
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  };
}

function validateOccurrences(value: unknown): { uploadId: string; collectionId: string; cursor?: string } {
  if (!object(value)) throw new Error('Invalid Collection recovery request');
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > RECOVERY_CURSOR_CHARS))
    throw new Error('Invalid Collection recovery request');
  return {
    uploadId: requireId(value.uploadId),
    collectionId: requireId(value.collectionId),
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  };
}

function validateReview(value: unknown): {
  uploadId: string;
  key: string;
  body: RecoveryReviewBody;
} {
  if (!object(value) || !Array.isArray(value.selectedOccurrenceIds) || !Array.isArray(value.mappings)) {
    throw new Error('Invalid Collection recovery request');
  }
  if (
    value.selectedOccurrenceIds.length > RECOVERY_SELECTED_OCCURRENCES ||
    value.mappings.length > RECOVERY_SELECTED_OCCURRENCES
  ) {
    throw new Error('Invalid Collection recovery request');
  }
  const selectedOccurrenceIds = value.selectedOccurrenceIds.map(requireId);
  if (new Set(selectedOccurrenceIds).size !== selectedOccurrenceIds.length) {
    throw new Error('Invalid Collection recovery request');
  }
  const mappings = value.mappings.map((mapping) => {
    if (!object(mapping)) throw new Error('Invalid Collection recovery request');
    return {
      sourceSubjectId: requireId(mapping.sourceSubjectId),
      targetSubjectId: mapping.targetSubjectId === null ? null : requireId(mapping.targetSubjectId),
    };
  });
  if (new Set(mappings.map((mapping) => mapping.sourceSubjectId)).size !== mappings.length) {
    throw new Error('Invalid Collection recovery request');
  }
  return {
    uploadId: requireId(value.uploadId),
    key: requireKey(value.key),
    body: {
      collectionId: requireId(value.collectionId),
      selectedOccurrenceIds,
      mappings,
    },
  };
}

function validateApply(value: unknown): { uploadId: string; body: RecoveryApplyBody } {
  if (!object(value) || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) {
    throw new Error('Invalid Collection recovery request');
  }
  return {
    uploadId: requireId(value.uploadId),
    body: { reviewId: requireId(value.reviewId), digest: value.digest },
  };
}

function port() {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelArchiveCollectionRecoveryPort(
    kernelClient(),
    getRequest(),
    env as Partial<SessionEnv>,
    Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN),
  );
}

const pageQuery = (cursor?: string): RecoveryPageQuery => ({
  limit: RECOVERY_PAGE_ROWS,
  ...(cursor ? { cursor } : {}),
});

export const uploadArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateUpload(input))
  .handler(({ data }) => port().upload({ kind: 'upload', ...data }));

export const readArchiveCollectionRecovery = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!object(input)) throw new Error('Invalid Collection recovery request');
    return { uploadId: requireId(input.uploadId) };
  })
  .handler(({ data }) => port().status(data.uploadId));

export const readArchiveRecoveryCollections = createServerFn({ method: 'GET' })
  .validator(validatePage)
  .handler(({ data }) => port().collections(data.uploadId, pageQuery(data.cursor)));

export const readArchiveRecoveryOccurrences = createServerFn({ method: 'GET' })
  .validator(validateOccurrences)
  .handler(({ data }) => port().occurrences(data.uploadId, data.collectionId, pageQuery(data.cursor)));

export const reviewArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateReview(input))
  .handler(({ data }) => port().review({ kind: 'review', uploadId: data.uploadId, key: data.key, body: data.body }));

export const applyArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator(validateApply)
  .handler(({ data }) => port().apply({ kind: 'apply', uploadId: data.uploadId, body: data.body }));

export const readArchiveCollectionRecoveryOutcomes = createServerFn({ method: 'GET' })
  .validator(validatePage)
  .handler(({ data }) => port().outcomes(data.uploadId, pageQuery(data.cursor)));

export const cancelArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!object(input)) throw new Error('Invalid Collection recovery request');
    return { uploadId: requireId(input.uploadId) };
  })
  .handler(({ data }) => port().cancel({ kind: 'cancel', uploadId: data.uploadId }));
