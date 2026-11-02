import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { loadMyPublishedLogs } from '../src/library/logs-read';
import { myLogsNavigation, myLogsResult, myLogsSearch } from '../src/library/my-logs';
import { resolveNavigation } from '../src/shell/navigation';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import recording from '../src/kernel/recorded/library-published-logs.json';

const authorization = 'Bearer current-owner-token';
const env = {
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.rezics.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        subject: 'actual-owner',
        accessToken: 'current-owner-token',
        csrfToken: 'A'.repeat(22),
      }),
    }),
  } as unknown as DurableObjectNamespace<SessionStore>,
} as Partial<SessionEnv>;
function request(signedIn = true) {
  return new Request(
    'https://site.example.test/en/library/logs',
    signedIn ? { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } } : {},
  );
}
function transport(reply: (url: URL, call: number) => Response) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      expect(call.method).toBe('GET');
      expect(call.headers.get('authorization')).toBe(authorization);
      const url = new URL(call.url);
      expect(url.pathname).toBe('/v1/publishedLogs');
      expect(url.searchParams.get('accountId')).toBe('actual-owner');
      expect(url.searchParams.get('view')).toBe('FULL');
      expect(url.searchParams.get('limit')).toBe('100');
      return reply(url, calls.length);
    },
  });
  return { client, calls };
}

test('canonical log and progress stories retain real owner plays and historic guards without width variants', () => {
  const logs = readFileSync(new URL('../src/stories/library-my-logs.stories.tsx', import.meta.url), 'utf8');
  expect([...logs.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'Owner',
    'Empty',
    'Long',
    'UnknownSubject',
    'Denied',
    'Unavailable',
    'Preparing',
    'NewestPage',
    'Restarted',
    'SignedOut',
  ]);
  expect(logs).toContain('export const Owner: Story = { render, play: ready }');
  expect(logs).toContain('return () => setMyLogsStory()');
  expect(logs).toContain('await ready(context)');
  expect(logs).not.toMatch(/viewport|maxWidth/);
  const progress = readFileSync(
    new URL('../src/stories/library-progress-session.stories.tsx', import.meta.url),
    'utf8',
  );
  expect([...progress.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'SignedIn',
    'ProfileUnits',
    'RetiredPair',
    'EmptyChanges',
    'LongContent',
    'Unavailable',
    'Error',
    'HistoricScalar',
    'SparseHistory',
    'OpaqueCursor',
    'UnresolvedUnit',
    'WithheldSummaries',
  ]);
  expect(progress).toContain('render: () => manualStory(manualScalarId)');
  expect(progress).toContain(
    "expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument()",
  );
  expect(progress).not.toMatch(/viewport|maxWidth/);
});

test('own explicit snapshots use current owner/FULL/opaque paging and preserve native null subjects without private progress fields', async () => {
  const original = recording.publishedLogs[0]!;
  const hidden = { ...original, id: 'hidden-log', subjectId: 'withheld-original-id', subject: null };
  const { client, calls } = transport((url) => {
    expect(url.searchParams.get('cursor')).toBe('signed+opaque/keyset=');
    return Response.json({ publishedLogs: [original, hidden], next: 'next-signed-cursor' });
  });
  const page = await myLogsResult(() =>
    loadMyPublishedLogs(
      client,
      request(),
      env,
      myLogsSearch({ cursor: 'signed+opaque/keyset=', accountId: 'someone-else' }),
    ),
  );
  expect(page.state).toBe('loaded');
  if (page.state !== 'loaded') throw new Error('Expected successful owner history');
  expect(page.logs[0]).toMatchObject({
    sessionState: original.sessionState,
    note: original.note,
    startedAt: original.startedAt,
    completedAt: original.completedAt,
    publishedAt: original.publishedAt,
  });
  expect(page.logs[0]!.subject?.cover).toEqual(original.subject.cover);
  expect(page.logs[1]!.subject).toBeNull();
  expect(page.next).toBe('next-signed-cursor');
  expect(JSON.stringify(page)).not.toMatch(
    /withheld-original-id|subjectId|accountId|completedUnitCount|sessionId|changes|total/,
  );
  expect(calls).toHaveLength(1);
});

test('only successful empty reads are empty; signed-out, denied, preparing and unavailable stay distinct', async () => {
  for (const [status, body, state] of [
    [200, { publishedLogs: [], next: null }, 'loaded'],
    [401, { code: 'invalid_credentials' }, 'denied'],
    [403, { code: 'forbidden' }, 'denied'],
    [404, { code: 'not_found' }, 'denied'],
    [202, { preparing: true }, 'preparing'],
    [503, { code: 'dependency_unavailable' }, 'unavailable'],
    [200, {}, 'unavailable'],
  ] as const) {
    const { client } = transport(() => Response.json(body, { status }));
    const result = await myLogsResult(() => loadMyPublishedLogs(client, request(), env, {}));
    expect(result.state).toBe(state);
    if (result.state !== 'loaded') expect(result).not.toHaveProperty('logs');
  }
  const { client, calls } = transport(() => {
    throw new Error('No anonymous history request');
  });
  expect(await myLogsResult(() => loadMyPublishedLogs(client, request(false), env, {}))).toEqual({
    state: 'signed-out',
  });
  expect(calls).toHaveLength(0);
});

test('native stale epoch restarts once at the newest page; a failed restart remains unavailable', async () => {
  for (const fails of [false, true]) {
    const { client, calls } = transport((url, call) => {
      if (call === 1) {
        expect(url.searchParams.get('cursor')).toBe('old-epoch');
        return Response.json({ code: 'stale_cursor' }, { status: 409 });
      }
      expect(url.searchParams.has('cursor')).toBe(false);
      return fails
        ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
        : Response.json({ publishedLogs: recording.publishedLogs, next: null });
    });
    const result = await myLogsResult(() => loadMyPublishedLogs(client, request(), env, { cursor: 'old-epoch' }));
    expect(result).toMatchObject(fails ? { state: 'unavailable' } : { state: 'loaded', restarted: true });
    expect(calls).toHaveLength(2);
  }
});

test('personal route and navigation use existing signed-in/no-store authority, localized detail links and no parallel writes', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const route = source('../src/routes/library/logs.tsx');
  expect(route).toContain('beforeLoad: requireSignedIn');
  expect(route).toContain('loaderDeps:');
  expect(route).toContain('readMyPublishedLogHistory');
  expect(route).toContain("robots: 'noindex, nofollow'");
  const server = source('../src/library/logs-server.ts');
  expect(server).toContain("setResponseHeader('cache-control', 'private, no-store')");
  expect(server).toContain('myLogsResult(() => readMyPublishedLogs({ data }))');
  const page = source('../src/library/my-logs-page.tsx');
  expect(page).toContain('/logs/${encodeURIComponent(log.id)}');
  expect(page).not.toMatch(/removePublishedLog|restorePublishedLog|progress\/|completedUnitCount/);
  expect(myLogsSearch({ accountId: 'foreign', publisher: 'foreign' })).toEqual({});
  expect(myLogsSearch({ cursor: 'a'.repeat(4097) })).toEqual({ invalidPosition: true });
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
    const [entry] = resolveNavigation(myLogsNavigation, { locale, pathname: `/${locale}/library/logs` });
    expect(entry).toMatchObject({
      signedIn: true,
      operation: 'published_log.list',
      current: true,
      href: `/${locale}/library/logs`,
    });
    const messages = JSON.parse(source(`../messages/${locale}.json`));
    expect(messages.library_my_logs_heading).toBeTruthy();
    expect(messages.library_my_logs_read).toContain('{title}');
  }
});
