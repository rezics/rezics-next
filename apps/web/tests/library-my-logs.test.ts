import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { QueryClient } from '@tanstack/react-query';
import { loadMyPublishedLogs } from '../src/library/logs-read';
import { myLogsNavigation, myLogsResult, myLogsSearch } from '../src/library/my-logs';
import {
  MyLogsWindowNavigation,
  myLogsWindowHrefs,
  myLogsWindowNavigation,
} from '../src/library/my-logs-window-navigation';
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
    'ContinuedIndexReturn',
    'ProfileUnitsRecordingUnavailable',
    'DeclaredRecordingRefused',
    'RetiredPair',
    'EmptyChanges',
    'LongContent',
    'OriginalHistoryUnknownMeaning',
    'CompletedAmountHistory',
    'Unavailable',
    'Error',
    'HistoricScalar',
    'SparseHistory',
    'OpaqueCursor',
    'UnresolvedUnit',
    'WithheldSummaries',
    'OriginalHistoryRoute',
    'IndependentHistoryRecovery',
    'OriginalCursorHistoryRoute',
    'StaleChangesRecovery',
    'StaleUnitsRecovery',
  ]);
  expect(progress).toContain('render: () => manualStory(manualScalarId)');
  expect(progress).toContain(
    "expect(canvas.queryByRole('button', { name: m.library_progress_update() })).not.toBeInTheDocument()",
  );
  expect(progress).not.toMatch(/export const \w*(?:Phone|Desktop)\w*: Story/);
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
    expect(messages.library_my_logs_previous).toBeTruthy();
    expect(messages.library_my_logs_newest).toBeTruthy();
    expect(messages.library_my_logs_next).toBeTruthy();
    expect(messages.library_my_logs_retry).toBeTruthy();
  }
});

test('My Logs accepts three exact windows, bounded branches, retry, stale restart and a direct later page', async () => {
  const visit = new MyLogsWindowNavigation();
  visit.observe('viewer-a', null);
  visit.accept('viewer-a', null);
  expect(visit.getSnapshot().coordinates).toEqual([null]);
  expect(visit.beginMovement('viewer-a', 'next', null, 'middle')).toBe(true);
  expect(visit.beginMovement('viewer-a', 'next', null, 'middle')).toBe(false);
  visit.observe('viewer-a', 'middle');
  visit.accept('viewer-a', 'middle');
  expect(visit.beginMovement('viewer-a', 'next', 'middle', 'oldest')).toBe(true);
  visit.observe('viewer-a', 'oldest');
  visit.accept('viewer-a', 'oldest');
  expect(visit.getSnapshot().coordinates).toEqual([null, 'middle', 'oldest']);

  expect(visit.beginMovement('viewer-a', 'previous', 'oldest', 'middle')).toBe(true);
  visit.observe('viewer-a', 'middle');
  visit.accept('viewer-a', 'middle');
  expect(visit.getSnapshot().coordinates).toEqual([null, 'middle']);
  expect(visit.beginMovement('viewer-a', 'next', 'middle', 'branch')).toBe(true);
  visit.observe('viewer-a', 'branch');
  visit.failMovement('viewer-a', 'branch');
  const failedRevision = visit.getSnapshot().revision;
  visit.failMovement('viewer-a', 'branch');
  expect(visit.getSnapshot().revision).toBe(failedRevision);
  expect(visit.getSnapshot()).toMatchObject({
    coordinates: [null, 'middle'],
    current: 'middle',
    movement: { target: 'branch', failed: true },
  });
  expect(visit.retryMovement('viewer-a', 'branch')).toBe(true);
  expect(visit.getSnapshot().movement).toEqual({ action: 'next', source: 'middle', target: 'branch', failed: false });
  visit.accept('viewer-a', 'branch');
  expect(visit.getSnapshot().coordinates).toEqual([null, 'middle', 'branch']);

  expect(visit.beginMovement('viewer-a', 'previous', 'branch', 'middle')).toBe(true);
  visit.observe('viewer-a', 'middle');
  visit.failMovement('viewer-a', 'middle');
  expect(visit.getSnapshot().movement).toMatchObject({ action: 'previous', target: 'middle', failed: true });
  expect(visit.retryMovement('viewer-a', 'middle')).toBe(true);
  expect(visit.getSnapshot().movement).toMatchObject({ target: 'middle', failed: false });
  visit.accept('viewer-a', 'middle');
  expect(visit.getSnapshot().coordinates).toEqual([null, 'middle']);

  expect(visit.beginMovement('viewer-a', 'newest', 'middle', null)).toBe(true);
  visit.observe('viewer-a', null);
  visit.failMovement('viewer-a', null);
  expect(visit.retryMovement('viewer-a', null)).toBe(true);
  visit.accept('viewer-a', null);
  expect(visit.getSnapshot().coordinates).toEqual([null]);
  expect(visit.beginMovement('viewer-a', 'next', null, 'stale-target')).toBe(true);
  visit.observe('viewer-a', 'stale-target');
  visit.accept('viewer-a', 'stale-target', true);
  expect(visit.getSnapshot()).toMatchObject({ coordinates: [null], current: null, movement: null });

  const direct = new MyLogsWindowNavigation();
  direct.observe('viewer-a', 'later');
  direct.accept('viewer-a', 'later');
  expect(direct.getSnapshot().coordinates).toEqual(['later']);
  expect(direct.beginMovement('viewer-a', 'previous', 'later', null)).toBe(false);
  expect(direct.beginMovement('viewer-a', 'newest', 'later', null)).toBe(true);
  const longCursor = new MyLogsWindowNavigation();
  longCursor.observe('viewer-a', null);
  longCursor.accept('viewer-a', null);
  expect(longCursor.beginMovement('viewer-a', 'next', null, 'x'.repeat(4096))).toBe(true);
  const malformed = new MyLogsWindowNavigation();
  malformed.observe('viewer-a', null);
  malformed.accept('viewer-a', null);
  expect(malformed.beginMovement('viewer-a', 'next', null, 'x'.repeat(4097))).toBe(false);
});

