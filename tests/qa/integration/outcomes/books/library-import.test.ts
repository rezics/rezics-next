import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import libraryImport from '../../../../../scripts/qa/cases/outcomes/books/library-import.ts';
import libraryExport from '../../../../../scripts/qa/cases/outcomes/books/library-export.ts';
import interruptedExport from '../../../../../scripts/qa/cases/outcomes/books/resume-an-interrupted-export-interrupted-exports.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';
import { pollLibraryImportApply } from '../../library-import-apply-support.ts';

type CanonicalRow = {
  kind: 'source' | 'entry' | 'session' | 'shelf' | 'retained';
  sourceId: string;
  title: string;
  creators: string[];
  work: string | null;
  target: string | null;
  identifiers: unknown[];
  status: string | null;
  startedOn: string | null;
  finishedOn: string | null;
  score: unknown;
  review: { text: string; language: string; spoiler: boolean } | null;
  shelves: string[];
  readCount: number | null;
  progress: unknown;
  raw: Record<string, unknown>;
  session: {
    target: string;
    state: string;
    startedOn: string | null;
    finishedOn: string | null;
    selections: { target: string; language?: string | null; format?: string | null }[];
    locators: unknown[];
  } | null;
};

type Page = { profile: string; rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
type Review = {
  rows: { index: number; version: number; source: CanonicalRow }[];
  nextCursor: number | null;
};
// The owner journey completes three applies, including its isolated reimport fixture.
setDefaultTimeout(120_000);
let people: PersonaSessions, book: string, upload: string, originals: CanonicalRow[];
let applied: Promise<void> | undefined;
let continuation: Promise<Page> | undefined;
const importRecording = new OutcomeRecorder(libraryImport);
const exportRecording = new OutcomeRecorder(libraryExport);
const interruptedRecording = new OutcomeRecorder(interruptedExport);

function recordedPerson(recording: OutcomeRecorder, name: PersonaName,
  person = people[name], prefix = ''): PersonaSession {
  const sample = recording.session(name, person);
  const counts = new Map<string, number>();
  return { ...person, main: (method, path, body, key) => {
    // Route names and ordinal pages stay addressable when fixture IDs change.
    const route = path.split('?')[0]!.replace(/^\/v1\/(?:me\/)?/, '')
      .split('/').filter(part => !/^[0-9a-f-]{36}$/.test(part)).join('-');
    const label = `${prefix}${method.toLowerCase()}-${route}`;
    const index = counts.get(label) ?? 0;
    counts.set(label, index + 1);
    return sample(`${label}-${index}`, method, path, body, key);
  } };
}
const own = (person: PersonaSession = people.owner) => ({ actingSubject: person.actingSubject! });
const query = (person: PersonaSession = people.owner) =>
  new URLSearchParams(own(person)).toString();
const root = () => `/v1/me/library-imports/${upload}`;

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const answer = await response,
    raw = await answer.text();
  if (answer.status !== status)
    throw new Error(`HTTP ${answer.status}, expected ${status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function refused(response: Promise<Response>, status: number, code: string) {
  const answer = await response,
    raw = await answer.text();
  expect({ status: answer.status, ...(answer.status === status ? {} : { raw }) }).toEqual({
    status,
  });
  expect(JSON.parse(raw).code).toBe(code);
  expect(raw).not.toContain('Private journal');
  expect(raw).not.toContain('Original private review');
}
function row(kind: CanonicalRow['kind'], sourceId: string): CanonicalRow {
  return {
    kind,
    sourceId,
    title: 'Owned original Book',
    creators: ['Original fixture owner'],
    work: book,
    target: null,
    identifiers: [],
    status: null,
    startedOn: null,
    finishedOn: null,
    score: null,
    review: null,
    shelves: [],
    readCount: null,
    progress: null,
    session: null,
    raw: {},
  };
}
function create(
  rows: CanonicalRow[],
  key = randomUUID(),
  person: PersonaSession = people.owner,
) {
  return person.main(
    'POST',
    '/v1/me/library-imports',
    {
      ...own(person),
      format: 'rezics',
      file: JSON.stringify({ profile: 'rezics-library-export-v1', rows }),
    },
    key,
  );
}
async function review(id: string, person: PersonaSession = people.owner) {
  let cursor = -1;
  const result: Review['rows'] = [];
  do {
    const page = await json<Review>(
      person.main(
        'GET',
        `/v1/me/library-imports/${id}/rows?${query(person)}&cursor=${cursor}`,
        undefined,
        randomUUID(),
      ),
    );
    result.push(...page.rows);
    cursor = page.nextCursor ?? -1;
  } while (cursor !== -1);
  return result;
}
async function apply(id: string, key = randomUUID(), person: PersonaSession = people.owner) {
  const progress = await pollLibraryImportApply(
    () =>
      person.main(
        'GET',
        `/v1/me/library-imports/${id}/apply?${query(person)}`,
        undefined,
        randomUUID(),
      ),
    {
      started: person.main(
        'POST',
        `/v1/me/library-imports/${id}/apply`,
        { ...own(person), context: null, language: 'en' },
        key,
      ),
      deadlineMs: 60_000,
    },
  );
  expect(progress).toMatchObject({ state: 'completed', pending: false, issues: 0 });
  return progress;
}
function read(
  cursor?: string | null,
  snapshot?: string,
  limit = 20,
  person: PersonaSession = people.owner,
) {
  const q = new URLSearchParams({
    ...own(person),
    limit: String(limit),
    ...(cursor ? { cursor } : {}),
    ...(snapshot ? { snapshot } : {}),
  });
  return json<Page>(person.main('GET', `/v1/me/library-export?${q}`));
}
async function collect(first = read(), person: PersonaSession = people.owner) {
  let page = await first;
  const rows = [...page.rows],
    snapshot = page.snapshot;
  while (page.nextCursor) {
    page = await read(page.nextCursor, snapshot, 20, person);
    expect(page.snapshot).toBe(snapshot);
    rows.push(...page.rows);
  }
  return rows;
}
async function applyOriginals(id: string, person: PersonaSession = people.owner) {
  const reviewed = await review(id, person);
  expect(reviewed.map((item) => item.source)).toEqual(originals);
  await json(
    person.main('PUT', `/v1/me/library-imports/${id}/rows/0`, {
      ...own(person),
      expectedVersion: reviewed[0]!.version,
      choice: 'apply',
      work: book,
      conflictChoice: 'replace',
    }),
  );
  const key = randomUUID();
  expect(await apply(id, key, person)).toMatchObject({
    completed: originals.length,
    total: originals.length,
  });
  return key;
}
function ensureApplied(person: PersonaSession = people.owner) {
  return (applied ??= (async () => {
    const key = await applyOriginals(upload, person);
    // Replay the accepted command after completion; its receipt cannot apply another session.
    await json(
      person.main(
        'POST',
        `${root()}/apply`,
        { ...own(), context: null, language: 'en' },
        key,
      ),
      202,
    );
  })());
}
function tokens() {
  return (continuation ??= (async () => {
    const first = await read(undefined, undefined, 2);
    expect(first.nextCursor).toBeTruthy();
    return first;
  })());
}

beforeAll(async () => {
  people = await personaSessions('private');
  await Promise.all([importRecording.prepare(), exportRecording.prepare(), interruptedRecording.prepare()]);
  const created = await json<{ work: string; mainVersion: string }>(
    people.owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1',
      authoring: 'own-work',
      title: `Original portable Book ${randomUUID()}`,
      language: 'en',
      semanticTypes: ['https://schema.org/Book'],
      ...own(),
    }),
    201,
  );
  book = created.work;
  const identified = await json<{ types: string[] }>(
    people.owner.main('GET', `/v1/works/${book.slice(-36)}?${query()}`),
  );
  expect(identified.types).toContain('https://schema.org/Book');
  // A receiving Person can resolve the Book through this credited original public text.
  // Publishing the Book supplies no authority over either Person's private library.
  const draft = await json<{ contribution: string; draftRevision: string }>(
    people.owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: book,
      language: 'en',
      body: 'An original fixture story by the fixture owner: a reader records a journey through an imaginary garden.',
      ...own(),
    }),
    201,
  );
  const publication = await json<{ publicationDecision: string }>(
    people.owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      ...own(),
    }),
    201,
  );
  await json(
    people.owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1',
      work: book,
      contribution: draft.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: created.mainVersion },
      selectionBasis: 'main-maintainer',
      ...own(),
    }),
    201,
  );
  expect(
    (
      await json<{ types: string[] }>(
        people.stranger.main('GET', `/v1/works/${book.slice(-36)}?${query(people.stranger)}`),
      )
    ).types,
  ).toContain('https://schema.org/Book');
  const statement = {
    ...row('entry', 'original-statement'),
    status: 'want-to-read' as const,
    review: { text: 'Original private review', language: 'en', spoiler: true },
    shelves: ['Private portable shelf'],
    raw: { sessionProjection: null, privateJournal: 'Private journal' },
  };
  const attempt = {
    ...row('session', 'original-attempt'),
    session: {
      target: book,
      state: 'planned' as const,
      startedOn: null,
      finishedOn: null,
      selections: [{ target: book, language: null, format: null }],
      locators: [],
    },
  };
  const emptyShelf = {
    ...row('shelf', 'original-empty-shelf'),
    shelves: ['Empty private shelf'],
    raw: { disclosure: 'private' },
  };
  // Portable copies and loans are private archival evidence, never commands to lend.
  const copyId = `https://rezics.com/id/${randomUUID()}`;
  const release = `https://rezics.com/id/${randomUUID()}`;
  const loanId = `https://rezics.com/id/${randomUUID()}`;
  const archivalCopy = {
    ...row('retained', `copy:${copyId}`),
    target: release,
    raw: {
      libraryCopy: {
        id: copyId,
        work: book,
        release,
        format: 'paperback',
        acquiredFrom: { kind: 'name', name: 'Original fixture owner' },
        acquiredAt: '2026-01-01T00:00:00.000Z',
        ownedFrom: '2026-01-01T00:00:00.000Z',
        ownedThrough: null,
        removed: false,
        version: 1,
      },
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'OwnershipInfo',
        typeOfGood: { '@id': copyId, '@type': 'Product', isBasedOn: { '@id': release } },
      },
    },
  };
  const archivalLoan = {
    ...row('retained', `loan:${loanId}`),
    target: release,
    raw: {
      libraryLoan: {
        id: loanId,
        copy: copyId,
        direction: 'lent',
        counterparty: { kind: 'name', name: 'Original fictional reader' },
        startedAt: '2026-01-02T00:00:00.000Z',
        dueAt: '2026-02-02T00:00:00.000Z',
        returnedAt: null,
        version: 1,
      },
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'LendAction',
        '@id': loanId,
        agent: { '@id': people.owner.actingSubject },
        object: { '@id': copyId },
        borrower: { name: 'Original fictional reader' },
        actionStatus: 'ActiveActionStatus',
      },
    },
  };
  originals = [
    statement,
    attempt,
    emptyShelf,
    ...Array.from({ length: 25 }, (_, index) => ({
      ...row('retained', `original-private-${index}`),
      raw: { note: `Private journal ${index}`, credit: 'Original fixture owner' },
    })),
    archivalCopy,
    archivalLoan,
  ];
  upload = (await json<{ id: string }>(create(originals), 201)).id;
}, 120_000);
afterAll(async () => {
  try {
    await importRecording.publish();
    await exportRecording.publish();
    await interruptedRecording.publish();
  } finally { await people?.close(); }
});

