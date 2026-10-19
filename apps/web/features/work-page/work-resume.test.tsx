import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collection from '../../../../tests/qa/fixtures/outcomes/books/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { standaloneSummary } from '../tracking/fixtures.ts';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import { readSuppliedBookStart } from './games-hub-recorded-page.ts';
import { messages } from './messages.ts';
import { IdentityStatus } from './primary-action.tsx';
import { readStart, type ReadStart } from './read.ts';
import { idOf, iriOf, textHref } from './route.ts';

const record = collection as AnswerRecord;
const sample = record.personas.owner.find(item => item.label === 'continue-next-chapter')!;
const saved = sample.answer as { profile: 'work-resume-v1'; work: string;
  sourcePosition: { dataEpoch: string; sequence: string };
  lastPosition: { occurrence: string; position: string | null; completed: boolean; updatedAt: string };
  nextUnread: { occurrence: string; title: string | null; href: string };
  unreadCount: { value: number; kind: 'exact' | 'lower-bound' } };
const id = idOf(saved.work)!;
const actor = new URL(sample.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
const noLanguageRead = async (): Promise<string | null> => { throw new Error('A resume must retain Main’s language'); };

function host(reply: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const methods: string[] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    methods.push(init?.method ?? (input instanceof Request ? input.method : 'GET'));
    return reply(url);
  }, { preconnect: fetch.preconnect });
  return { client: { main: browserMainApi('https://resume.invalid', { fetcher }), actingSubject: actor }, calls, methods };
}

function status(start: ReadStart | undefined, state: ReturnType<typeof standaloneSummary>['status'] = 'not-started') {
  return renderToStaticMarkup(<IdentityStatus start={start}
    progress={{ ok: true, data: { ...standaloneSummary(state), resource: saved.work } }}
    preference={{ ok: true, data: { work: saved.work, language: 'en', edition: null, version: 1 } }}
    editionName={null} locale="en" messages={messages.en} />);
}

test('the Book header consumes the genuine exact next-chapter response with its authenticated actor', async () => {
  const replay = recordedFetch(record, 'owner', [{ label: sample.label, state: 'populated' }], { pathPrefix: BFF_PREFIX });
  try {
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    const start = await readStart(id, saved.work, 'fr', 'fr', { main, actingSubject: actor, signedIn: true });
    expect(start).toEqual({ kind: 'continue', href: saved.nextUnread.href, chapter: saved.nextUnread.title });
    expect(saved.lastPosition.completed).toBe(true);
    expect(saved.lastPosition.occurrence).not.toBe(saved.nextUnread.occurrence);
    expect(status(start)).not.toContain(trackingCopy('en').notStarted);
    expect(status(start)).toContain('Your edition: English');
  } finally { replay.dispose(); }
});

for (const home of [
  { name: 'an empty Home page (unshelved or hidden)', items: [], nextCursor: null },
  { name: 'a full first page of six other Works', items: Array.from({ length: 6 }, (_, index) => ({
    ...saved, work: iriOf(`00000000-0000-7000-8000-00000000000${index}`),
  })), nextCursor: 'opaque-next-page' },
]) {
  test(`the exact Book resume is independent of ${home.name}`, async () => {
    const { client, calls, methods } = host(url => url.pathname === `${BFF_PREFIX}/v1/me/continue/${id}`
      ? Response.json(saved) : Response.json({ items: home.items, nextCursor: home.nextCursor }));
    const start = await readSuppliedBookStart(client, id, saved.work, noLanguageRead);
    expect(start).toEqual({ kind: 'continue', href: saved.nextUnread.href, chapter: saved.nextUnread.title });
    expect(calls.map(url => url.pathname)).toEqual([`${BFF_PREFIX}/v1/me/continue/${id}`]);
    expect([...calls[0]!.searchParams]).toEqual([['actingSubject', actor]]);
    expect(methods).toEqual(['GET']);
  });
}

for (const position of [null, 'p:21']) {
  test(`an incomplete saved chapter at ${position ?? 'no position'} retains Main’s occurrence and language`, async () => {
    const { client } = host(() => Response.json({ ...saved,
      lastPosition: { ...saved.lastPosition, occurrence: saved.nextUnread.occurrence, completed: false, position } }));
    expect(await readSuppliedBookStart(client, id, saved.work, async () => 'fr')).toEqual({
      kind: 'continue', href: saved.nextUnread.href, chapter: saved.nextUnread.title,
    });
  });
}

