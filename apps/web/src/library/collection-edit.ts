import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  addCollectionMemberRecord,
  createCollectionRecord,
  deleteCollectionRecord,
  followCollectionRecord,
  isRecord,
  moveCollectionMemberRecord,
  removeCollectionMemberRecord,
  unfollowCollectionRecord,
  updateCollectionRecord,
  updateMemberNoteRecord,
  type CollectionWriteResult,
} from './collection-records';

export type { CollectionWriteResult } from './collection-records';

function serverEnv(): Partial<SessionEnv> {
  return env as Partial<SessionEnv>;
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length > 20_000) throw new Error('Invalid collection input');
  return value;
}

function identifier(input: Record<string, unknown>, key: string): string {
  const value = text(input, key);
  if (value.length === 0 || value.length > 128) throw new Error('Invalid collection input');
  return value;
}

function revision(input: Record<string, unknown>): number {
  const value = input.revision;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid collection input');
  return value;
}

function record(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error('Invalid collection input');
  return input;
}

function validateCreate(input: unknown) {
  const value = record(input);
  return {
    title: text(value, 'title'),
    description: text(value, 'description'),
    visibility: text(value, 'visibility'),
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateUpdate(input: unknown) {
  const value = record(input);
  return {
    collectionId: identifier(value, 'collectionId'),
    revision: revision(value),
    title: text(value, 'title'),
    description: text(value, 'description'),
    visibility: text(value, 'visibility'),
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateAddMember(input: unknown) {
  const value = record(input);
  const note = value.note;
  if (note !== null && note !== undefined && (typeof note !== 'string' || note.length > 20_000))
    throw new Error('Invalid collection input');
  return {
    collectionId: identifier(value, 'collectionId'),
    subjectId: identifier(value, 'subjectId'),
    note: (typeof note === 'string' ? note : null) as string | null,
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateDelete(input: unknown) {
  const value = record(input);
  return {
    collectionId: identifier(value, 'collectionId'),
    revision: revision(value),
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateMove(input: unknown) {
  const value = record(input);
  const after = value.after;
  if (after !== null && (typeof after !== 'string' || after.length === 0 || after.length > 128)) {
    throw new Error('Invalid collection input');
  }
  return {
    collectionId: identifier(value, 'collectionId'),
    memberId: identifier(value, 'memberId'),
    after: after as string | null,
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateNote(input: unknown) {
  const value = record(input);
  const note = value.note;
  if (note !== null && (typeof note !== 'string' || note.length > 20_000)) throw new Error('Invalid collection input');
  return {
    collectionId: identifier(value, 'collectionId'),
    memberId: identifier(value, 'memberId'),
    note: note as string | null,
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateMember(input: unknown) {
  const value = record(input);
  return {
    collectionId: identifier(value, 'collectionId'),
    memberId: identifier(value, 'memberId'),
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

function validateFollow(input: unknown) {
  const value = record(input);
  if (typeof value.follow !== 'boolean') throw new Error('Invalid collection input');
  return {
    collectionId: identifier(value, 'collectionId'),
    follow: value.follow,
    idempotencyKey: text(value, 'idempotencyKey'),
  };
}

export const readNewCollection = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('cache-control', 'private, no-store');
  return { idempotencyKey: crypto.randomUUID() };
});

export const createCollection = createServerFn({ method: 'POST' })
  .validator(validateCreate)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return createCollectionRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const updateCollection = createServerFn({ method: 'POST' })
  .validator(validateUpdate)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return updateCollectionRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const addCollectionMember = createServerFn({ method: 'POST' })
  .validator(validateAddMember)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return addCollectionMemberRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const deleteCollection = createServerFn({ method: 'POST' })
  .validator(validateDelete)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return deleteCollectionRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const moveCollectionMember = createServerFn({ method: 'POST' })
  .validator(validateMove)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return moveCollectionMemberRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const updateMemberNote = createServerFn({ method: 'POST' })
  .validator(validateNote)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return updateMemberNoteRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const removeCollectionMember = createServerFn({ method: 'POST' })
  .validator(validateMember)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return removeCollectionMemberRecord(kernelClient(), getRequest(), serverEnv(), data);
  });

export const setCollectionFollow = createServerFn({ method: 'POST' })
  .validator(validateFollow)
  .handler(async ({ data }): Promise<CollectionWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { follow, ...input } = data;
    return follow
      ? followCollectionRecord(kernelClient(), getRequest(), serverEnv(), input)
      : unfollowCollectionRecord(kernelClient(), getRequest(), serverEnv(), input);
  });
