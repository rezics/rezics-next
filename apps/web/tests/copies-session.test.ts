import { expect, mock, spyOn, test } from 'bun:test';
import * as start from '../.storybook/react-start';
import type { SessionEnv } from '../src/session/client';
import { newCsrfToken } from '../src/session/csrf';
import { prepareSession, viewerCredential } from '../src/session/request';
import { copyStatusChange, loadCopyDetail } from '../src/library/copies-read';
import { isPlatformClosedError, PlatformClosedError } from '../src/kernel/platform-closed';
import type { KernelClient } from '@rezics/client';
import type { NativeCopy, NativeCopyPresentation } from '../src/library/copies-server';
import type { Release } from '../src/subject/definitions';

const origin = 'https://site.test';
const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const copyId = '01a17a3b-7065-7048-8c7f-f4ccfae1f400';
const key = '10203040-5060-4070-8090-102030405060';
const csrfToken = newCsrfToken();
const fields = {
  location: 'Study',
  source: 'Bookshop',
  acquiredOn: '2020-02-29',
  disposedOn: null,
  note: 'First copy',
};
const native = { id: copyId, subjectId, kind: 'print', status: 'shelf', revision: 12, ...fields } satisfies NativeCopy;
const presentation = {
  meaning: 'known',
  kindLabel: 'Original print label',
  kindLabelLanguage: 'en',
  statusLabel: 'Original shelf label',
  statusLabelLanguage: 'en',
  statusEditing: { state: 'supported', statuses: [{ id: 'loan', label: 'On loan', labelLanguage: 'en' }] },
} satisfies NativeCopyPresentation;
const release = {
  types: { Book: { library: { profileId: 'books' } } },
  properties: {},
  libraryProfiles: {
    books: {
      copies: {
        kinds: [{ id: 'print', labels: { en: 'Print today' }, statuses: [{ id: 'loan', labels: { en: 'On loan' } }] }],
      },
    },
  },
} satisfies Release;

function request(method = 'GET', headers?: HeadersInit): Request {
  return new Request(`${origin}/en/library/copies`, {
    method,
    headers: headers ?? {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin,
      'x-csrf-token': csrfToken,
      'accept-language': 'ja,en;q=0.8',
    },
  });
}
let currentRequest = request();
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let refuseNextPreparation = false;
let accessToken = 'current-viewer';
const counts = { credential: 0, identity: 0, types: 0, release: 0 };
const responseHeaders = new Headers();
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: origin,
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        counts.credential++;
        const status = preparation;
        if (refuseNextPreparation) preparation = 'absent';
        return status === 'active' ? { status, accessToken, subject: 'owner', csrfToken } : { status, csrfToken };
      },
      signedIn: async () => {
        counts.identity++;
        return { signedIn: true, subject: 'owner', csrfToken };
      },
    }),
  },
};
const sessionEnv = env as unknown as Partial<SessionEnv>;
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
mock.module('../src/subject/definitions', () => ({
  nameSubjectTypes: async () => {
    counts.types++;
  },
  readRelease: async () => {
    counts.release++;
    return release;
  },
}));
const { readCopiesCurrent, readCopiesPage, readCopyDetail, readCopySubject, updateCopy } =
  await import('../src/library/copies-actions');

function reset(): void {
  currentRequest = request();
  preparation = 'active';
  refuseNextPreparation = false;
  accessToken = 'current-viewer';
  for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0;
  responseHeaders.delete('cache-control');
}

test('actual refused preparation conceals cached list/detail credentials and stops all decoration; unsafe edits keep native CSRF refusal and failures stay unavailable', async () => {
  reset();
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Refused preparation must not reach the kernel');
  });
  try {
    // Populate the real WeakMap, then let the real preparation boundary refuse this same Request.
    expect(await prepareSession(currentRequest, sessionEnv)).toBe(false);
    expect(viewerCredential(currentRequest)).toBe('Bearer current-viewer');
    preparation = 'absent';
    expect(await readCopiesPage({ data: { subjectId } })).toEqual({
      signedIn: false,
      subjectId,
      copies: [],
      next: null,
      addKey: expect.any(String),
    });
    expect(await readCopyDetail({ data: { id: copyId } })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await readCopySubject({ data: subjectId })).toEqual({ state: 'forbidden' });
    expect(viewerCredential(currentRequest)).toBe('Bearer current-viewer');
    expect(counts).toEqual({ credential: 4, identity: 0, types: 0, release: 0 });

    preparation = 'unavailable';
    await expect(readCopiesPage({ data: { subjectId } })).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });
    expect(await readCopyDetail({ data: { id: copyId } })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await readCopySubject({ data: subjectId })).toEqual({ state: 'unavailable' });

    currentRequest = request('POST');
    preparation = 'active';
    expect(await prepareSession(currentRequest, sessionEnv)).toBe(false);
    preparation = 'absent';
    const edit = { id: copyId, revision: native.revision, idempotencyKey: key, ...fields };
    await expect(updateCopy({ data: edit })).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    preparation = 'unavailable';
    await expect(updateCopy({ data: edit })).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });
    preparation = 'active';
    currentRequest.headers.set('origin', 'https://another-site.test');
    await expect(updateCopy({ data: edit })).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    currentRequest = request('POST', {});
    expect(await updateCopy({ data: edit })).toEqual({ ok: false, reason: 'forbidden' });
    expect(transport).not.toHaveBeenCalled();
    expect(counts.identity + counts.types + counts.release).toBe(0);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    transport.mockRestore();
  }
});

