import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes, readRelease } from '../subject/definitions';
import { copyLabels, resolveCopyProfile } from './copies-profiles';
import { readSessionIdentity } from '../session/state';
import { getLocale } from '../paraglide/runtime.js';
import { prepareSession, viewerCredential } from '../session/request';
import { copiesSubjectId } from './copies-query';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  loadCopiesPage,
  removeCopy,
  saveCopy,
  submitCopy,
  type CopiesPageData,
  type CopyRemoveResult,
  type CopyWriteResult,
} from './copies-read';

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
    const page = await loadCopiesPage(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
    await nameSubjectTypes(page.copies.map((copy) => copy.subject));
    const release = await readRelease().catch(() => ({ types: {}, properties: {} }));
    const locale = getLocale();
    const profiles = new Map<string, ReturnType<typeof resolveCopyProfile>>();
    for (const copy of page.copies) {
      const type = copy.subject?.type ?? '';
      let profile = profiles.get(type);
      if (!profile) {
        profile = resolveCopyProfile(release, type, locale);
        profiles.set(type, profile);
      }
      Object.assign(copy, { profile, ...copyLabels(release, type, copy.kind, copy.status, locale) });
    }
    if (page.subjectId) {
      // An empty filtered list has no embedded subject; resolve just the explicitly selected subject.
      page.profile =
        page.copies.find((copy) => copy.subject?.id === page.subjectId)?.profile ??
        (await resolveSubject(page.subjectId));
    }
    page.csrfToken = (await readSessionIdentity(getRequest(), env as Partial<SessionEnv>)).csrfToken;
    return page;
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

async function resolveSubject(id: string) {
  if (!copiesSubjectId(id)) return { kinds: [] };
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  const authorization = viewerCredential(request);
  if (!authorization) return { kinds: [] };
  const result = await kernelClient().subjects({ id }).get({ headers: { authorization } });
  if (result.error || !result.data?.subject) return { kinds: [] };
  return resolveCopyProfile(await readRelease(), result.data.subject.type, getLocale());
}

/** Resolve a newly entered edition on the server, using its authoritative type rather than a browser hint. */
export const readCopySubject = createServerFn({ method: 'GET' })
  .validator((input: unknown) => (typeof input === 'string' ? input : ''))
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return resolveSubject(data);
  });
