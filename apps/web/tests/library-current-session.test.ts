import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { SessionEnv } from '../src/session/client';
import { newCsrfToken } from '../src/session/csrf';
import { prepareSession, viewerCredential } from '../src/session/request';
import {
  changePersonalLibraryEntry,
  loadPersonalLibrary,
  readEntryPage,
  removePersonalLibraryEntry,
  restorePersonalLibraryEntry,
} from '../src/library/entries-read';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
const { loadShelfTypes } = await import('../src/library/shelf-types-read');
const { libraryEntryFormResponse } = await import('../src/library/entry-form');

const origin = 'https://site.test';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const deletionId = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const idempotencyKey = '10203040-5060-4070-8090-102030405060';
const entry = {
  subjectId,
  incarnationId,
  state: 'reading.arc-1',
  revision: 7,
  createdAt: '2026-04-02T15:04:05.000Z',
  updatedAt: '2026-04-03T15:04:05.000Z',
  subject: { id: subjectId, type: 'schema:Book', label: 'Current book' },
};
const change = { subjectId, incarnationId, revision: 7, state: entry.state, idempotencyKey };
const undo = { subjectId, deletionId, revision: 8, idempotencyKey };
const sort = { orderBy: 'finishedAt', direction: 'asc' } as const;

function session() {
  let status: 'active' | 'absent' | 'unavailable' = 'active';
  let reads = 0;
  let accessToken = 'current-viewer';
  let subject = 'owner';
  const csrfToken = newCsrfToken();
  const env = {
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
          reads++;
          return status === 'active' ? { status, accessToken, subject, csrfToken } : { status, csrfToken };
        },
      }),
    },
  } as unknown as Partial<SessionEnv>;
  return {
    env,
    csrfToken,
    get reads() {
      return reads;
    },
    renew(token: string, viewer = subject) {
      accessToken = token;
      subject = viewer;
    },
    setStatus(value: typeof status) {
      status = value;
    },
    request(form?: Record<string, string>) {
      return new Request(`${origin}/library/entry`, {
        method: form ? 'POST' : 'GET',
        headers: {
          cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
          origin,
          'x-csrf-token': csrfToken,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams({ ...form, csrf_token: csrfToken, locale: 'en' }) } : {}),
      });
    },
  };
}

const removeForm = {
  intent: 'remove',
  subjectId,
  incarnationId,
  revision: '7',
  idempotencyKey,
  returnTo: '/en/library?state=reading.arc-1',
};

// These focused transport regressions use real session preparation and generated-client exports.
// Native authority, browser and integration acceptance are separate controller obligations.
test('refused current preparation never uses a cached Library credential, including mutations and native forms', async () => {
  const current = session();
  let privateCalls = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async () => {
      privateCalls++;
      throw new Error('Refused Library preparation reached private IO');
    }) as typeof fetch,
  });
  const request = current.request();
  expect(await prepareSession(request, current.env)).toBe(false);
  expect(viewerCredential(request)).toBe('Bearer current-viewer');
  current.setStatus('absent');
  expect(await prepareSession(request, current.env)).toBe(true);
  expect(await loadPersonalLibrary(client, request, current.env, {})).toEqual({ signedIn: false });
  expect(await loadShelfTypes(client, request, current.env, {})).toEqual({ state: 'signed-out' });
  for (const result of [
    await changePersonalLibraryEntry(client, request, current.env, change),
    await removePersonalLibraryEntry(client, request, current.env, change),
    await restorePersonalLibraryEntry(client, request, current.env, undo),
  ])
    expect(result).toEqual({ ok: false, reason: 'signed-out' });
  expect(viewerCredential(request)).toBe('Bearer current-viewer');

  // Unsafe requests retain the real CSRF/session refusal, before exposure or any command.
  current.setStatus('active');
  const form = current.request(removeForm);
  expect(await prepareSession(form, current.env)).toBe(false);
  current.setStatus('absent');
  const forbidden = await libraryEntryFormResponse(form, current.env, client);
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({ code: 'forbidden' });
  expect(await removePersonalLibraryEntry(client, form, current.env, change)).toEqual({
    ok: false,
    reason: 'unavailable',
  });

  current.setStatus('unavailable');
  await expect(loadPersonalLibrary(client, request, current.env, {})).rejects.toMatchObject({
    problem: { status: 502, code: 'dependency_unavailable' },
  });
  expect(await loadShelfTypes(client, request, current.env, {})).toEqual({ state: 'unavailable' });
  expect(await changePersonalLibraryEntry(client, request, current.env, change)).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect((await libraryEntryFormResponse(current.request(removeForm), current.env, client)).status).toBe(502);
  current.setStatus('active');
  for (const header of ['origin', 'x-csrf-token']) {
    const invalid = current.request(removeForm);
    invalid.headers.set(header, 'invalid');
    expect((await libraryEntryFormResponse(invalid, current.env, client)).status).toBe(403);
  }
  expect(privateCalls).toBe(0);
});

