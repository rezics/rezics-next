import { afterAll, expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as router from '@tanstack/react-router';
import {
  progressIndexAddress,
  progressSessionAddress,
  progressAddressIssue,
  correctProgressAddress,
  ProgressAddressError,
} from '../src/library/progress-address';
import { loadProgressIndex, loadProgressSession } from '../src/library/progress-reads';
import type { SessionEnv } from '../src/session/client';
import { m } from '../src/paraglide/messages.js';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const opaque = 'signed/position+without-decoding=';
const env = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => ({ status: 'active', accessToken: 'owner', subject: 'owner', csrfToken: null }),
    }),
  },
} as unknown as SessionEnv;
const request = () =>
  new Request('https://site.test/en/library/progress', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });

test('route and server address admission retain invalid operands and share native cursor bounds', () => {
  for (const malformed of ['', 123, null, ['page'], 'x'.repeat(4097), '\n']) {
    expect(progressAddressIssue(progressIndexAddress({ subjectId: id, cursor: malformed }))).toBe('cursor');
    for (const field of ['changes', 'units'])
      expect(progressAddressIssue(progressSessionAddress({ id, [field]: malformed }))).toBe(field);
  }
  expect(progressAddressIssue(progressIndexAddress({ subjectId: 'invalid' }))).toBe('subjectId');
  expect(progressAddressIssue(progressSessionAddress({ id: 'invalid' }))).toBe('id');
  expect(progressAddressIssue({ subjectId: id, cursor: 'x'.repeat(4096) })).toBeUndefined();
  expect(progressAddressIssue({ id, changes: opaque, units: opaque })).toBeUndefined();
  expect(progressAddressIssue(progressIndexAddress({}))).toBeUndefined();
  expect(progressAddressIssue(progressIndexAddress({ cursor: opaque }))).toBe('subjectId');
  expect(correctProgressAddress({ subjectId: id, cursor: 'invalid' }, 'cursor')).toEqual({ subjectId: id });
  expect(correctProgressAddress({ subjectId: 'invalid', cursor: opaque }, 'subjectId', id)).toEqual({
    subjectId: id,
    cursor: opaque,
  });
  expect(correctProgressAddress({ id, changes: 'bad', units: opaque, logs: opaque }, 'changes')).toEqual({
    id,
    units: opaque,
    logs: opaque,
  });
  expect(correctProgressAddress({ id, changes: opaque, units: 'bad', logs: opaque }, 'units', 'new')).toEqual({
    id,
    changes: opaque,
    units: 'new',
    logs: opaque,
  });
});

test('invalid input makes no native read; valid empty history, missing subjects and native cursor refusal differ', async () => {
  const calls: Request[] = [];
  let status = 200;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const body =
        status !== 200
          ? { code: status === 404 ? 'not_found' : 'invalid_cursor', status }
          : call.url.includes('/subjects/')
            ? { subject: { id, type: 'schema:Book' }, summary: { id, type: 'schema:Book', label: 'Book' } }
            : { progressSessions: [], next: null };
      return Response.json(body, { status });
    },
  });
  for (const input of [{ subjectId: 'invalid' }, { subjectId: '' }, { subjectId: id, cursor: 'x'.repeat(4097) }]) {
    expect((await loadProgressIndex(client, request(), env, input)).addressIssue).toBeDefined();
  }
  for (const input of [{ id: 'invalid' }, { id, changes: '' }, { id, units: 'x'.repeat(4097) }])
    await expect(loadProgressSession(client, request(), env, input)).rejects.toBeInstanceOf(ProgressAddressError);
  expect(calls).toHaveLength(0);
  const empty = await loadProgressIndex(client, request(), env, { subjectId: id });
  expect(empty).toMatchObject({ signedIn: true, sessions: [], selectedSubject: { id } });
  expect(empty.addressIssue).toBeUndefined();
  expect(calls[0]!.headers.has('x-csrf-token')).toBe(false);
  status = 404;
  expect((await loadProgressIndex(client, request(), env, { subjectId: id })).addressIssue).toBe('subjectId');
  status = 400;
  expect((await loadProgressIndex(client, request(), env, { subjectId: id, cursor: opaque })).addressIssue).toBe(
    'cursor',
  );
});

test('native stale history recovery resets only its own position', async () => {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      calls.push(url);
      if (url.pathname.endsWith('/changes'))
        return url.searchParams.has('cursor')
          ? Response.json({ code: 'stale_cursor', status: 409 }, { status: 409 })
          : Response.json({ changes: [], next: null });
      if (url.pathname.endsWith('/completedUnits')) return Response.json({ completedUnits: ['episode:7'], next: null });
      return Response.json({
        progressSession: { id, subjectId: id, mode: 'completed_units', unit: 'episode', state: 'active', revision: 1 },
      });
    },
  });
  const page = await loadProgressSession(client, request(), env, { id, changes: 'stale', units: opaque });
  expect(page).toMatchObject({ signedIn: true, unitsCursor: opaque, session: { changes: [], units: ['episode:7'] } });
  expect(page).not.toHaveProperty('changesCursor');
  expect(calls.filter((url) => url.pathname.endsWith('/changes')).map((url) => url.searchParams.get('cursor'))).toEqual(
    ['stale', null],
  );
  expect(
    calls.filter((url) => url.pathname.endsWith('/completedUnits')).map((url) => url.searchParams.get('cursor')),
  ).toEqual([opaque]);
});

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window();
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const navigations: unknown[] = [];
const routeSpy = spyOn(router, 'useRouter').mockReturnValue({
  navigate: (location: unknown) => {
    navigations.push(location);
    return Promise.resolve();
  },
} as unknown as ReturnType<typeof router.useRouter>);
const { ProgressAddressCorrection } = await import('../src/library/progress-address-correction');
afterAll(async () => {
  routeSpy.mockRestore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('explicit correction retains the independent requested histories and pending operands', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const address = { id, changes: 'invalid', units: opaque, logs: 'logs-position' };
  try {
    await act(async () => root.render(<ProgressAddressCorrection address={address} issue="changes" pending />));
    expect([...host.querySelectorAll('input')].map((input) => input.value)).toEqual([
      id,
      'invalid',
      opaque,
      'logs-position',
    ]);
    expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    expect(navigations).toHaveLength(0);
    await act(async () => root.render(<ProgressAddressCorrection address={address} issue="changes" />));
    expect(host.textContent).toContain(
      m.library_progress_address_invalid({ field: m.library_progress_address_changes() }),
    );
    const form = host.querySelectorAll('form')[1]!;
    await act(async () => (form.querySelector('button[type="button"]') as HTMLButtonElement).click());
    expect(navigations).toEqual([
      { to: '/library/progress/$id', params: { id }, search: { units: opaque, logs: 'logs-position' } },
    ]);
    expect(host.textContent).not.toContain(m.library_progress_empty());
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
