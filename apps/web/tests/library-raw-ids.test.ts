import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { m } from '../src/paraglide/messages.js';
import fixtures from '../src/kernel/fixtures.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import { answerFakeRoute } from '../src/kernel/fake-modules.ts';
import { loadCopiesPage, removeCopy, submitCopy } from '../src/library/copies-read';
import {
  changePersonalLibraryEntry,
  loadPersonalLibrary,
  removePersonalLibraryEntry,
} from '../src/library/entries-read';
import { progressView } from '../src/library/progress-label';
import { loadProgressIndex, startProgress } from '../src/library/progress-reads';
import { loadSubjectLibrarySlot } from '../src/library/subject-slot';
import * as copiesRead from '../src/library/copies-read';
import * as entriesRead from '../src/library/entries-read';
import * as subjectSlot from '../src/library/subject-slot';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const copyId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const unknownState = 'profile-reading-state';
const unknownStatus = 'profile-copy-condition';
const unknownUnit = 'profile-reading-measure';
const stamp = '2026-04-02T15:04:05.000Z';
const entryRecord = {
  subjectId,
  state: unknownState,
  revision: 3,
  createdAt: stamp,
  updatedAt: stamp,
  subject: { id: subjectId, type: 'book', label: 'Night watch' },
};
const copyRecord = {
  id: copyId,
  subjectId,
  status: unknownStatus,
  revision: 2,
  location: null,
  source: null,
  acquiredOn: null,
  disposedOn: null,
  note: null,
  subject: { id: subjectId, type: 'book', label: 'Night watch' },
};
const progressRecord = {
  id: sessionId,
  subjectId,
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: unknownUnit,
  total: '10',
  amount: '3',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 1,
  startedAt: stamp,
  completedAt: null,
  subject: { id: subjectId, type: 'book', label: 'Night watch' },
  versionSubject: null,
};

test('library reads keep unknown IDs, render neutral labels, and retain their existing write requests', async () => {
  const calls: { method: string; path: string; query: string; body: unknown; key: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = ['GET', 'DELETE'].includes(request.method)
      ? null
      : await request
          .clone()
          .json()
          .catch(() => null);
    calls.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      body,
      key: request.headers.get('idempotency-key'),
    });
    if (url.pathname === '/v1/libraryEntries' && request.method === 'GET')
      return Response.json({ libraryEntries: [entryRecord], next: null });
    if (url.pathname === `/v1/libraryEntries/${subjectId}` && request.method === 'GET')
      return Response.json({ libraryEntry: entryRecord });
    if (url.pathname === `/v1/libraryEntries/${subjectId}` && request.method === 'PUT')
      return Response.json({ libraryEntry: { ...entryRecord, state: (body as { state: string }).state, revision: 4 } });
    if (url.pathname === `/v1/libraryEntries/${subjectId}` && request.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.pathname === '/v1/copies' && request.method === 'GET')
      return Response.json({ copies: [copyRecord], next: null });
    if (url.pathname === '/v1/copies' && request.method === 'POST')
      return Response.json({ copy: { ...copyRecord, ...(body as object), id: copyId, revision: 1 } }, { status: 201 });
    if (url.pathname === `/v1/copies/${copyId}` && request.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.pathname === '/v1/progressSessions' && request.method === 'GET')
      return Response.json({ progressSessions: [progressRecord], next: null });
    if (url.pathname === '/v1/progressSessions' && request.method === 'POST')
      return Response.json(
        { progressSession: { ...progressRecord, unit: (body as { unit: string }).unit } },
        { status: 201 },
      );
    if (url.pathname === `/v1/subjects/${subjectId}/collections` && request.method === 'GET')
      return Response.json({ collections: [], next: null });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const client = createKernelClient('https://kernel.test', { fetch: fetcher });
  const request = new Request('https://web.test/en/library', {
    headers: {
      authorization: 'Bearer viewer-token',
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
    },
  });

  const entries = await loadPersonalLibrary(client, request, {}, { state: 'planned' });
  expect(entries.signedIn && entries.state !== null ? entries.entries : []).toMatchObject([{ state: unknownState }]);
  expect(entries.signedIn && entries.state !== null ? entries.entries[0]?.subject?.label : undefined).toBe(
    'Night watch',
  );

  const copies = await loadCopiesPage(client, request, {}, {});
  expect(copies.copies).toMatchObject([{ id: copyId, status: unknownStatus }]);

  const progress = await loadProgressIndex(client, request, {}, { subjectId });
  expect(progress.sessions).toMatchObject([{ id: sessionId, unit: unknownUnit }]);

  const slotEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'reader',
          csrfToken: 'csrf',
          accessToken: 'viewer-token',
        }),
      }),
    },
  } as never;
  const slot = await loadSubjectLibrarySlot(client, request, slotEnv, subjectId);
  expect(slot.entry).toMatchObject({ subjectId, state: unknownState, revision: 3 });

  const entryStateLabel = (entriesRead as unknown as { libraryEntryStateLabel?: (state: string) => string })
    .libraryEntryStateLabel;
  expect(entryStateLabel?.(unknownState)).toBe('Other');
  expect(entryStateLabel?.('planned')).toBe(m.library_state_planned());
  const copyStatusLabel = (copiesRead as unknown as { copyStatusLabel?: (status: string) => string }).copyStatusLabel;
  expect(copyStatusLabel?.(unknownStatus)).toBe('Other');
  expect(copyStatusLabel?.('owned')).toBe(m.library_copy_status_owned());
  const slotStateLabel = (subjectSlot as unknown as { subjectSlotStateLabel?: (state: string) => string })
    .subjectSlotStateLabel;
  expect(slotStateLabel?.(unknownState)).toBe('Other');
  expect(slotStateLabel?.('planned')).toBe(m.library_subject_state_planned());
  expect(
    progressView(
      {
        mode: 'scalar_amount',
        unit: unknownUnit,
        amount: '3',
        total: '10',
        completedUnitCount: 0,
        locator: null,
      },
      'en',
    )?.text,
  ).toBe('Other');
  expect(
    progressView(
      { mode: 'scalar_amount', unit: 'page', amount: '3', total: '10', completedUnitCount: 0, locator: null },
      'en',
    )?.text,
  ).toBe(m.home_continue_page_of({ amount: '3', total: '10' }, { locale: 'en' }));

  expect(
    (await removePersonalLibraryEntry(client, request, {}, { subjectId, revision: 3, idempotencyKey: copyId })).ok,
  ).toBe(true);
  expect((await removeCopy(client, request, {}, { id: copyId, revision: 2, idempotencyKey: sessionId })).ok).toBe(true);

  expect(
    await changePersonalLibraryEntry(
      client,
      request,
      {},
      {
        subjectId,
        state: 'completed',
        revision: 3,
        idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000015',
      },
    ),
  ).toMatchObject({ ok: true });
  expect(
    await startProgress(
      client,
      request,
      {},
      {
        subjectId,
        mode: 'scalar_amount',
        unit: 'page',
        total: '10',
        idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000016',
      },
    ),
  ).toMatchObject({ ok: true, id: sessionId });
  expect(
    await submitCopy(
      client,
      request,
      {},
      {
        subjectId,
        status: 'owned',
        location: null,
        source: null,
        acquiredOn: null,
        disposedOn: null,
        note: null,
        idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000017',
      },
    ),
  ).toMatchObject({ ok: true });

  expect(calls.find((call) => call.method === 'PUT' && call.path === `/v1/libraryEntries/${subjectId}`)).toMatchObject({
    query: '',
    body: { state: 'completed', revision: 3 },
    key: '0192f3a0-6c1e-7b2a-9d4e-000000000015',
  });
  expect(calls.find((call) => call.method === 'POST' && call.path === '/v1/progressSessions')).toMatchObject({
    body: { subjectId, mode: 'scalar_amount', unit: 'page', total: '10' },
    key: '0192f3a0-6c1e-7b2a-9d4e-000000000016',
  });
  expect(calls.find((call) => call.method === 'POST' && call.path === '/v1/copies')).toMatchObject({
    body: {
      subjectId,
      status: 'owned',
      location: null,
      source: null,
      acquiredOn: null,
      disposedOn: null,
      note: null,
    },
    key: '0192f3a0-6c1e-7b2a-9d4e-000000000017',
  });
  expect(calls.find((call) => call.method === 'DELETE' && call.path === `/v1/libraryEntries/${subjectId}`)?.query).toBe(
    '?revision=3',
  );
  expect(calls.find((call) => call.method === 'DELETE' && call.path === `/v1/copies/${copyId}`)?.query).toBe(
    '?revision=2',
  );
});

