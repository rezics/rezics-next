import { afterEach, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument, type View } from '@rezics/composition';
import {
  book,
  bookContents,
  bookEditions,
  bookId,
  bookRealm,
  bookSeries,
  bookSubjectRead,
} from '../src/kernel/fixtures/book-showcase';
import { bookShowcasePage, selectBookShowcase } from '../src/kernel/fake/book-showcase';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { subjectTabs } from '../src/features/pages/views';
import { recordedBookState } from '../src/kernel/fake/library-entry-states';
import { QUESTION } from '../src/kernel/fake/ratings';

const views: View[] = [
  'overview',
  'editions',
  'contents',
  'characters',
  'credits',
  'relations',
  'reviews',
  'discussion',
  'lists',
  'details',
];
const client = () => createKernelClient('https://kernel.invalid', { fetch: createStoryRecordedKernelFetch() });
const headers = { authorization: 'Bearer story-viewer' };
afterEach(() => selectBookShowcase());

function leaf(page: ReturnType<typeof bookShowcasePage>, node: string) {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    context: page.context,
    ...(page.continuation ? { continuation: page.continuation } : {}),
  });
  return page.reads[plan.nodes[node]!]!;
}

test('the rich Book offers every applicable released tab and each direct entry is served by the transport', async () => {
  const overview = bookShowcasePage();
  expect(subjectTabs(overview).map((tab) => tab.view)).toEqual(views);
  const kernel = client();
  for (const view of views) {
    const result = await kernel.pages.$read.post({ target: { subject: book.id, view }, languages: ['en'] });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ subject: book.id, context: overview.context });
  }
  const reading = await kernel.threads({ id: bookId(1000) })['reading-page'].get({ headers });
  expect(reading.status).toBe(200);
  expect(reading.data).toMatchObject({
    viewer: { kind: 'account', id: 'story-viewer' },
    thread: { subjectIds: [book.id] },
  });
});

test('edition and series continuations retain statement identity, language and selected Realm', async () => {
  const initial = bookShowcasePage(book.id, 'editions', { locale: 'ja', realm: bookRealm });
  const first = leaf(initial, 'editions').body as { links: { subject: string; assertion: unknown }[]; next: string };
  const later = bookShowcasePage(book.id, 'editions', {
    locale: 'ja',
    realm: bookRealm,
    continuation: { node: 'editions', cursor: first.next },
  });
  const second = leaf(later, 'editions').body as typeof first;
  expect([...first.links, ...second.links].map((row) => row.subject)).toEqual(
    bookEditions.map((edition) => edition.id),
  );
  expect(new Set([...first.links, ...second.links].map((row) => JSON.stringify(row.assertion))).size).toBe(
    bookEditions.length,
  );
  expect(later.context).toEqual(initial.context);
  const edition = bookSubjectRead(first.links[2]!.subject, 'ja', initial.context!.id);
  expect(edition.subject.statements['schema:exampleOfWork']![0]!.value).toMatchObject({ content: book.id });
  const series = bookShowcasePage(bookSeries.id, 'contents');
  const volumes = leaf(series, 'series-works').body as {
    links: { subject: string; assertion: { qualifiers: unknown[] } }[];
  };
  expect(volumes.links[0]!.subject).toBe(book.id);
  expect(volumes.links[0]!.assertion.qualifiers).toMatchObject([{ value: { content: '1' } }]);
  expect(bookContents[0]!.statements['wdt:P361']![0]!.value).toMatchObject({ content: book.id });
});

test('a failed editions leaf recovers through the ordinary route while reviews remain readable', async () => {
  selectBookShowcase('failure');
  const kernel = client();
  const first = await kernel.pages.$read.post({ target: { subject: book.id, view: 'editions' }, languages: ['en'] });
  expect(leaf(first.data as ReturnType<typeof bookShowcasePage>, 'editions').status).toBe(503);
  const reviews = await kernel.pages.$read.post({ target: { subject: book.id, view: 'reviews' }, languages: ['en'] });
  expect(leaf(reviews.data as ReturnType<typeof bookShowcasePage>, 'reviews').status).toBe(200);
  const retry = await kernel.pages.$read.post({ target: { subject: book.id, view: 'editions' }, languages: ['en'] });
  expect(leaf(retry.data as ReturnType<typeof bookShowcasePage>, 'editions').status).toBe(200);
});

test('member state and own score read back after writes, clear correctly and reject limited writes', async () => {
  selectBookShowcase();
  const kernel = client();
  const library = kernel.libraryEntries({ subjectId: book.id });
  const state = recordedBookState(2)!;
  expect((await library.put({ state }, { headers })).status).toBe(200);
  expect((await library.get({ headers })).data).toMatchObject({ libraryEntry: { subjectId: book.id, state } });
  const vote = kernel.subjects({ id: book.id }).ratings({ questionId: QUESTION }).vote;
  expect((await vote.put({ units: 19 }, { headers })).status).toBe(200);
  expect((await vote.get({ headers })).data).toMatchObject({ units: 19 });
  expect((await vote.delete(undefined, { headers })).status).toBe(204);
  expect((await vote.get({ headers })).status).toBe(404);
  selectBookShowcase('limited');
  expect((await vote.put({ units: 20 }, { headers })).status).toBe(403);
  expect((await vote.get({ headers })).data).toMatchObject({ units: 17 });
  expect((await library.put({ state }, { headers })).status).toBe(403);
});