test('native Copy-list permission denial stays distinct from missing, closure and transport outcomes', async () => {
  reset();
  let outcome: 'forbidden' | 'closed' | 'missing' | 'transport' = 'forbidden';
  const calls: Request[] = [];
  const transportFailure = new Error('native transport failed');
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    if (new URL(call.url).pathname !== '/v1/copies') throw new Error(`Unexpected read ${call.url}`);
    if (outcome === 'transport') throw transportFailure;
    const status = outcome === 'missing' ? 404 : 403;
    const code = outcome === 'closed' ? 'platform_closed' : outcome === 'missing' ? 'not_found' : 'forbidden';
    return Response.json({ code, detail: 'private problem body' }, { status });
  });
  try {
    const address = { subjectId, cursor: 'opaque/cursor+exact' };
    const initial = await readCopiesPage({ data: address });
    expect(initial).toMatchObject({
      signedIn: true,
      subjectId,
      requestedCursor: address.cursor,
      inventoryState: 'forbidden',
      copies: [],
      next: null,
    });
    const current = await readCopiesCurrent({ data: address });
    expect(current).toMatchObject({
      sessionSubject: 'owner',
      requested: { ...address, kind: null, status: null, locale: 'en' },
      page: { signedIn: true, inventoryState: 'forbidden', requestedCursor: address.cursor, copies: [], next: null },
    });
    expect(JSON.stringify(current)).not.toContain('private problem body');
    expect(calls).toHaveLength(2);
    expect(counts).toEqual({ credential: 2, identity: 0, types: 0, release: 0 });

    for (const kind of ['closed', 'missing'] as const) {
      outcome = kind;
      const before = calls.length;
      const error = await readCopiesCurrent({ data: address }).catch((caught: unknown) => caught);
      expect(calls).toHaveLength(before + 1);
      expect([Boolean(error), isPlatformClosedError(error)]).toEqual([true, kind === 'closed']);
    }

    outcome = 'transport';
    await expect(readCopiesCurrent({ data: address })).rejects.toThrow();
    expect(calls).toHaveLength(5);
  } finally {
    transport.mockRestore();
  }
});