test('the neutral Other message exists in every supported locale', () => {
  const app = join(import.meta.dir, '..');
  for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const messages = JSON.parse(readFileSync(join(app, `messages/${locale}.json`), 'utf8')) as Record<string, string>;
    expect(messages.library_other, locale).toBeString();
    expect(messages.library_other.length, locale).toBeGreaterThan(0);
  }
});

test('the registered fake kernel route returns unknown IDs for entries, copies, progress, and the subject slot', async () => {
  const fake = createFakeKernelFetch(fixtures as never);
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set('x-rezics-library-raw-ids', '1');
      return fake(new Request(request, { headers }));
    }) as typeof fetch,
  });
  const request = new Request('https://web.test/en/library', {
    headers: { authorization: 'Bearer viewer-token' },
  });
  const entries = await loadPersonalLibrary(client, request, {}, { state: 'planned' });
  const copies = await loadCopiesPage(client, request, {}, {});
  const progress = await loadProgressIndex(client, request, {}, { subjectId });
  const slotEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'reader',
          csrfToken: 'csrf',
          accessToken: 'viewer-token',
        }),
      }),
    },
  } as never;
  const slotRequest = new Request('https://web.test/en/subjects/example', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  const slot = await loadSubjectLibrarySlot(client, slotRequest, slotEnv, subjectId);

  expect(entries.signedIn && entries.state !== null ? entries.entries[0]?.state : undefined).toBe(unknownState);
  expect(copies.copies[0]?.status).toBe(unknownStatus);
  expect(progress.sessions[0]?.unit).toBe(unknownUnit);
  expect(slot.entry?.state).toBe(unknownState);

  const unmarked = await answerFakeRoute(
    'fixture',
    new Request('https://kernel.test/v1/libraryEntries?view=FULL&limit=48&state=planned'),
    undefined,
    fixtures as never,
  );
  expect(unmarked).toBeUndefined();
});
