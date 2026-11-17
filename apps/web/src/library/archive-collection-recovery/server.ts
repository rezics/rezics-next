import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { hasKernelOrigin, kernelClient } from '../../kernel/client';
import { prepareExpectedReader, validExpectedReader, type ExpectedReader } from '../../session/expected-reader';
import { originalEntryRestoreCredential, readArchiveSender } from '../entry-restore-credential';
import type { SessionEnv } from '../../session/client';
import {
  RECOVERY_CURSOR_CHARS,
  RECOVERY_ID,
  RECOVERY_PAGE_ROWS,
  RECOVERY_SELECTED_OCCURRENCES,
  RECOVERY_UPLOAD_BASE64_CHARS,
} from './contract';
import type {
  RecoveryApplyBody,
  RecoveryPageQuery,
  RecoveryResult,
  RecoveryReviewBody,
  RecoveryUploadBody,
} from './contract';
import { kernelArchiveCollectionRecoveryPort } from './native';
import { refreshRelease } from '../../subject/definitions';
import { readCollectionTypeOptions } from '../collection-presentation';

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
    value.archiveBase64.length > RECOVERY_UPLOAD_BASE64_CHARS ||
    value.archiveBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.archiveBase64)
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
  const presentationKind = value.presentationKind;
  if (
    presentationKind !== undefined &&
    presentationKind !== null &&
    (typeof presentationKind !== 'string' || presentationKind.length === 0 || presentationKind.length > 128)
  ) {
    throw new Error('Invalid Collection recovery request');
  }
  return {
    uploadId: requireId(value.uploadId),
    key: requireKey(value.key),
    body: {
      collectionId: requireId(value.collectionId),
      selectedOccurrenceIds,
      mappings,
      ...(presentationKind === undefined ? {} : { presentationKind }),
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

type RecoverySender = ExpectedReader & { sender?: string };

function validateCommand<T>(input: unknown, validate: (value: unknown) => T) {
  if (!validExpectedReader(input)) throw new Error('Invalid Collection recovery viewer');
  const sender = readArchiveSender(input);
  return {
    sender: {
      expectedReader: input.expectedReader,
      expectedCredential: input.expectedCredential,
      ...(sender === undefined ? {} : { sender }),
    },
    command: validate(input),
  };
}

async function forReader<T>(
  sender: RecoverySender,
  action: (port: ReturnType<typeof kernelArchiveCollectionRecoveryPort>) => Promise<RecoveryResult<T>>,
): Promise<RecoveryResult<T>> {
  setResponseHeader('cache-control', 'private, no-store');
  if (!hasKernelOrigin()) return { kind: 'unavailable' };
  const request = getRequest();
  const sessionEnv = env as Partial<SessionEnv>;
  if (!(await prepareExpectedReader(request, sessionEnv, sender))) return { kind: 'denied' };
  const authorization = await originalEntryRestoreCredential(request, sessionEnv, sender.sender).catch(() => null);
  if (!authorization) return { kind: 'denied' };
  return action(
    kernelArchiveCollectionRecoveryPort(kernelClient(), request, sessionEnv, true, async () => authorization),
  );
}

const pageQuery = (cursor?: string): RecoveryPageQuery => ({
  limit: RECOVERY_PAGE_ROWS,
  ...(cursor === undefined ? {} : { cursor }),
});

/** The same released-Type authority as the Collection editor; Native admits and seals the choice. */
export const readArchiveRecoveryPresentationTypes = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('cache-control', 'private, no-store');
  return refreshRelease().then(readCollectionTypeOptions, () => null);
});

const validateUploadId = (input: unknown) => {
  if (!object(input)) throw new Error('Invalid Collection recovery request');
  return requireId(input.uploadId);
};

function validateReceiving(input: unknown) {
  if (!object(input)) throw new Error('Invalid Collection recovery request');
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > RECOVERY_CURSOR_CHARS))
    throw new Error('Invalid Collection recovery request');
  return {
    collectionId: requireId(input.collectionId),
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
  };
}

export const uploadArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateUpload))
  .handler(({ data }) => forReader(data.sender, (port) => port.upload({ kind: 'upload', ...data.command })));

export const readArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateUploadId))
  .handler(({ data }) => forReader(data.sender, (port) => port.status(data.command)));

export const readArchiveRecoveryCollections = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validatePage))
  .handler(({ data: { sender, command } }) =>
    forReader(sender, (port) => port.collections(command.uploadId, pageQuery(command.cursor))),
  );

export const readArchiveRecoveryOccurrences = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateOccurrences))
  .handler(({ data: { sender, command } }) =>
    forReader(sender, (port) => port.occurrences(command.uploadId, command.collectionId, pageQuery(command.cursor))),
  );

export const reviewArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateReview))
  .handler(({ data }) => forReader(data.sender, (port) => port.review({ kind: 'review', ...data.command })));

export const applyArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateApply))
  .handler(({ data }) => forReader(data.sender, (port) => port.apply({ kind: 'apply', ...data.command })));

export const readArchiveCollectionRecoveryOutcomes = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validatePage))
  .handler(({ data: { sender, command } }) =>
    forReader(sender, (port) => port.outcomes(command.uploadId, pageQuery(command.cursor))),
  );

export const cancelArchiveCollectionRecovery = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateUploadId))
  .handler(({ data }) => forReader(data.sender, (port) => port.cancel({ kind: 'cancel', uploadId: data.command })));

export const readReceivingCollection = createServerFn({ method: 'POST' })
  .validator((input: unknown) => validateCommand(input, validateReceiving))
  .handler(({ data: { sender, command } }) =>
    forReader(sender, (port) => port.receivingCollection(command.collectionId, command.cursor)),
  );
