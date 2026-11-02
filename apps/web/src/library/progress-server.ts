import { createServerFn } from '@tanstack/react-start';
import { progressIndexAddress, progressSessionAddress } from './progress-address';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { progressFormChoices, type ProgressChoices } from './progress-profile';
import { readRelease } from '../subject/definitions';
import { requestLocale } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { kernelClient } from '../kernel/client';
import { nameSubjectTypes } from '../subject/definitions';
import { configured, type SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE, validId } from '../session/cookies';
import { sessionSubject, viewerCredential } from '../session/request';
import {
  finishProgress,
  loadProgressIndex,
  loadProgressSession,
  recordProgress,
  startProgress,
  type ProgressFailure,
  type ProgressFinishInput,
  type ProgressIndex,
  type ProgressRecorded,
  type ProgressRecordInput,
  type ProgressSessionPage,
  type ProgressStartInput,
  type ProgressStarted,
} from './progress-reads';

function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new Error('Invalid progress request');
  return value;
}

function validateStart(input: unknown): ProgressStartInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid progress request');
  const value = input as Record<string, unknown>;
  const total = value.total === undefined ? undefined : requiredString(value.total, 32);
  const versionSubjectId =
    value.versionSubjectId === undefined ? undefined : requiredString(value.versionSubjectId, 128);
  return {
    subjectId: requiredString(value.subjectId, 128),
    ...(versionSubjectId === undefined ? {} : { versionSubjectId }),
    mode: requiredString(value.mode, 32),
    unit: requiredString(value.unit, 128),
    idempotencyKey: requiredString(value.idempotencyKey, 64),
    ...(total === undefined ? {} : { total }),
  };
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error('Invalid progress request');
  return value;
}

function validateRecord(input: unknown): ProgressRecordInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid progress request');
  const value = input as Record<string, unknown>;
  if (typeof value.revision !== 'number') throw new Error('Invalid progress request');
  if (value.clear !== undefined && value.clear !== true) throw new Error('Invalid progress request');
  const add = stringList(value.add);
  const remove = stringList(value.remove);
  return {
    sessionId: requiredString(value.sessionId, 128),
    revision: value.revision,
    idempotencyKey: requiredString(value.idempotencyKey, 64),
    ...(value.clear === true ? { clear: true as const } : {}),
    ...(value.amount === undefined ? {} : { amount: requiredString(value.amount, 32) }),
    ...(value.locator === undefined ? {} : { locator: requiredString(value.locator, 256) }),
    ...(value.position === undefined ? {} : { position: requiredString(value.position, 32) }),
    ...(add === undefined ? {} : { add }),
    ...(remove === undefined ? {} : { remove }),
  };
}

function validateFinish(input: unknown): ProgressFinishInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid progress request');
  const value = input as Record<string, unknown>;
  const action = value.action;
  if (action !== 'complete' && action !== 'abandon') throw new Error('Invalid progress request');
  if (typeof value.revision !== 'number') throw new Error('Invalid progress request');
  return {
    sessionId: requiredString(value.sessionId, 128),
    action,
    revision: value.revision,
    idempotencyKey: requiredString(value.idempotencyKey, 64),
  };
}

/** Presentation consumes the already bounded page; it never repeats authentication or the list. */
async function presentProgressIndex(page: ProgressIndex, locale: string): Promise<ProgressIndex> {
  await nameSubjectTypes([
    page.selectedSubject,
    ...page.sessions.flatMap((session) => [session.subject, session.versionSubject]),
  ]);
  if (page.signedIn) {
    try {
      const release = await readRelease();
      const subject = page.selectedSubject;
      page.progressChoices = subject ? progressFormChoices(release, subject.type, locale) : undefined;
    } catch (error) {
      if (isPlatformClosedError(error)) throw error;
      page.choicesUnavailable = true;
    }
  }
  return page;
}

export const readProgressIndex = createServerFn({ method: 'GET' })
  .validator(progressIndexAddress)
  .handler(async ({ data }): Promise<ProgressIndex> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadProgressIndex(kernelClient(), request, env as Partial<SessionEnv>, data);
    return presentProgressIndex(page, requestLocale(request) ?? 'en');
  });

export type CurrentViewerProgressIndex = {
  viewer: string | null;
  requested: { subjectId: string; cursor: string | null };
  locale: string;
  page: ProgressIndex;
};

/** The viewer comes from the preparation performed by this exact successful reader. */
export const readCurrentViewerProgressIndex = createServerFn({ method: 'GET' })
  .validator(progressIndexAddress)
  .handler(async ({ data }): Promise<CurrentViewerProgressIndex> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const locale = requestLocale(request) ?? 'en';
    const requested = { subjectId: data.subjectId ?? '', cursor: data.cursor ?? null };
    // With these preconditions, a signed-in reader necessarily prepared the cookie's active
    // credential/subject pair. Explicit bearer requests have no such subject association;
    // missing cookies/configuration must never reuse WeakMap state left on a retained request.
    const associated =
      configured(env as Partial<SessionEnv>) &&
      validId(cookie(request, SESSION_COOKIE)) &&
      !request.headers.has('authorization');
    const empty = (idempotencyKey: string): CurrentViewerProgressIndex => ({
      viewer: null,
      requested,
      locale,
      page: {
        signedIn: false,
        subjectId: requested.subjectId,
        selectedSubject: null,
        sessions: [],
        next: null,
        idempotencyKey,
      },
    });
    if (!associated) return empty(crypto.randomUUID());
    const page = await loadProgressIndex(kernelClient(), request, env as Partial<SessionEnv>, data);
    const viewer = page.signedIn && viewerCredential(request) ? sessionSubject(request) : undefined;
    if (!viewer) return empty(page.idempotencyKey);
    return { viewer, requested, locale, page: await presentProgressIndex(page, locale) };
  });

export const readProgressSession = createServerFn({ method: 'GET' })
  .validator(progressSessionAddress)
  .handler(async ({ data }): Promise<ProgressSessionPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadProgressSession(kernelClient(), request, env as Partial<SessionEnv>, data);
    if (page.signedIn) await nameSubjectTypes([page.session.subject, page.session.versionSubject]);
    return page;
  });

export const startProgressSession = createServerFn({ method: 'POST' })
  .validator(validateStart)
  .handler(async ({ data }): Promise<ProgressStarted | ProgressFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return startProgress(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const recordProgressSession = createServerFn({ method: 'POST' })
  .validator(validateRecord)
  .handler(async ({ data }): Promise<ProgressRecorded | ProgressFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return recordProgress(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const finishProgressSession = createServerFn({ method: 'POST' })
  .validator(validateFinish)
  .handler(async ({ data }): Promise<ProgressRecorded | ProgressFailure> => {
    setResponseHeader('cache-control', 'private, no-store');
    return finishProgress(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

/** Picker results already identify the accepting type; resolving its choices needs no subject request. */
export const readProgressChoices = createServerFn({ method: 'GET' })
  .validator((type: string) => requiredString(type, 256))
  .handler(async ({ data }): Promise<ProgressChoices> => {
    setResponseHeader('cache-control', 'private, no-store');
    return progressFormChoices(await readRelease(), data, requestLocale() ?? 'en');
  });
