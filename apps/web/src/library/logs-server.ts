import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  deletePublishedLog as deleteLog,
  restorePublishedLog as restoreLog,
  loadMyPublishedLogs,
  loadPublishedLog,
  publishProgressLog as publishLog,
  type PublishedLogPage,
  type PublishedLogWriteResult,
} from './logs-read';

function validateLogId(input: unknown): { id: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 128
  )
    throw new Error('Invalid published log id');
  return { id: input.id };
}

function validateListInput(input: unknown): { cursor?: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    ('cursor' in input &&
      input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || input.cursor.length > 2048))
  )
    throw new Error('Invalid published log cursor');
  return 'cursor' in input && typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {};
}

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validatePublish(input: unknown): { sessionId: string; note?: string; idempotencyKey: string } {
  if (!input || typeof input !== 'object') throw new Error('Invalid publish request');
  const value = input as Record<string, unknown>;
  if (
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 128 ||
    (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 1000)) ||
    typeof value.idempotencyKey !== 'string' ||
    !idempotencyKeyPattern.test(value.idempotencyKey)
  )
    throw new Error('Invalid publish request');
  return {
    sessionId: value.sessionId,
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
    idempotencyKey: value.idempotencyKey,
  };
}

function validateDelete(input: unknown): { id: string; revision?: number; idempotencyKey: string } {
  if (!input || typeof input !== 'object') throw new Error('Invalid delete request');
  const value = input as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    typeof value.idempotencyKey !== 'string' ||
    !idempotencyKeyPattern.test(value.idempotencyKey)
  )
    throw new Error('Invalid delete request');
  if (
    value.revision !== undefined &&
    (typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      value.revision > 2147483646)
  )
    throw new Error('Invalid log revision');
  return {
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
  };
}

export const readPublishedLog = createServerFn({ method: 'GET' })
  .validator(validateLogId)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadPublishedLog(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    await nameSubjectTypes([result.log.subject]);
    return result;
  });

export const readMyPublishedLogs = createServerFn({ method: 'GET' })
  .validator(validateListInput)
  .handler(async ({ data }): Promise<PublishedLogPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const page = await loadMyPublishedLogs(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    await nameSubjectTypes(page.logs.map((log) => log.subject));
    return page;
  });

export const publishProgressLog = createServerFn({ method: 'POST' })
  .validator(validatePublish)
  .handler(async ({ data }): Promise<PublishedLogWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return publishLog(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const removePublishedLog = createServerFn({ method: 'POST' })
  .validator(validateDelete)
  .handler(async ({ data }): Promise<PublishedLogWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return deleteLog(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const restorePublishedLog = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = validateDelete(input);
    if (
      !input ||
      typeof input !== 'object' ||
      !('deletionId' in input) ||
      typeof input.deletionId !== 'string' ||
      !idempotencyKeyPattern.test(input.deletionId) ||
      value.revision === undefined
    )
      throw new Error('Invalid restore request');
    return { ...value, revision: value.revision, deletionId: input.deletionId };
  })
  .handler(async ({ data }): Promise<PublishedLogWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return restoreLog(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