test('known no-progress starts at the supplied first unread chapter and keeps Not started truthful', async () => {
  const { client, calls } = host(() => Response.json({ ...saved, lastPosition: null }));
  const start = await readSuppliedBookStart(client, id, saved.work, noLanguageRead);
  expect(start).toEqual({ kind: 'start', href: saved.nextUnread.href, chapter: saved.nextUnread.title });
  expect(calls).toHaveLength(1);
  expect(status(start)).toContain(trackingCopy('en').notStarted);
});

for (const language of ['en', null]) {
  test(`a successful empty chapter resume retains the ${language ? 'standalone text' : 'nothing to read'} state`, async () => {
    const { client, calls } = host(url => url.pathname.endsWith(`/continue/${id}`)
      ? Response.json({ ...saved, lastPosition: null, nextUnread: null, unreadCount: null })
      : Response.json({ title: 'No chapter composition' }, { status: 404 }));
    expect(await readSuppliedBookStart(client, id, saved.work, async () => language)).toEqual(language
      ? { kind: 'start', href: textHref(id), chapter: null } : null);
    expect(calls.map(url => url.pathname)).toEqual([`${BFF_PREFIX}/v1/me/continue/${id}`]);
  });
}

test('anonymous readers start publicly without a private resume request', async () => {
  const { client, calls } = host(() => Response.json({ title: 'No chapter composition' }, { status: 404 }));
  expect(await readSuppliedBookStart({ main: client.main }, id, saved.work, async () => 'en')).toEqual({
    kind: 'start', href: textHref(id), chapter: null,
  });
  expect(calls.map(url => url.pathname)).toEqual([`${BFF_PREFIX}/v1/works/${id}/contents`]);
  expect(calls[0]!.searchParams.has('actingSubject')).toBe(false);
});

test('a response or header for another Work cannot supply its private title, bookmark or link', async () => {
  const other = iriOf('00000000-0000-7000-8000-000000000099');
  const { client, calls } = host(() => Response.json({ ...saved, work: other }));
  expect(await readSuppliedBookStart(client, id, saved.work, noLanguageRead)).toEqual({ kind: 'contents' });
  expect(calls).toHaveLength(1);
  expect(await readSuppliedBookStart(client, idOf(other)!, saved.work, noLanguageRead)).toEqual({ kind: 'contents' });
  expect(calls).toHaveLength(1);
});

for (const code of [401, 403, 404, 409, 503, 202]) {
  test(`a ${code} resume refusal cannot restart chapter one or claim Not started`, async () => {
    const { client, calls } = host(() => Response.json({ title: 'Resume unavailable' }, { status: code }));
    const start = await readSuppliedBookStart(client, id, saved.work, noLanguageRead);
    expect(start).toEqual({ kind: 'contents' });
    expect(calls).toHaveLength(code === 409 ? 2 : 1);
    expect(calls.every(url => url.pathname === `${BFF_PREFIX}/v1/me/continue/${id}`
      && url.searchParams.get('actingSubject') === actor)).toBe(true);
    expect(status(start)).not.toContain(trackingCopy('en').notStarted);
    expect(status(start)).toContain('Your edition: English');
  });
}

test('a transport failure leaves the chapter resume unknown', async () => {
  const { client, calls } = host(() => { throw new Error('Offline'); });
  const start = await readSuppliedBookStart(client, id, saved.work, noLanguageRead);
  expect(start).toEqual({ kind: 'contents' });
  expect(calls).toHaveLength(1);
  expect(status(start)).not.toContain(trackingCopy('en').notStarted);
});

test('a stale first read retries the exact same Work and actor before using the current response', async () => {
  let attempts = 0;
  const { client, calls } = host(() => ++attempts === 1
    ? Response.json({ title: 'Read basis moved' }, { status: 409 }) : Response.json(saved));
  expect(await readSuppliedBookStart(client, id, saved.work, noLanguageRead)).toEqual({
    kind: 'continue', href: saved.nextUnread.href, chapter: saved.nextUnread.title,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.href).toBe(calls[1]!.href);
});

test('saved progress without a readable successor does not silently restart', async () => {
  const { client, calls } = host(() => Response.json({ ...saved, nextUnread: null, unreadCount: null }));
  const start = await readSuppliedBookStart(client, id, saved.work, noLanguageRead);
  expect(start).toEqual({ kind: 'contents' });
  expect(calls).toHaveLength(1);
  expect(status(start)).not.toContain(trackingCopy('en').notStarted);
  expect(status(start, 'finished')).toContain(trackingCopy('en').stateFinished);
});

test('non-Book status and explicit whole-Work marks retain their existing meaning', () => {
  expect(status(undefined)).toContain(trackingCopy('en').notStarted);
  expect(status({ kind: 'contents' }, 'reading')).toContain(trackingCopy('en').stateActive);
});
