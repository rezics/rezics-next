import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes } from '../subject/definitions';
import { kernelClient, requestLocale } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { sessionSubject, viewerCredential } from '../session/request';
import { myLogsResult, PublishedLogListError, requireMyLogsSearch, type MyLogsPage } from './my-logs';
import {
  deletePublishedLog as deleteLog,
  restorePublishedLog as restoreLog,
  loadMyPublishedLogs,
  loadPublishedLog,
  loadPublishedLogCurrent,
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
  return requireMyLogsSearch(input);
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

export const readPublishedLogCurrent = createServerFn({ method: 'GET' })
  .validator(validateLogId)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await loadPublishedLogCurrent(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
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

/** The history entry uses the same owner reader as the session page, with explicit failure states. */
export const readMyPublishedLogHistory = createServerFn({ method: 'GET' })
  .validator(validateListInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return myLogsResult(() => readMyPublishedLogs({ data }));
  });

export type MyLogsViewerHistory = {
  sessionSubject: string | null;
  /** Retain the requested address even when a stale cursor restarts at the newest page. */
  cursor: string | null;
  locale: string;
  page: MyLogsPage;
};

/** The list and its owner provenance must come from the same reader preparation. */
export const readMyPublishedLogHistoryForViewer = createServerFn({ method: 'GET' })
  .validator(validateListInput)
  .handler(async ({ data }): Promise<MyLogsViewerHistory> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    let preparedSubject: string | null = null;
    const page = await myLogsResult(async () => {
      // GET preparation cannot associate an explicit bearer with a session subject. In
      // particular, a subject left by an earlier preparation is not that bearer's owner.
      if (request.headers.has('authorization')) throw new PublishedLogListError('denied');
      const loaded = await loadMyPublishedLogs(kernelClient(), request, env as Partial<SessionEnv>, data);
      if (!loaded.signedIn) return loaded;
      const subject = sessionSubject(request);
      if (!subject || !viewerCredential(request)) throw new PublishedLogListError('unavailable');
      preparedSubject = subject;
      await nameSubjectTypes(loaded.logs.map((log) => log.subject));
      return loaded;
    });
    // Refusal can leave old Request WeakMap entries behind. Only the actual successful
    // owner reader permits an asserted viewer; failure states carry no owner payload.
    const subject = page.state === 'loaded' ? preparedSubject : null;
    return { sessionSubject: subject, cursor: data.cursor ?? null, locale: requestLocale(request) ?? 'en', page };
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