test('My Logs keeps only nine accepted coordinates and preserves unrelated address bytes', async () => {
  const visit = new MyLogsWindowNavigation();
  visit.observe('viewer-a', null);
  visit.accept('viewer-a', null);
  let source: string | null = null;
  for (let index = 0; index < 10; index++) {
    const target = `cursor-${index}`;
    expect(visit.beginMovement('viewer-a', 'next', source, target)).toBe(true);
    visit.observe('viewer-a', target);
    visit.accept('viewer-a', target);
    source = target;
  }
  expect(visit.getSnapshot().coordinates).toHaveLength(9);
  expect(visit.getSnapshot().coordinates[0]).toBe('cursor-1');
  expect(visit.getSnapshot().coordinates.at(-1)).toBe('cursor-9');
  expect(
    myLogsWindowHrefs('/library/logs?raw=%2f&cursor=old&%63ursor=duplicate&empty=#tab%2f', 'a/+==', 'zh-Hant'),
  ).toEqual({
    route: '/library/logs?raw=%2f&empty=&cursor=a%2F%2B%3D%3D#tab%2f',
    link: '/zh-Hant/library/logs?raw=%2f&empty=&cursor=a%2F%2B%3D%3D#tab%2f',
  });
});

test('My Logs keyboard focus returns only while the initiating handoff remains eligible', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const focusListeners = new Set<EventListener>();
  const source = {} as HTMLElement;
  const destination = {} as HTMLElement;
  let activeElement: Element | null = source;
  const documentStub = {
    body: {} as HTMLElement,
    documentElement: {} as HTMLElement,
    get activeElement() {
      return activeElement;
    },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') focusListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') focusListeners.delete(listener);
    },
  } as unknown as Document;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  try {
    const eligible = new MyLogsWindowNavigation();
    eligible.observe('viewer-a', null);
    eligible.accept('viewer-a', null);
    expect(eligible.beginMovement('viewer-a', 'next', null, 'next', source, true)).toBe(true);
    eligible.observe('viewer-a', 'next');
    eligible.accept('viewer-a', 'next');
    expect(eligible.getSnapshot().focusReady).toBe(true);
    expect(eligible.consumeFocus('viewer-a')).toBe(true);

    const interrupted = new MyLogsWindowNavigation();
    interrupted.observe('viewer-a', null);
    interrupted.accept('viewer-a', null);
    activeElement = source;
    expect(interrupted.beginMovement('viewer-a', 'next', null, 'next', source, true)).toBe(true);
    activeElement = destination;
    for (const listener of [...focusListeners]) listener({ target: destination } as unknown as FocusEvent);
    interrupted.observe('viewer-a', 'next');
    interrupted.accept('viewer-a', 'next');
    expect(interrupted.getSnapshot().focusReady).toBe(false);

    const pointer = new MyLogsWindowNavigation();
    pointer.observe('viewer-a', null);
    pointer.accept('viewer-a', null);
    activeElement = source;
    expect(pointer.beginMovement('viewer-a', 'next', null, 'next', source, false)).toBe(true);
    pointer.observe('viewer-a', 'next');
    pointer.accept('viewer-a', 'next');
    expect(pointer.getSnapshot().focusReady).toBe(false);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('one named QueryClient visit survives a route leaf remount and retires with its reader', async () => {
  const client = new QueryClient();
  const first = myLogsWindowNavigation(client);
  const detach = first.attach();
  first.observe('viewer-a', null);
  first.accept('viewer-a', null);
  first.beginMovement('viewer-a', 'next', null, 'next');
  first.observe('viewer-a', 'next');
  first.accept('viewer-a', 'next');
  detach();

  const remounted = myLogsWindowNavigation(client);
  expect(remounted).toBe(first);
  const detachRemount = remounted.attach();
  expect(remounted.getSnapshot().coordinates).toEqual([null, 'next']);
  remounted.observe('viewer-b', 'next');
  expect(remounted.getSnapshot().coordinates).toEqual([]);
  detachRemount();
  await Promise.resolve();
  expect(remounted.isDisposed).toBe(true);
  expect(myLogsWindowNavigation(client)).not.toBe(remounted);
  client.clear();
});