test('current credentials keep bounded keyset reads, restrictive transport, exact CAS, receipt Undo and one form preparation usable', async () => {
  const calls: Request[] = [];
  let failure: { status: number; code: string } | undefined;
  let conflict = false;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      const url = new URL(request.url);
      if (failure) return Response.json({ code: failure.code }, { status: failure.status });
      if (url.pathname === '/v1/libraryEntries') {
        if (url.searchParams.get('cursor') === 'stale/keyset+cursor')
          return Response.json({ code: 'invalid_cursor' }, { status: 400 });
        return Response.json({ libraryEntries: [entry], next: 'signed/next+cursor' });
      }
      if (url.pathname === '/v1/libraryShelfTypes')
        return Response.json({ types: [{ type: 'schema:Book', count: 1 }], next: 'signed/types+cursor' });
      if (url.pathname === '/v1/platform/exposure')
        return Response.json({ admitted: ['personal_library', 'library_entry.restore'] });
      if (request.method === 'GET') return Response.json({ libraryEntry: entry });
      if (conflict)
        return Response.json(
          { code: url.pathname.endsWith(':restore') ? 'library_entry_restore_occupied' : 'revision_conflict' },
          { status: 409 },
        );
      if (request.method === 'DELETE')
        return new Response(null, {
          status: 204,
          headers: { 'Library-Entry-Deletion-Id': deletionId, 'Library-Entry-Deletion-Revision': '8' },
        });
      return Response.json({ libraryEntry: { ...entry, revision: 9 } });
    }) as typeof fetch,
  });
  const explicit = new Request(`${origin}/en/library`, { headers: { authorization: 'Bearer explicit-viewer' } });
  const selected = { type: 'schema:Book', state: entry.state, ...sort };
  const page = await loadPersonalLibrary(client, explicit, {}, { ...selected, cursor: 'stale/keyset+cursor' });
  expect(page).toMatchObject({
    signedIn: true,
    cursorReset: true,
    type: selected.type,
    state: entry.state,
    sort,
    next: 'signed/next+cursor',
  });
  expect(calls).toHaveLength(2);
  expect(Object.fromEntries(new URL(calls[1]!.url).searchParams)).toEqual({ view: 'FULL', limit: '20', ...selected });
  await readEntryPage(client, 'Bearer explicit-viewer', 'signed/next+cursor', entry.state, 20, sort, selected.type);
  expect(Object.fromEntries(new URL(calls[2]!.url).searchParams)).toEqual({
    view: 'FULL',
    limit: '20',
    cursor: 'signed/next+cursor',
    ...selected,
  });
  expect(await loadShelfTypes(client, explicit, {}, { cursor: 'signed/types+cursor' })).toEqual({
    state: 'loaded',
    types: [{ type: 'schema:Book' }],
    next: 'signed/types+cursor',
  });
  expect(Object.fromEntries(new URL(calls[3]!.url).searchParams)).toEqual({
    limit: '20',
    cursor: 'signed/types+cursor',
  });
  expect(await changePersonalLibraryEntry(client, explicit, {}, change)).toMatchObject({
    ok: true,
    entry: { revision: 9 },
  });
  expect(await calls[4]!.json()).toEqual({ state: entry.state, revision: 7, incarnationId });
  expect(calls[4]!.headers.get('idempotency-key')).toBe(idempotencyKey);
  const removed = await removePersonalLibraryEntry(client, explicit, {}, change);
  expect(removed).toMatchObject({ ok: true, undo: { deletionId, revision: 8 } });
  expect(Object.fromEntries(new URL(calls[5]!.url).searchParams)).toEqual({ revision: '7', incarnationId });
  expect(calls[5]!.headers.get('idempotency-key')).toBe(idempotencyKey);
  expect(await restorePersonalLibraryEntry(client, explicit, {}, undo)).toMatchObject({
    ok: true,
    entry: { revision: 9 },
  });
  expect(await calls[6]!.json()).toEqual({ deletionId, revision: 8 });
  expect(calls[6]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);

  conflict = true;
  expect(await changePersonalLibraryEntry(client, explicit, {}, change)).toMatchObject({
    reason: 'conflict',
    entry: { revision: 7 },
  });
  expect(await removePersonalLibraryEntry(client, explicit, {}, change)).toMatchObject({
    reason: 'conflict',
    entry: { revision: 7 },
  });
  expect(await restorePersonalLibraryEntry(client, explicit, {}, undo)).toMatchObject({
    reason: 'occupied',
    entry: { revision: 7 },
  });
  expect(calls.filter((call) => call.method === 'GET' && new URL(call.url).pathname.endsWith(subjectId))).toHaveLength(
    3,
  );
  conflict = false;
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer explicit-viewer')).toBe(true);

  const current = session();
  const formStart = calls.length;
  const response = await libraryEntryFormResponse(current.request(removeForm), current.env, client);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const html = await response.text();
  expect(html).toContain(`name="deletionId" value="${deletionId}"`);
  expect(html).toContain('name="revision" value="8"');
  expect(current.reads).toBe(1);
  expect(calls.slice(formStart).map((call) => call.method)).toEqual(['GET', 'DELETE']);
  const restored = await libraryEntryFormResponse(
    current.request({ intent: 'restore', subjectId, deletionId, revision: '8', idempotencyKey }),
    current.env,
    client,
  );
  expect(restored.status).toBe(200);
  expect(await restored.text()).toContain('data-entry-revision="9"');
  expect(current.reads).toBe(2);
  expect(await calls.at(-1)!.json()).toEqual({ deletionId, revision: 8 });
  expect(calls.slice(formStart).every((call) => call.headers.get('authorization') === 'Bearer current-viewer')).toBe(
    true,
  );
  expect(
    calls
      .filter((call) => call.method === 'GET')
      .every((call) => call.cache === 'no-store' && call.redirect === 'manual'),
  ).toBe(true);

  for (const [status, code, readState] of [
    [403, 'forbidden', 'denied'],
    [403, 'platform_closed', 'closed'],
    [503, 'dependency_unavailable', 'preparing'],
    [503, 'unavailable', 'unavailable'],
  ] as const) {
    failure = { status, code };
    expect(await loadPersonalLibrary(client, explicit, {}, selected)).toMatchObject({
      signedIn: true,
      readState,
      entries: [],
      next: null,
    });
    expect(await loadShelfTypes(client, explicit, {}, {})).toEqual({ state: readState });
  }
});