async function deniedImports(name: Exclude<PersonaName, 'owner'>) {
  const person = recordedPerson(importRecording, name),
    status = name === 'visitor' ? 401 : 403;
  const code = name === 'visitor' ? 'account_assertion_denied' : 'library_import_denied';
  // These are ordinary member routes. No row-relevant platform import operation exists.
  const calls: [string, string, object?][] = [
    [
      'POST',
      '/v1/me/library-imports',
      {
        ...own(),
        format: 'rezics',
        file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: originals }),
      },
    ],
    ['GET', `${root()}/rows?${query()}`],
    ['PUT', `${root()}/rows/0`, { ...own(), expectedVersion: 1, choice: 'private' }],
    ['POST', `${root()}/apply`, { ...own(), context: null, language: 'en' }],
    ['GET', `${root()}/apply?${query()}`],
    ['DELETE', `${root()}?${query()}`],
    ['POST', `${root()}/rows/0/adoptions`, { ...own(), workId: 'OL1W' }],
  ];
  for (const [method, path, body] of calls)
    await refused(person.main(method, path, body, randomUUID()), status, code);
}
async function deniedExport(name: Exclude<PersonaName, 'owner'>, resume = false) {
  const person = recordedPerson(resume ? interruptedRecording : exportRecording, name),
    page = resume ? await tokens() : undefined;
  const q = new URLSearchParams({
    ...own(),
    ...(page ? { cursor: page.nextCursor!, snapshot: page.snapshot } : {}),
  });
  // Platform-admin is established by personaSessions; it supplies no Person-control mandate.
  await refused(
    person.main('GET', `/v1/me/library-export?${q}`),
    name === 'visitor' ? 401 : 403,
    name === 'visitor' ? 'account_assertion_denied' : 'library_export_denied',
  );
  if (page && person.actingSubject) {
    q.set('actingSubject', person.actingSubject);
    await refused(person.main('GET', `/v1/me/library-export?${q}`), 400, 'invalid_work_read');
  }
}
async function noActiveLendingEffects(person: PersonaSession = people.owner) {
  expect(
    await json(person.main('GET', `/v1/works/${book.slice(-36)}/copies?${query(person)}`)),
  ).toMatchObject({ items: [], nextCursor: null, complete: true });
  expect(await json(person.main('GET', `/v1/me/library-loans?${query(person)}`))).toMatchObject({
    items: [],
    nextCursor: null,
    complete: true,
  });
}
function preserved(rows: CanonicalRow[]) {
  expect(
    rows
      .filter(
        (item) =>
          item.kind === 'retained' &&
          (item.sourceId.startsWith('original-private-') ||
            item.raw.libraryCopy ||
            item.raw.libraryLoan),
      )
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  ).toEqual(originals.slice(3).sort((a, b) => a.sourceId.localeCompare(b.sourceId)));
  expect(rows.find((item) => item.review)?.review).toEqual(originals[0]!.review);
  expect(rows.find((item) => item.sourceId === `status:${book}`)?.status).toBe('want-to-read');
  expect(rows.filter((item) => item.kind === 'session')).toHaveLength(1);
  expect(rows.find((item) => item.kind === 'session')?.session).toEqual(originals[1]!.session);
  expect(
    rows
      .filter((item) => item.kind === 'shelf')
      .map((item) => [item.shelves[0], item.raw.disclosure])
      .sort(),
  ).toEqual([
    ['Empty private shelf', 'private'],
    ['Private portable shelf', 'private'],
  ]);
  expect(
    rows
      .filter((item) => item.kind === 'entry' && typeof item.raw.shelfId === 'string')
      .map((item) => [item.work, item.shelves, item.raw.disclosure]),
  ).toEqual([[book, ['Private portable shelf'], 'private']]);
  expect(
    rows.some(
      (item) =>
        (item.raw.fields as Record<string, unknown> | undefined)?.privateJournal ===
        'Private journal',
    ),
  ).toBe(true);
}