test('point inspection keeps native closure, concealed denial and unavailable meanings', async () => {
  reset();
  const body = { code: 'platform_closed', detail: 'private problem body' };
  let reads = 0;
  const point = (get: () => Promise<unknown>, id = copyId) =>
    loadCopyDetail(
      { copies: () => ({ get: async () => (reads++, get()) }) } as unknown as KernelClient,
      currentRequest,
      sessionEnv,
      { id },
    );
  try {
    const returnedClosed = await point(async () => ({ status: 403, error: { value: body } }));
    expect(returnedClosed).toEqual({ ok: false, reason: 'closed' });
    expect(
      await point(async () => {
        throw new PlatformClosedError(403, body);
      }),
    ).toEqual({ ok: false, reason: 'closed' });
    for (const status of [401, 403, 404]) {
      expect(await point(async () => ({ status, error: { value: { code: 'concealed' } } }))).toEqual({
        ok: false,
        reason: 'forbidden',
      });
    }
    expect(await point(async () => ({ status: 200, data: { copy: { ...native, id: subjectId } } }))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    const beforeMalformed = reads;
    expect(await point(async () => ({}), 'not a valid id')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(reads).toBe(beforeMalformed);
    expect(
      await point(async () => {
        throw new Error('point transport failed');
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  } finally {
    currentRequest = request();
  }
});

test('the composed bounded list shares one preparation, native private reads keep transport policy and identity, and an inspected edit keeps exact CAS/key wire', async () => {
  reset();
  const calls: Request[] = [];
  let wrongSubject = false;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call.clone());
    const url = new URL(call.url);
    if (url.pathname === '/v1/copies') {
      if (url.searchParams.has('cursor')) return Response.json({ code: 'invalid_cursor' }, { status: 400 });
      return Response.json({ copies: [{ ...native, subject: null }], next: 'next-keyset-page' });
    }
    if (url.pathname === `/v1/subjects/${subjectId}`)
      return Response.json({
        subject: { id: wrongSubject ? copyId : subjectId, type: 'Book', labels: { en: 'Selected edition' } },
      });
    if (url.pathname === `/v1/copies/${copyId}`) {
      if (call.method === 'PATCH') return Response.json({ copy: { ...native, ...(await call.json()), revision: 13 } });
      return Response.json({ copy: { ...native, presentation } });
    }
    throw new Error(`Unexpected copy transport: ${call.method} ${url}`);
  });
  try {
    // A second preparation would actually refuse. The summary must use the list's successful preparation.
    refuseNextPreparation = true;
    const page = await readCopiesPage({ data: { subjectId, cursor: 'old/keyset+cursor' } });
    expect(page).toMatchObject({ signedIn: true, subjectId, next: 'next-keyset-page', csrfToken });
    expect(page.copies[0]?.subject).toMatchObject({ id: subjectId, label: 'Selected edition' });
    expect(page.profile?.kinds.map((kind) => kind.id)).toEqual(['print']);
    expect(counts).toEqual({ credential: 1, identity: 1, types: 2, release: 1 });
    expect(
      calls.map((call) => [new URL(call.url).pathname, Object.fromEntries(new URL(call.url).searchParams)]),
    ).toEqual([
      ['/v1/copies', { view: 'FULL', limit: '100', subjectId, cursor: 'old/keyset+cursor' }],
      ['/v1/copies', { view: 'FULL', limit: '100', subjectId }],
      [`/v1/subjects/${subjectId}`, {}],
    ]);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer current-viewer')).toBe(true);

    // An explicit credential without a session cookie is legitimate, for detail and both subject paths.
    currentRequest = request('GET', { authorization: 'Bearer explicit-viewer', 'accept-language': 'ja,en;q=0.8' });
    const detail = await readCopyDetail({ data: { id: copyId } });
    expect(detail).toMatchObject({ ok: true, copy: { ...presentation, id: copyId, revision: 12, subject: null } });
    expect(calls[3]!.headers.get('accept-language')).toBe('ja,en;q=0.8');
    expect(Object.fromEntries(new URL(calls[3]!.url).searchParams)).toEqual({ view: 'FULL', presentation: 'FULL' });
    expect(await readCopySubject({ data: subjectId })).toMatchObject({ state: 'ready', subject: { id: subjectId } });
    wrongSubject = true;
    const mismatched = await readCopiesPage({ data: { subjectId } });
    expect(mismatched.copies[0]?.subject).toBeNull();
    expect(mismatched.profile).toEqual({ kinds: [] });
    expect(JSON.stringify(mismatched)).not.toContain('Selected edition');
    expect(await readCopySubject({ data: subjectId })).toEqual({ state: 'unavailable' });
    expect(counts.credential).toBe(1);
    expect(calls.slice(3).every((call) => call.headers.get('authorization') === 'Bearer explicit-viewer')).toBe(true);

    if (!detail.ok) throw new Error('Expected the native detail for editing');
    currentRequest = request('POST');
    preparation = 'active';
    refuseNextPreparation = false;
    accessToken = 'current-edit-viewer';
    const note = ' Keep this exact note.\n第二行 ';
    expect(
      await updateCopy({
        data: {
          id: detail.copy.id,
          revision: detail.copy.revision,
          idempotencyKey: key,
          ...fields,
          note,
          ...copyStatusChange(detail.copy, 'loan'),
        },
      }),
    ).toMatchObject({ ok: true, copy: { id: copyId, revision: 13, status: 'loan', note } });
    const write = calls.at(-1)!;
    expect(write.method).toBe('PATCH');
    expect(write.headers.get('authorization')).toBe('Bearer current-edit-viewer');
    expect(write.headers.get('idempotency-key')).toBe(JSON.stringify(key));
    expect(await write.json()).toEqual({ revision: 12, ...fields, note, status: 'loan' });
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.method === 'GET')
        .every((call) => call.cache === 'no-store' && call.redirect === 'manual'),
    ).toBe(true);
    expect(counts.credential).toBe(2);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    transport.mockRestore();
  }
});
