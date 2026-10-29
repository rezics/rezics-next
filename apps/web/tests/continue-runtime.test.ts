import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadContinue } from '../src/library/continue-read.ts';
import type { SessionEnv } from '../src/session/client.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import type { SessionStore } from '../src/session/store.ts';

const sessionCookie = 'c'.repeat(43);
const csrf = newCsrfToken();
const subjects: {
  subjectId: string;
  state: string | null;
  activeProgressSession: ReturnType<typeof session> | null;
}[] = [
  { subjectId: 'active-without-entry', state: null, activeProgressSession: session('session-a') },
  { subjectId: 'known-state', state: 'in_progress', activeProgressSession: null },
  { subjectId: 'unknown-state', state: 'custom-state', activeProgressSession: null },
  { subjectId: 'null-state', state: null, activeProgressSession: null },
];

function session(id: string) {
  return {
    id,
    subjectId: 'active-without-entry',
    versionSubjectId: 'active-without-entry',
    mode: 'scalar_amount',
    unit: 'episode',
    total: '12',
    amount: '3',
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 1,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
  };
}

function makeEnv() {
  const stub = {
    async signedIn() {
      return { signedIn: true, subject: 'reader', csrfToken: csrf };
    },
    async credential() {
      return { status: 'active' as const, subject: 'reader', accessToken: 'fresh-token', csrfToken: csrf };
    },
    async create() {},
    async takeLogin() {},
    async end() {},
  };
  return {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-web-continue-test',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SITE_ORIGINS: 'https://site.example.test',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
}

function request(signedIn = true) {
  return new Request('https://site.example.test/en', {
    ...(signedIn ? { headers: { cookie: `__Host-rezics_session=${sessionCookie}` } } : {}),
  });
}

function clientFor(rows: typeof subjects = subjects, options: { failContinue?: boolean; missingHeader?: string } = {}) {
  const calls: { operation: string; input?: unknown; authorization?: string }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/v1/libraryContinue') {
        calls.push({
          operation: 'continue',
          input: { query: { limit: Number(url.searchParams.get('limit')) } },
          authorization: request.headers.get('authorization') ?? undefined,
        });
        return options.failContinue
          ? Response.json({ code: 'service_unavailable' }, { status: 503 })
          : Response.json({ subjects: rows, next: null });
      }
      if (url.pathname === '/v1/pages:read' && request.method === 'POST') {
        const input = (await request.json()) as { reads: Record<string, { kind: 'subject'; id: string }> };
        calls.push({
          operation: 'pages',
          input,
          authorization: request.headers.get('authorization') ?? undefined,
        });
        return Response.json({
          reads: Object.fromEntries(
            Object.entries(input.reads).map(([key, descriptor]) => [
              key,
              descriptor.id === options.missingHeader
                ? { status: 404 }
                : {
                    status: 200,
                    body: {
                      subject: {
                        id: descriptor.id,
                        type: 'book',
                        types: ['book'],
                        label: { value: `Title ${descriptor.id}`, language: 'en' },
                        cover: null,
                      },
                    },
                  },
            ]),
          ),
        });
      }
      throw new Error(`unexpected fake kernel request: ${request.method} ${url.pathname}`);
    }) as typeof fetch,
  });
  return { client, calls };
}

test('Continue reads its ordered subjects, including an active session without a library entry', async () => {
  const { client, calls } = clientFor();
  const result = await loadContinue(client, request(), makeEnv());

  expect(result.map((entry) => entry.subjectId)).toEqual(subjects.map((row) => row.subjectId));
  expect(result[0]?.summary).toMatchObject({ id: 'active-without-entry', type: 'book', types: ['book'], cover: null });
  expect(result[0]?.label).toBe('Title active-without-entry');
  expect(result[0]?.progress).toMatchObject({ sessionId: 'session-a', mode: 'scalar_amount', amount: '3' });
  expect(calls.map((call) => call.operation)).toEqual(['continue', 'pages']);
  expect(calls[0]).toMatchObject({ input: { query: { limit: 6 } }, authorization: 'Bearer fresh-token' });
  expect(calls[1]).toMatchObject({
    input: {
      headers: { authorization: 'Bearer fresh-token' },
      reads: Object.fromEntries(
        subjects.map(({ subjectId }) => [`subject:${subjectId}`, { kind: 'subject', id: subjectId }]),
      ),
    },
  });
});

test('progress comes from Continue and each returned subject gets one batched header read', async () => {
  const { client, calls } = clientFor();
  const result = await loadContinue(client, request(), makeEnv());

  expect(result[0]?.progress).toEqual({
    sessionId: 'session-a',
    mode: 'scalar_amount',
    unit: 'episode',
    amount: '3',
    total: '12',
    completedUnitCount: 0,
    locator: null,
  });
  expect(calls.filter((call) => call.operation)).toHaveLength(2);
  expect(calls.some((call) => call.operation === 'progress')).toBe(false);
  expect(calls.some((call) => call.operation === 'entries')).toBe(false);
  expect(calls[1]?.input).toMatchObject({
    reads: Object.fromEntries(
      subjects.map(({ subjectId }) => [`subject:${subjectId}`, { kind: 'subject', id: subjectId }]),
    ),
  });
});

test('a subject whose batched header read is missing is omitted', async () => {
  const { client } = clientFor(subjects, { missingHeader: 'unknown-state' });
  const result = await loadContinue(client, request(), makeEnv());
  expect(result.map((entry) => entry.subjectId)).toEqual(['active-without-entry', 'known-state', 'null-state']);
});

test('state labels are emitted only for known state IDs', async () => {
  const { client } = clientFor();
  const result = await loadContinue(client, request(), makeEnv());
  expect(result.find((entry) => entry.subjectId === 'known-state')?.stateLabel).toBeDefined();
  expect(result.find((entry) => entry.subjectId === 'unknown-state')?.stateLabel).toBeUndefined();
  expect(result.find((entry) => entry.subjectId === 'null-state')?.stateLabel).toBeUndefined();
});

test('a failed Continue read, including 503, leaves the row empty', async () => {
  const { client, calls } = clientFor(subjects, { failContinue: true });
  expect(await loadContinue(client, request(), makeEnv())).toEqual([]);
  expect(calls.map((call) => call.operation)).toEqual(['continue']);
});

test('a signed-out home makes no Continue read', async () => {
  const { client, calls } = clientFor();
  expect(await loadContinue(client, request(false), makeEnv())).toEqual([]);
  expect(calls).toEqual([]);
});

test('the row makes at most two kernel reads per view, none of them per subject, with 0, 6 and 300 subjects in progress', async () => {
  for (const size of [0, 6, 300]) {
    const rows = Array.from({ length: size }, (_, index) => ({
      subjectId: `subject-${index}`,
      state: null,
      activeProgressSession: session(`session-${index}`),
    }));
    const { client, calls } = clientFor(rows);
    const result = await loadContinue(client, request(), makeEnv());
    expect(result).toHaveLength(Math.min(size, 6));
    expect(calls.map((call) => call.operation)).toEqual(size === 0 ? ['continue'] : ['continue', 'pages']);
    if (calls[0]?.operation === 'continue') expect(calls[0].input).toMatchObject({ query: { limit: 6 } });
    if (calls[1]?.operation === 'pages')
      expect(calls[1].input).toMatchObject({
        reads: Object.fromEntries(
          rows.slice(0, 6).map(({ subjectId }) => [`subject:${subjectId}`, { kind: 'subject', id: subjectId }]),
        ),
      });
  }
});
