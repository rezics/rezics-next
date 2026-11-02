import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { nameSubjectTypes, readRelease } from '../subject/definitions';
import { resolveCopyProfile, type CopySubjectResult } from './copies-profiles';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { readSessionIdentity } from '../session/state';
import { getLocale } from '../paraglide/runtime.js';
import { prepareSession, viewerCredential, sessionSubject, requestCsrfToken } from '../session/request';
import type { KernelClient } from '@rezics/client';
import { copiesAddress, copiesQuery as validateQuery, copiesSubjectId, type CopiesAddress } from './copies-query';
export { copiesAddress, sameCopiesAddress, type CopiesAddress } from './copies-query';
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

export type CopiesCurrentRead = { sessionSubject: string | null; requested: CopiesAddress; page: CopiesPageData };
export type CopyDetailCurrentRead = {
  sessionSubject: string | null;
  requested: CopiesAddress;
  id: string | null;
  result: Awaited<ReturnType<typeof loadCopyDetail>>;
};
export type CopySubjectCurrentRead = {
  sessionSubject: string | null;
  requested: CopiesAddress;
  id: string;
  result: CopySubjectResult;
};
type Preparation = { subject: string | null; authorization: string; csrfToken: string | null };
function prepared(request: Request, authorization: string | null): Preparation | undefined {
  if (!authorization || authorization !== viewerCredential(request)) return undefined;
  // Explicit-header API callers remain supported, but cannot certify a browser session.
  return {
    subject: request.headers.has('authorization') ? null : (sessionSubject(request) ?? null),
    authorization,
    csrfToken: requestCsrfToken(request),
  };
}

/** Observe only the native reader's dispatch, immediately after its successful preparation.
 * A fresh Request prevents retained WeakMap credentials from becoming provenance after refusal.
 * The credential stays in this server closure and is never part of a returned envelope.
 */
function observeCopiesRead(client: KernelClient, observe: (authorization: string | null) => void): KernelClient {
  const point = (target: object) =>
    new Proxy(target, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== 'get') return value;
        return (options: { headers?: HeadersInit }) => {
          observe(new Headers(options.headers).get('authorization'));
          return value(options);
        };
      },
    });
  const copies = new Proxy(client.copies, {
    get(target, key) {
      return Reflect.get(point(target), key);
    },
    apply(target, _receiver, args) {
      return point(Reflect.apply(target, undefined, args));
    },
  });
  return new Proxy(client, {
    get(target, key) {
      return key === 'copies' ? copies : Reflect.get(target, key);
    },
  });
}

async function copiesPageBody(input: unknown, current: boolean): Promise<CopiesCurrentRead> {
  const request = current ? new Request(getRequest()) : getRequest();
  const requested = copiesAddress(input, getLocale());
  if (requested.issue) {
    // Session admission remains native; a malformed address performs no copy or subject read.
    const refused = await prepareSession(request, env as Partial<SessionEnv>);
    const subject = refused ? null : (sessionSubject(request) ?? null);
    return {
      sessionSubject: subject,
      requested,
      page: {
        signedIn: !!subject,
        subjectId: requested.subjectId,
        requestedCursor: requested.cursor,
        copies: [],
        next: null,
        addKey: crypto.randomUUID(),
      },
    };
  }
  let origin: Preparation | undefined;
  let dispatched = false;
  const client = observeCopiesRead(kernelClient(), (authorization) => {
    const actual = prepared(request, authorization);
    // The single invalid-cursor recovery must retain the original association too.
    if (!dispatched) origin = actual;
    else if (origin?.subject !== actual?.subject || origin?.authorization !== actual?.authorization) origin = undefined;
    dispatched = true;
  });
  const page = await loadCopiesPage(client, request, env as Partial<SessionEnv>, {
    ...(requested.subjectId ? { subjectId: requested.subjectId } : {}),
    ...(requested.cursor ? { cursor: requested.cursor } : {}),
  });
  if (current && !origin?.subject) {
    return {
      sessionSubject: null,
      requested,
      page: {
        signedIn: false,
        subjectId: requested.subjectId,
        requestedCursor: requested.cursor,
        copies: [],
        next: null,
        addKey: page.addKey,
      },
    };
  }
  if (page.signedIn) {
    await nameSubjectTypes(page.copies.map((copy) => copy.subject));
    const release = await readRelease().catch(() => ({ types: {}, properties: {} }));
    const pageSubject = page.subjectId
      ? (page.copies.find((copy) => copy.subject?.id === page.subjectId)?.subject ??
        (await readCopySubjectSummary(page.subjectId, origin?.authorization ?? null)))
      : null;
    if (pageSubject) await nameSubjectTypes([pageSubject]);
    for (const copy of page.copies) {
      if (!copy.subject && pageSubject) copy.subject = pageSubject;
    }
    if (page.subjectId)
      page.profile = pageSubject ? resolveCopyProfile(release, pageSubject.type, requested.locale) : { kinds: [] };
    if (current) page.csrfToken = origin?.csrfToken ?? null;
    else {
      const identity = await readSessionIdentity(request, env as Partial<SessionEnv>);
      page.csrfToken = origin?.subject && identity.subject === origin.subject ? identity.csrfToken : null;
    }
  }
  return { sessionSubject: origin?.subject ?? null, requested, page };
}
export const readCopiesPage = createServerFn({ method: 'GET' })
  .validator(validateQuery)
  .handler(async ({ data }): Promise<CopiesPageData> => {
    setResponseHeader('cache-control', 'private, no-store');
    return (await copiesPageBody(data, false)).page;
  });
