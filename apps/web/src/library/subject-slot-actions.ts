import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  loadSubjectLibraryCollections,
  libraryEntryStatesWrite,
  type LibraryEntryStateWrite,
  type SubjectLibraryMutation,
  type SubjectLibraryMutationResponse,
} from './subject-slot';
import { applySubjectLibraryMutation } from './subject-slot-mutation';
import { restorePersonalLibraryEntry, type LibraryRestoreInput } from './entries-read';

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const incarnationIdPattern = idempotencyKeyPattern;
const writableEntryStates = new Set<LibraryEntryStateWrite>(libraryEntryStatesWrite);

function validateMutation(input: unknown): SubjectLibraryMutation {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !('subjectId' in input) ||
    typeof input.subjectId !== 'string' ||
    !input.subjectId ||
    input.subjectId.length > 128 ||
    !('intent' in input) ||
    (input.intent !== 'entry' && input.intent !== 'member') ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !idempotencyKeyPattern.test(input.idempotencyKey)
  )
    throw new Error('Invalid subject library action');
  if ('action' in input && input.action !== undefined && input.action !== 'save' && input.action !== 'clear')
    throw new Error('Invalid subject library action');
  if (
    'state' in input &&
    input.state !== undefined &&
    (typeof input.state !== 'string' || !writableEntryStates.has(input.state as LibraryEntryStateWrite))
  )
    throw new Error('Invalid subject library action');
  if (
    'revision' in input &&
    input.revision !== undefined &&
    (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1)
  )
    throw new Error('Invalid subject library action');
  if (
    'incarnationId' in input &&
    input.incarnationId !== undefined &&
    input.incarnationId !== null &&
    (typeof input.incarnationId !== 'string' || !incarnationIdPattern.test(input.incarnationId))
  )
    throw new Error('Invalid subject library action');
  if (
    'collectionId' in input &&
    input.collectionId !== undefined &&
    (typeof input.collectionId !== 'string' || !input.collectionId || input.collectionId.length > 128)
  )
    throw new Error('Invalid subject library action');
  return input as SubjectLibraryMutation;
}

function validateCollectionsInput(input: unknown): { subjectId: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('subjectId' in input) ||
    typeof input.subjectId !== 'string' ||
    !input.subjectId ||
    input.subjectId.length > 128
  )
    throw new Error('Invalid subject library collections input');
  return { subjectId: input.subjectId };
}

export const readSubjectLibraryCollections = createServerFn({ method: 'GET' })
  .validator(validateCollectionsInput)
  .handler(async (): Promise<Awaited<ReturnType<typeof loadSubjectLibraryCollections>>> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadSubjectLibraryCollections(kernelClient(), getRequest(), env as Partial<SessionEnv>);
  });

export const mutateSubjectLibrarySlot = createServerFn({ method: 'POST' })
  .validator(validateMutation)
  .handler(async ({ data }): Promise<SubjectLibraryMutationResponse> => {
    setResponseHeader('cache-control', 'private, no-store');
    return applySubjectLibraryMutation(getRequest(), env as Partial<SessionEnv>, data);
  });

function validateRestore(input: unknown): LibraryRestoreInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid library restore');
  const value = input as Record<string, unknown>;
  if (
    typeof value.subjectId !== 'string' ||
    !value.subjectId ||
    value.subjectId.length > 128 ||
    typeof value.deletionId !== 'string' ||
    !value.deletionId ||
    value.deletionId.length > 128 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  )
    throw new Error('Invalid library restore');
  return { subjectId: value.subjectId, deletionId: value.deletionId, revision: value.revision as number };
}

export const restoreSubjectLibrarySlot = createServerFn({ method: 'POST' })
  .validator(validateRestore)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return restorePersonalLibraryEntry(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