function shelfState(rows: CanonicalRow[]) {
  return {
    shelves: rows
      .filter((item) => item.kind === 'shelf')
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    memberships: rows
      .filter((item) => item.kind === 'entry' && typeof item.raw.shelfId === 'string')
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}

async function samePersonReimport() {
  const requests: {
    method: string;
    path: string;
    body: unknown;
    key: string | undefined;
    status: number;
    answer: unknown;
  }[] = [];
  // This Person owns a separate library: a failed reimport cannot contaminate
  // the export recipient or the interrupted-export fixture, in any test order.
  const session = recordedPerson(importRecording, 'owner', people.member, 'same-person-reimport-');
  const person: PersonaSession = {
    ...session,
    main: async (method, path, body, key) => {
      const commandKey = key ?? (method === 'GET' ? undefined : randomUUID());
      const response = await session.main(method, path, body, commandKey);
      requests.push({
        method, path, body, key: commandKey, status: response.status,
        answer: await response.clone().json(),
      });
      return response;
    },
  };
  let before: CanonicalRow[] = [],
    after: CanonicalRow[] = [];
  const evidence = `.temp/goal/library-reimport-${Bun.env.REZICS_QA_RUN_ID}.json`;
  try {
    expect(await collect(read(undefined, undefined, 20, person), person)).toEqual([]);
    const initial = await json<{ id: string }>(create(originals, randomUUID(), person), 201);
    await applyOriginals(initial.id, person);
    const exported = await read(undefined, undefined, 20, person);
    before = await collect(Promise.resolve(exported), person);
    preserved(before);
    const originalShelves = shelfState(before);
    expect(originalShelves.shelves).toHaveLength(2);
    expect(originalShelves.memberships).toHaveLength(1);
    for (const shelf of originalShelves.shelves) {
      expect(shelf.raw.shelfId).toBe(shelf.sourceId);
      expect(shelf.raw.disclosure).toBe('private');
    }
    expect(originalShelves.shelves.map((shelf) => shelf.sourceId)).toContain(
      originalShelves.memberships[0]!.raw.shelfId,
    );
    // New intake and apply keys exercise reimport, rather than receipt replay.
    const reimport = await json<{ id: string; total: number }>(
      person.main(
        'POST',
        '/v1/me/library-imports',
        {
          ...own(person),
          format: 'rezics',
          file: JSON.stringify({
            profile: exported.profile, rows: before, snapshot: exported.snapshot,
          }),
        },
        randomUUID(),
      ),
      201,
    );
    expect(reimport.id).not.toBe(initial.id);
    expect(reimport.total).toBe(before.length);
    expect((await review(reimport.id, person)).map((item) => item.source)).toEqual(before);
    expect(await apply(reimport.id, randomUUID(), person)).toMatchObject({
      completed: before.length, total: before.length,
    });
    after = await collect(read(undefined, undefined, 20, person), person);
    await noActiveLendingEffects(person);
    expect(shelfState(after)).toEqual(originalShelves);
    preserved(after);
  } finally {
    mkdirSync('.temp/goal', { recursive: true });
    writeFileSync(evidence, JSON.stringify({
      actingSubject: person.actingSubject,
      requests, before, after, beforeShelves: shelfState(before), afterShelves: shelfState(after),
    }, null, 2));
    console.log(`Same-Person reimport requests, answers and identities: ${evidence}`);
  }
}

async function supportingReads(recording: OutcomeRecorder) {
  const sample = recording.session('owner', people.owner);
  const year = new Date().getUTCFullYear();
  const paths = [
    ['shelf-overview', `/v1/me/shelves?${query()}&limit=20`],
    ['library-visibility', `/v1/agents/${people.owner.actingSubject!.slice(-36)}/library-visibility`],
    ['rating-context', '/v1/rating-contexts?scope=global&limit=1'],
    ['reading-goal', `/v1/me/reading-goal?${query()}&year=${year}`],
    ['reading-stats', `/v1/me/reading-stats?${query()}&year=${year}`],
    ['followed-authors', `/v1/me/follows/authors?${query()}`],
  ] as const;
  for (const [label, path] of paths) await json(sample(label, 'GET', path));
}

outcomeTest(libraryImport, 'visitor', () => deniedImports('visitor'), importRecording);
outcomeTest(libraryImport, 'stranger', () => deniedImports('stranger'), importRecording);
outcomeTest(libraryImport, 'member', () => deniedImports('member'), importRecording);
outcomeTest(libraryImport, 'moderator', () => deniedImports('moderator'), importRecording);
outcomeTest(libraryImport, 'operator', () => deniedImports('operator'), importRecording);
outcomeTest(libraryImport, 'owner', async () => {
  const person = recordedPerson(importRecording, 'owner');
  const sample = importRecording.session('owner', people.owner);
  await json(sample('csv-inspection', 'POST', '/v1/me/library-imports', {
    ...own(), format: 'generic-csv', file: 'Title,Status\nOwned original Book,want-to-read\n',
  }, randomUUID()));
  await json(sample('csv-no-data-refused', 'POST', '/v1/me/library-imports', {
    ...own(), format: 'generic-csv', file: 'Title,Status\n',
  }, randomUUID()), 400);
  await json(sample('import-review-empty', 'GET', `${root()}/rows?${query()}&cursor=4999`, undefined, randomUUID()));
  await ensureApplied(person);
  const production = await json<Review>(sample(
    'production-import-review', 'GET', `${root()}/rows?${query()}`, undefined, randomUUID(),
  ));
  expect(production.rows.find(item => item.index === 0)?.source).toEqual(originals[0]);
  expect(production.rows.find(item => item.index === 0)?.source).toMatchObject({
    work: book, creators: ['Original fixture owner'],
    review: { text: 'Original private review', language: 'en', spoiler: true },
    shelves: ['Private portable shelf'], raw: { privateJournal: 'Private journal' },
  });
  preserved(await collect(read(undefined, undefined, 20, person), person));
  await noActiveLendingEffects(person);
  await refused(
    person.main('POST', `${root()}/rows/0/adoptions`, { ...own(), workId: 'OL1W' }),
    400,
    'invalid_library_file',
  );
  const disposable = (await json<{ id: string }>(create([originals[3]!], randomUUID(), person), 201)).id;
  await json(person.main('DELETE', `/v1/me/library-imports/${disposable}?${query()}`));
  await refused(
    person.main(
      'GET',
      `/v1/me/library-imports/${disposable}/rows?${query()}`,
      undefined,
      randomUUID(),
    ),
    404,
    'library_import_missing',
  );
  await samePersonReimport();
  await supportingReads(importRecording);
}, importRecording);
outcomeTest(libraryExport, 'visitor', () => deniedExport('visitor'), exportRecording);
outcomeTest(libraryExport, 'stranger', () => deniedExport('stranger'), exportRecording);
outcomeTest(libraryExport, 'member', () => deniedExport('member'), exportRecording);
outcomeTest(libraryExport, 'moderator', () => deniedExport('moderator'), exportRecording);
outcomeTest(libraryExport, 'operator', () => deniedExport('operator'), exportRecording);
outcomeTest(libraryExport, 'owner', async () => {
  const person = recordedPerson(exportRecording, 'owner');
  const sample = exportRecording.session('owner', people.owner);
  await ensureApplied(person);
  const before = await collect(read(undefined, undefined, 20, person), person);
  preserved(before);
  const first = await json<Page>(sample(
    'production-export-first-page', 'GET', `/v1/me/library-export?${query()}&limit=2`,
  ));
  expect(first.profile).toBe('rezics-library-export-v1');
  expect(first.nextCursor).toBeTruthy();
  expect(first.snapshot).toBeTruthy();
  expect(first.rows).toEqual(before.slice(0, 2));
  // The production continuation omits limit and uses this unchanged read basis.
  const remaining = await json<Page>(sample(
    'production-export-continuation', 'GET',
    `/v1/me/library-export?${query()}&cursor=${encodeURIComponent(first.nextCursor!)}&snapshot=${encodeURIComponent(first.snapshot)}`,
  ));
  expect(remaining.profile).toBe('rezics-library-export-v1');
  expect(remaining.snapshot).toBe(first.snapshot);
  expect(remaining.rows).toEqual(before.slice(first.rows.length, first.rows.length + remaining.rows.length));
  const tail = recordedPerson(exportRecording, 'owner', people.owner, 'production-export-remaining-');
  const assembled = [...first.rows, ...await collect(Promise.resolve(remaining), tail)];
  expect(assembled).toEqual(before);
  expect(new Set(assembled.map(item => item.sourceId)).size).toBe(assembled.length);
  preserved(assembled);
  const sourceSnapshot = (await read(undefined, undefined, 20, person)).snapshot;
  // Portability restores into an empty library under that destination Person's own authority.
  const destination = recordedPerson(exportRecording, 'owner', people.stranger, 'destination-');
  expect(await collect(read(undefined, undefined, 20, destination), destination)).toEqual([]);
  const restored = await json<{ id: string }>(
    destination.main('POST', '/v1/me/library-imports', {
      ...own(destination),
      format: 'rezics',
      file: JSON.stringify({
        profile: 'rezics-library-export-v1',
        rows: before,
        snapshot: sourceSnapshot,
      }),
    }),
    201,
  );
  expect((await review(restored.id, destination)).map((item) => item.source)).toEqual(before);
  await apply(restored.id, randomUUID(), destination);
  preserved(await collect(read(undefined, undefined, 20, destination), destination));
  await noActiveLendingEffects(destination);
  expect(await collect(read(undefined, undefined, 20, person), person)).toEqual(before);
  const cache = await person.main('GET', `/v1/me/library-export?${query()}`);
  expect(cache.status).toBe(200);
  expect(cache.headers.get('cache-control')).toBe('private, no-store');
  await supportingReads(exportRecording);
}, exportRecording);
outcomeTest(interruptedExport, 'visitor', () => deniedExport('visitor', true), interruptedRecording);
outcomeTest(interruptedExport, 'stranger', () => deniedExport('stranger', true), interruptedRecording);
outcomeTest(interruptedExport, 'member', () => deniedExport('member', true), interruptedRecording);
outcomeTest(interruptedExport, 'moderator', () => deniedExport('moderator', true), interruptedRecording);
outcomeTest(interruptedExport, 'operator', () => deniedExport('operator', true), interruptedRecording);
outcomeTest(interruptedExport, 'owner', async () => {
  const person = recordedPerson(interruptedRecording, 'owner');
  const sample = interruptedRecording.session('owner', people.owner);
  await ensureApplied(person);
  const first = await tokens();
  await json(sample('export-first-page', 'GET', `/v1/me/library-export?${query()}&limit=2&snapshot=${first.snapshot}`));
  await json(interruptedRecording.session('owner', people.moderator)('export-empty', 'GET',
    `/v1/me/library-export?${query(people.moderator)}`));
  // Discard a delivered page without acknowledging its nextCursor, then retry the prior cursor.
  const dropped = await read(first.nextCursor, first.snapshot, 20, person);
  const repeated = await read(first.nextCursor, first.snapshot, 20, person);
  expect(repeated.rows).toEqual(dropped.rows);
  expect(repeated.snapshot).toBe(first.snapshot);
  const assembled = [...first.rows, ...(await collect(Promise.resolve(repeated), person))];
  expect(assembled).toEqual(await collect(read(undefined, undefined, 20, person), person));
  preserved(assembled);
  expect(new Set(assembled.map((item) => item.sourceId)).size).toBe(assembled.length);
  await refused(
    person.main('GET', `/v1/me/library-export?${query()}&cursor=${first.nextCursor}`),
    409,
    'read_basis_changed',
  );
  await json(
    person.main('PUT', `/v1/me/import-reviews/${book.slice(-36)}`, {
      ...own(),
      text: 'Later original private review',
      language: 'en',
      spoiler: true,
      expectedVersion: 1,
    }),
  );
  await refused(
    person.main(
      'GET',
      `/v1/me/library-export?${query()}&cursor=${first.nextCursor}&snapshot=${first.snapshot}`,
    ),
    409,
    'read_basis_changed',
  );
  expect((await collect(read(undefined, undefined, 20, person), person)).find((item) => item.review)?.review?.text).toBe(
    'Later original private review',
  );
  await supportingReads(interruptedRecording);
}, interruptedRecording);