export const readCopiesCurrent = createServerFn({ method: 'GET' })
  .validator(validateQuery)
  .handler(async ({ data }): Promise<CopiesCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return copiesPageBody(data, true);
  });

async function copyDetailBody(input: unknown, current: boolean): Promise<CopyDetailCurrentRead> {
  const request = current ? new Request(getRequest()) : getRequest();
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const requested = copiesAddress(record, getLocale());
  if (requested.issue)
    return { sessionSubject: null, requested, id: null, result: { ok: false, reason: 'unavailable' } };
  let origin: Preparation | undefined;
  const client = observeCopiesRead(kernelClient(), (authorization) => {
    origin = prepared(request, authorization);
  });
  const result = await loadCopyDetail(client, request, env as Partial<SessionEnv>, input);
  return {
    sessionSubject: origin?.subject ?? null,
    requested,
    id: typeof record.id === 'string' ? record.id : null,
    result,
  };
}
export const readCopyDetail = createServerFn({ method: 'GET' })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return (await copyDetailBody(data, false)).result;
  });
export const readCopyDetailCurrent = createServerFn({ method: 'GET' })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<CopyDetailCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const value = await copyDetailBody(data, true);
    return value.sessionSubject || !value.result.ok
      ? value
      : { ...value, result: { ok: false, reason: 'unavailable' } };
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

async function resolveSubject(
  id: string,
  capture: (origin: Preparation | undefined) => void,
  current = false,
): Promise<CopySubjectResult> {
  if (!copiesSubjectId(id)) return { state: 'unavailable' };
  try {
    const request = current ? new Request(getRequest()) : getRequest();
    if (await prepareSession(request, env as Partial<SessionEnv>)) return { state: 'forbidden' };
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'forbidden' };
    capture(prepared(request, authorization));
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
    return resolveSubject(data, () => {});
  });

export const readCopySubjectCurrent = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    return { ...validateQuery(record), id: typeof record.id === 'string' ? record.id : '' };
  })
  .handler(async ({ data }): Promise<CopySubjectCurrentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const requested = copiesAddress(data, getLocale());
    if (requested.issue) return { sessionSubject: null, requested, id: data.id, result: { state: 'unavailable' } };
    let origin: Preparation | undefined;
    const result = await resolveSubject(
      data.id,
      (actual) => {
        origin = actual;
      },
      true,
    );
    return {
      sessionSubject: origin?.subject ?? null,
      requested,
      id: data.id,
      result: !origin?.subject && result.state === 'ready' ? { state: 'unavailable' } : result,
    };
  });
