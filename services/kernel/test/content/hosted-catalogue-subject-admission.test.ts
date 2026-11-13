import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { anchorRoute } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let observer: ReturnType<typeof observeSql>;
let getSubjectBooks: (query?: string) => ReturnType<typeof f.native.call>;
let expectedItems: Array<{
  catalogueId: string;
  revisionId: string;
  kind: 'publication';
  sourceRevisionId: string;
  threadId: string;
}>;
let publishedBooks: Book[];
let protectedBook: Book;

type Book = Readonly<{
  catalogueId: string;
  threadId: string;
  structureRevisionId: string;
  publicationId: string;
}>;

function bodyProbes(start: number) {
  const probes = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
  expect(probes.length).toBeGreaterThan(0);
  return probes.filter((row) => row.parameters[readChain.params.indexOf('include_body')] === true);
}

beforeAll(async () => {
  f = await hostedChaptersFixture();
  const source = await f.native.thread('published', fromPlainText('Book opening'));
  const scheme = await f.native.command('/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Hosted Books' },
  });
  const subjectKey = (() => {
    let key = crypto.randomUUID();
    while (
      anchorRoute(f.native.system.routeKey, `${f.native.author.actor.accountId}\nsubject.create\n${key}`) !==
      f.native.board.route
    )
      key = crypto.randomUUID();
    return key;
  })();
  const createdSubject = await f.native.call(
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: 'Hosted Books' },
      statements: {
        'skos:inScheme': [
          {
            property: { id: 'skos:inScheme' },
            value: { type: 'value', content: scheme.subject.id },
          },
        ],
      },
    },
    { key: subjectKey },
  );
  expect(createdSubject.status).toBe(201);
  const subject = createdSubject.value.subject.id as string;
  const createBook = async (visibility: 'published' | 'protected'): Promise<Book> => {
    const { thread } = await f.native.command('/v1/threads', {
      title: `${visibility} Subject Book`,
      body: fromPlainText('Catalogue opening'),
      licence: 'MIT',
      subjectIds: [subject],
      boardId: f.native.board.id,
      visibility,
    });
    const occurrenceId = f.newOccurrenceId();
    const structure = await f.native.command('/v1/hostedCatalogues', {
      postId: thread.firstPost.id,
      threadId: thread.id,
      placements: [
        {
          occurrenceId,
          parentId: null,
          position: 0,
          kind: 'chapter',
          title: 'Opening',
          target: f.target(source),
        },
      ],
    });
    const publication = await f.native.command(
      `/v1/hostedCatalogues/${thread.firstPost.id}:publish`,
      {
        expectedRevisionId: structure.revisionId,
        expectedPublicationId: null,
        occurrenceIds: [occurrenceId],
      },
      200,
    );
    return {
      catalogueId: thread.firstPost.id,
      threadId: thread.id,
      structureRevisionId: structure.revisionId,
      publicationId: publication.revisionId,
    };
  };
  publishedBooks = [await createBook('published'), await createBook('published')];
  protectedBook = await createBook('protected');
  expectedItems = publishedBooks
    .map((book) => ({
      catalogueId: book.catalogueId,
      revisionId: book.publicationId,
      kind: 'publication' as const,
      sourceRevisionId: book.structureRevisionId,
      threadId: book.threadId,
    }))
    .sort((left, right) => left.catalogueId.localeCompare(right.catalogueId));
  observer = observeSql(f.native.pool);
  getSubjectBooks = (query = '') =>
    f.native.call('GET', `/v1/subjects/${subject}/hostedCatalogues${query}`, undefined, { anonymous: true });
});

afterAll(async () => {
  await observer?.close();
  await f?.close();
});

test('Subject discovery admits published Books, conceals a protected candidate, and advances after a stale publication', async () => {
  const start = observer.records.length;
  const response = await getSubjectBooks();
  expect(response.status).toBe(200);
  expect(response.value.items).toEqual(expectedItems);
  expect(response.value.items.map((item: { catalogueId: string }) => item.catalogueId)).not.toContain(
    protectedBook.catalogueId,
  );
  expect(bodyProbes(start)).toHaveLength(0);

  const first = publishedBooks.find((book) => book.catalogueId === expectedItems[0]!.catalogueId)!;
  const second = publishedBooks.find((book) => book.catalogueId !== first.catalogueId)!;
  const nativeRead = reads.readPostMetadata;
  let withdrawn = false;
  const probe = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === first.catalogueId && !withdrawn) {
      withdrawn = true;
      await f.native.command(
        `/v1/hostedCatalogues/${first.catalogueId}:publish`,
        {
          expectedRevisionId: first.structureRevisionId,
          expectedPublicationId: first.publicationId,
          occurrenceIds: [],
        },
        200,
      );
    }
    return result;
  });
  try {
    const sparseStart = observer.records.length;
    const sparse = await getSubjectBooks('?limit=1');
    expect(sparse.status).toBe(200);
    expect(withdrawn).toBe(true);
    expect(sparse.value.items).toEqual([]);
    expect(sparse.value.nextCursor).toEqual(expect.any(String));
    expect(bodyProbes(sparseStart)).toHaveLength(0);

    const continuationStart = observer.records.length;
    const continued = await getSubjectBooks(`?limit=1&cursor=${encodeURIComponent(sparse.value.nextCursor)}`);
    expect(continued.status).toBe(200);
    expect(continued.value.items).toEqual([expectedItems.find((item) => item.catalogueId === second.catalogueId)]);
    expect(continued.value.nextCursor).toBeNull();
    expect(bodyProbes(continuationStart)).toHaveLength(0);
  } finally {
    probe.mockRestore();
  }
});
