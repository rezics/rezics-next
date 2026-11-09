import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { createImportTransport } from '../src/import-client.ts';
import { readCurrentCandidatePages, safeCandidatePage } from '../src/showcase-current-reads.ts';
import { ShowcaseJournal } from '../src/showcase-journal.ts';
import {
  admitSelectedSynopsisSupport,
  createPublicBulkClient,
  GLOBAL_CONTEXT,
  selectedSynopsisQueryFromPublic,
} from '../src/public-bulk-client.ts';

const original = '019a1b2c-3d4e-7f00-8a00-000000000001';
const canonical = '019a1b2c-3d4e-7f00-8a00-000000000002';

test('candidate page normalization drops tombstones and builds selection only at the terminal page', () => {
  const statement: BatchStatement = {
    property: { id: 'schema:abstract' },
    value: { type: 'novalue' },
    references: [{ parts: [{ property: { id: 'schema:reference' }, value: { type: 'novalue' } }] }],
  };
  const preferred = { id: original, source: null, statement, head: null, rank: 'preferred' as const };
  const normal = { id: canonical, source: null, statement, head: null, rank: 'normal' as const };
  const tombstone = { id: '019a1b2c-3d4e-7f00-8a00-000000000003', deleted: true };
  const continuation = safeCandidatePage({
    candidates: [preferred, tombstone],
    next: 'next-page',
    adoption: { mode: 'replace', head: 7 },
  });
  expect(continuation.candidates).toEqual([preferred]);
  expect(continuation.adoption).toEqual({ mode: 'replace', head: 7 });
  expect(continuation.tombstones).toEqual(['019a1b2c-3d4e-7f00-8a00-000000000003']);

  const terminal = safeCandidatePage({
    candidates: [preferred, normal, tombstone],
    next: null,
    adoption: { mode: 'replace', head: 7 },
  });
  expect(terminal.adoption).toEqual({
    mode: 'replace',
    head: 7,
    selection: [
      { candidate: original, rank: 'preferred' },
      { candidate: canonical, rank: 'normal' },
    ],
  });
});

test('replacement selection uses every live rank from one stable terminal listing', async () => {
  const statement: BatchStatement = {
    property: { id: 'schema:name' },
    value: { type: 'novalue' },
    references: [],
  };
  const second = '019a1b2c-3d4e-7f00-8a00-000000000004';
  const tombstone = '019a1b2c-3d4e-7f00-8a00-000000000005';
  const cursors: (string | null)[] = [];
  const review = {
    async reviewedCandidates(_id: string, query: { cursor?: string }) {
      cursors.push(query.cursor ?? null);
      return query.cursor
        ? {
            candidates: [{ id: second, source: null, statement, head: null, rank: 'preferred' }],
            next: null,
            adoption: { mode: 'replace', head: 7 },
          }
        : {
            candidates: [
              { id: original, source: null, statement, head: null, rank: 'normal' },
              { id: tombstone, deleted: true },
            ],
            next: 'next-page',
            adoption: { mode: 'replace', head: 7 },
          };
    },
  };
  const current = await readCurrentCandidatePages(review as never, canonical, 'schema:name');
  expect(cursors).toEqual([null, 'next-page']);
  expect(current).toMatchObject({
    complete: true,
    next: null,
    adoption: {
      mode: 'replace',
      head: 7,
      selection: [
        { candidate: original, rank: 'normal' },
        { candidate: second, rank: 'preferred' },
      ],
    },
  });
  expect(current.candidates.map((candidate) => candidate.id)).toEqual([original, second]);
  expect(current.tombstones).toEqual([tombstone]);

  let changedHeadCalls = 0;
  const changedHeadReview = {
    async reviewedCandidates(_id: string, query: { cursor?: string }) {
      changedHeadCalls += 1;
      return query.cursor
        ? {
            candidates: [{ id: second, source: null, statement, head: null, rank: 'preferred' }],
            next: null,
            adoption: { mode: 'replace', head: 8 },
          }
        : {
            candidates: [{ id: original, source: null, statement, head: null, rank: 'normal' }],
            next: 'next-page',
            adoption: { mode: 'replace', head: changedHeadCalls === 1 ? 7 : 8 },
          };
    },
  };
  const restarted = await readCurrentCandidatePages(changedHeadReview as never, canonical, 'schema:name');
  expect(changedHeadCalls).toBe(4);
  expect(restarted).toMatchObject({
    complete: true,
    adoption: {
      mode: 'replace',
      head: 8,
      selection: [
        { candidate: original, rank: 'normal' },
        { candidate: second, rank: 'preferred' },
      ],
    },
  });

  let unstableCalls = 0;
  const unstableReview = {
    async reviewedCandidates(_id: string, query: { cursor?: string }) {
      unstableCalls += 1;
      const scan = Math.floor((unstableCalls - 1) / 2);
      return query.cursor
        ? {
            candidates: [{ id: second, source: null, statement, head: null, rank: 'preferred' }],
            next: null,
            adoption: { mode: 'replace', head: scan * 2 + 2 },
          }
        : {
            candidates: [{ id: original, source: null, statement, head: null, rank: 'normal' }],
            next: 'next-page',
            adoption: { mode: 'replace', head: scan * 2 + 1 },
          };
    },
  };
  const bounded = await readCurrentCandidatePages(unstableReview as never, canonical, 'schema:name');
  expect(unstableCalls).toBe(6);
  expect(bounded).toMatchObject({ complete: false, candidates: [], adoption: null });
});