test('script-free restore keeps original native credentials through renewal and current admission gates replay', async () => {
  const current = session();
  let admitted = true;
  const writes: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const call = new Request(input, init);
      if (call.url.endsWith('/platform/exposure'))
        return Response.json({ admitted: admitted ? ['library_entry.delete', 'library_entry.restore'] : [] });
      if (call.method === 'DELETE')
        return new Response(null, {
          status: 204,
          headers: {
            'Library-Entry-Deletion-Id': deletionId,
            'Library-Entry-Deletion-Revision': '8',
          },
        });
      writes.push(call.clone());
      if (writes.length === 1) throw new Error('Lost restore acknowledgement');
      return Response.json({ libraryEntry: entry });
    }) as typeof fetch,
  });
  const fields = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
    );
  const removed = fields(
    await (await libraryEntryFormResponse(current.request(removeForm), current.env, client)).text(),
  );
  expect(removed.idempotencyKey).not.toBe(idempotencyKey);
  expect(removed.credential).toBeTruthy();
  const first = await libraryEntryFormResponse(current.request(removed), current.env, client);
  const retry = fields(await first.text());
  expect(retry).toEqual(removed);
  current.renew('renewed-viewer');
  admitted = false;
  expect((await libraryEntryFormResponse(current.request(retry), current.env, client)).status).toBe(403);
  expect(writes).toHaveLength(1);
  admitted = true;
  const restored = await libraryEntryFormResponse(current.request(retry), current.env, client);
  expect(await restored.text()).toContain('data-restored-entry');
  expect(writes[1]!.headers.get('authorization')).toBe('Bearer current-viewer');
  expect([...writes[1]!.headers]).toEqual([...writes[0]!.headers]);
  expect(await writes[1]!.text()).toBe(await writes[0]!.text());
  current.renew('foreign-viewer', 'another-owner');
  expect((await libraryEntryFormResponse(current.request(retry), current.env, client)).status).toBe(403);
  expect(writes).toHaveLength(2);
});
