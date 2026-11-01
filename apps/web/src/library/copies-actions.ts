import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes, readRelease } from '../subject/definitions';
import { resolveCopyProfile, type CopySubjectResult } from './copies-profiles';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { readSessionIdentity } from '../session/state';
import { getLocale } from '../paraglide/runtime.js';
import { prepareSession, viewerCredential } from '../session/request';
import { copiesSubjectId } from './copies-query';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  loadCopiesPage,
  loadCopyDetail,
  removeCopy,
  saveCopy,
  restoreCopy,
  submitCopy,
  type CopiesPageData,
  type CopyRemoveResult,
  type CopyWriteResult,
} from './copies-read';
import { subjectOf as presentSubject, type LibrarySubject } from './reads';

function validateQuery(input: unknown): { subjectId?: string; cursor?: string } {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  const subjectId =
    typeof record.subjectId === 'string' && record.subjectId.length > 0 && record.subjectId.length <= 128
      ? record.subjectId
      : undefined;
  const cursor =
    typeof record.cursor === 'string' && record.cursor.length > 0 && record.cursor.length <= 2048
      ? record.cursor
      : undefined;
  return {
    ...(subjectId ? { subjectId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export const readCopiesPage = createServerFn({ method: 'GET' })
  .validator(validateQuery)
  .handler(async ({ data }): Promise<CopiesPageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const page = await loadCopiesPage(kernelClient(), request, env as Partial<SessionEnv>, data);
    if (!page.signedIn) return page;
    // The list and its summary share the one successful preparation for this request.
    const authorization = viewerCredential(request);
    await nameSubjectTypes(page.copies.map((copy) => copy.subject));
    const release = await readRelease().catch(() => ({ types: {}, properties: {} }));
    const locale = getLocale();
    const pageSubject = page.subjectId
      ? (page.copies.find((copy) => copy.subject?.id === page.subjectId)?.subject ??
        (await readCopySubjectSummary(page.subjectId, authorization)))
      : null;
    if (pageSubject) await nameSubjectTypes([pageSubject]);
    for (const copy of page.copies) {
      // Reuse the filtered subject's bounded summary, preserving real covers from the list.
      if (!copy.subject && pageSubject) copy.subject = pageSubject;
    }
    if (page.subjectId) {
      page.profile = pageSubject ? resolveCopyProfile(release, pageSubject.type, locale) : { kinds: [] };
    }
    page.csrfToken = (await readSessionIdentity(request, env as Partial<SessionEnv>)).csrfToken;
    return page;
  });

export const readCopyDetail = createServerFn({ method: 'GET' })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadCopyDetail(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const createCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return submitCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const updateCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return saveCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const deleteCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyRemoveResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return removeCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

export const undoCopy = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyWriteResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return restoreCopy(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });

async function readCopySubjectSummary(id: string, authorization: string | null): Promise<LibrarySubject | null> {
  if (!copiesSubjectId(id) || !authorization) return null;
  const result = await kernelClient()
    .subjects({ id })
    .get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (result.error || result.data?.subject?.id !== id) return null;
  const subject = result.data.subject;
  const locale = getLocale();
  return presentSubject({
    id: subject.id,
    type: subject.type,
    label: subject.labels[locale] ?? subject.labels.en ?? null,
    cover: null,
  });
}

async function resolveSubject(id: string): Promise<CopySubjectResult> {
  if (!copiesSubjectId(id)) return { state: 'unavailable' };
  try {
    const request = getRequest();
    if (await prepareSession(request, env as Partial<SessionEnv>)) return { state: 'forbidden' };
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'forbidden' };
    const result = await kernelClient()
      .subjects({ id })
      .get({
        headers: { authorization },
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { state: 'closed' };
    if ([401, 403, 404].includes(result.status)) return { state: 'forbidden' };
    if (result.error || result.data?.subject?.id !== id) return { state: 'unavailable' };
    const raw = result.data.subject;
    const locale = getLocale();
    const subject = presentSubject({
      id: raw.id,
      type: raw.type,
      label: raw.labels[locale] ?? raw.labels.en ?? null,
      cover: null,
    });
    if (!subject) return { state: 'unavailable' };
    const profile = resolveCopyProfile(await readRelease(), raw.type, locale);
    return profile.kinds.some((kind) => kind.statuses.length)
      ? { state: 'ready', subject, profile }
      : { state: 'unsupported' };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** Resolve the selected search result using its current authorised subject and authoritative type. */
export const readCopySubject = createServerFn({ method: 'GET' })
  .validator((input: unknown) => (typeof input === 'string' ? input : ''))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return resolveSubject(data);
  });