test('candidate listing resumes a journaled cursor after an interrupted seed run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-candidate-list-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const statement: BatchStatement = {
    property: { id: 'schema:name' },
    value: { type: 'novalue' },
    references: [],
  };
  const terminal = '019a1b2c-3d4e-7f00-8a00-000000000006';
  const cursors: (string | null)[] = [];
  let interrupt = true;
  const review = {
    async reviewedCandidates(_id: string, query: { cursor?: string }) {
      cursors.push(query.cursor ?? null);
      if (query.cursor && interrupt) {
        interrupt = false;
        throw new Error('simulated interrupted candidate read');
      }
      return query.cursor
        ? {
            candidates: [{ id: terminal, source: null, statement, head: null, rank: 'preferred' }],
            next: null,
            adoption: { mode: 'replace', head: 11 },
          }
        : {
            candidates: [{ id: original, source: null, statement, head: null, rank: 'normal' }],
            next: 'next-page',
            adoption: { mode: 'replace', head: 11 },
          };
    },
  };

  try {
    await expect(
      readCurrentCandidatePages(review as never, canonical, 'schema:name', {
        journal,
        intent: 'candidate-resume-test',
      }),
    ).rejects.toThrow('simulated interrupted candidate read');
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const current = await readCurrentCandidatePages(review as never, canonical, 'schema:name', {
      journal,
      intent: 'candidate-resume-test',
    });

    expect(cursors).toEqual([null, 'next-page', null, 'next-page']);
    expect(current).toMatchObject({
      complete: true,
      adoption: {
        mode: 'replace',
        head: 11,
        selection: [
          { candidate: original, rank: 'normal' },
          { candidate: terminal, rank: 'preferred' },
        ],
      },
    });
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('review and independent public publication reads bypass caches through current canonical redirects', async () => {
  const requests: Request[] = [];
  let revision = 1;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname.endsWith(original))
      return Response.json({ redirect: { from: original, to: canonical } }, { status: 308 });
    return Response.json({ subject: { id: canonical, revision } });
  }) as typeof fetch;
  const review = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'review-token',
    fetch: fetcher,
  });
  const anonymous = createPublicBulkClient({ origin: 'https://api.importer.test', fetch: fetcher });
  expect((await review.readReviewedSubject(original)).subject).toMatchObject({ id: canonical, revision: 1 });
  revision = 2;
  expect((await anonymous.readSubject(original)).subject).toMatchObject({ id: canonical, revision: 2 });
  revision = 3;
  expect((await anonymous.readSubject(original)).subject.revision).toBe(3);
  expect(requests).toHaveLength(6);
  for (const [index, request] of requests.entries()) {
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toBe(index < 2 ? 'Bearer review-token' : null);
    expect(new URL(request.url).searchParams.get('context')).toBe(index < 2 ? null : GLOBAL_CONTEXT);
  }
});

test('independent public selected-synopsis reads keep no-store, refuse redirects, and admit only redacted current slots', async () => {
  const statement = '019a1b2c-3d4e-7f00-8a00-000000000101';
  const document = '019a1b2c-3d4e-7f00-8a00-000000000202';
  const digest = 'c'.repeat(64);
  const release = `sha256:${'d'.repeat(64)}`;
  const subject = {
    id: original,
    context: GLOBAL_CONTEXT,
    release,
    statements: {
      'schema:abstract': [
        {
          id: statement,
          rank: 'normal',
          property: { id: 'schema:abstract', data_type: 'document' },
          value: { type: 'value', content: { document, digest, language: 'und' } },
          qualifiers: [],
          references: [],
        },
      ],
    },
  };
  const requests: URL[] = [];
  const client = createPublicBulkClient({
    origin: 'https://api.importer.test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push(url);
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('manual');
      if (url.pathname.endsWith(original) && url.searchParams.has('selectedSynopsis'))
        return Response.json({ redirect: { from: original, to: canonical } }, { status: 308 });
      const id = url.pathname.split('/').at(-1)!;
      return Response.json({
        subject: { ...subject, id },
        selectedSynopsis: {
          kind: 'matched',
          context: GLOBAL_CONTEXT,
          release,
          fact: {
            id: statement,
            rank: 'normal',
            property: { id: 'schema:abstract', data_type: 'document' },
            value: { type: 'somevalue' },
            qualifiers: [],
            references: [],
          },
        },
      });
    }) as typeof fetch,
  });
  const operands = selectedSynopsisQueryFromPublic({ subject } as never, statement)!;
  expect(JSON.parse(operands.query)).toEqual({
    statement,
    document,
    digest,
    language: 'und',
    context: GLOBAL_CONTEXT,
    release,
  });
  await expect(client.readSelectedSynopsis(original, operands.query)).rejects.toThrow(
    'Selected synopsis cannot follow a canonical redirect',
  );
  const current = await client.readSelectedSynopsis(canonical, operands.query);
  expect(admitSelectedSynopsisSupport(current, statement, operands.document)).toEqual({
    kind: 'matched',
    statement,
    context: GLOBAL_CONTEXT,
    release,
    references: [],
  });
  for (const kind of ['changed', 'missing', 'unsupported', 'unavailable'] as const)
    expect(
      admitSelectedSynopsisSupport({ ...current, selectedSynopsis: { kind } } as never, statement, operands.document),
    ).toEqual({ kind });
  expect(
    admitSelectedSynopsisSupport(
      {
        ...current,
        selectedSynopsis: {
          kind: 'matched',
          context: GLOBAL_CONTEXT,
          release,
          fact: {
            id: statement,
            rank: 'normal',
            property: { id: 'schema:abstract', data_type: 'document' },
            value: { type: 'value', content: { document, digest, language: 'und' } },
            qualifiers: [],
            references: [],
          },
        },
      } as never,
      statement,
      operands.document,
    ),
  ).toEqual({ kind: 'unavailable' });
  const currentStatement = current.subject.statements['schema:abstract']![0]!;
  const withCurrentField = (statementValue: unknown) =>
    ({
      ...current,
      subject: {
        ...current.subject,
        statements: { ...current.subject.statements, 'schema:abstract': [statementValue] },
      },
    }) as never;
  expect(
    admitSelectedSynopsisSupport(
      withCurrentField({
        ...currentStatement,
        value: { type: 'value', content: { document, digest: 'f'.repeat(64), language: 'und' } },
      }),
      statement,
      operands.document,
    ),
  ).toEqual({ kind: 'unavailable' });
  expect(
    admitSelectedSynopsisSupport(
      withCurrentField({ ...currentStatement, rank: 'preferred' }),
      statement,
      operands.document,
    ),
  ).toEqual({ kind: 'unavailable' });
  expect(
    admitSelectedSynopsisSupport(
      withCurrentField({
        ...currentStatement,
        references: [
          {
            hash: 'changed-source',
            parts: [
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: 'https://source.test/other' },
              },
            ],
          },
        ],
      }),
      statement,
      operands.document,
    ),
  ).toEqual({ kind: 'unavailable' });
  expect(
    selectedSynopsisQueryFromPublic({ subject: { ...subject, statements: {} } } as never, statement),
  ).toBeUndefined();
  expect(
    selectedSynopsisQueryFromPublic(
      {
        subject: {
          ...subject,
          statements: {
            'schema:abstract': [
              { ...subject.statements['schema:abstract']![0], property: { id: 'schema:name', data_type: 'string' } },
            ],
          },
        },
      } as never,
      statement,
    ),
  ).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.searchParams.get('selectedSynopsis')).toBe(operands.query);
});
