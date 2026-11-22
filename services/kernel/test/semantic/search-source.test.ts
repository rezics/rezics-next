import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool, withQueryAccounting } from '../../src/database/pool.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/standard-question.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { documentActions } from '../../src/search/document.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const source = subjectSource(pool);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const ACTIONS = [
  'subject:create',
  'subject:read',
  'subject:merge',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
];
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000041' };
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
beforeAll(async () => {
  for (const action of [
    'subject:create',
    'subject:merge',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'moderation:hide',
    'moderation:takedown',
  ]) {
    await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  }
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  receiptKeys: testReceiptKeys(),
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

async function call(method: string, path: string, body?: unknown, key = randomUUID()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        ...(body === undefined ? {} : { 'idempotency-key': `"${key}"`, 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
async function ok(path: string, body: unknown, status = 200, key?: ReturnType<typeof randomUUID>) {
  const answer = await call('POST', path, body, key);
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(status);
  return answer.body;
}
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown) => ({ property: { id: property }, value: value(content) });
const person = async (name: string) =>
  (await ok('/v1/subjects', { type: 'schema:Person', labels: { en: name } }, 201)).subject as Record<string, any>;
const position = async (partition: number) =>
  BigInt(
    (await admin.query('SELECT position::text AS position FROM core.partition WHERE partition_no = $1', [partition]))
      .rows[0].position,
  );
const counted = async (id: string) => (await source.count(subjectPartition(id))).count;

test('rated search reads the indexed body and rating on the same backend across a concurrent commit', async () => {
  const { id } = await person('Concurrent rating');
  const home = subjectPartition(id);
  const route = routeOf(id)!;
  const original = await position(home);
  await admin.query(
    `INSERT INTO rating.public_figure
       (route, question_id, population_id, subject_id, count, mean, revision, as_of, position)
     VALUES ($1, $2, $3, $4, 5, 6.5, 1, transaction_timestamp(), $5)`,
    [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT, id, original.toString()],
  );
  const rated = createRatedSubjectSource(pool, new Uint8Array(32).fill(4)).source;
  let connections = 0;
  let changed = false;
  const statements: string[] = [];
  const snapshot = await withQueryAccounting(
    {
      connection(dispatch) {
        connections++;
        return dispatch();
      },
      async query(sql, _values, dispatch) {
        statements.push(sql);
        if (!changed && sql.includes('JOIN rating.public_figure')) {
          changed = true;
          await admin.query(
            `WITH advanced AS (
               UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING position
             )
             UPDATE rating.public_figure SET mean = 8, revision = 2, position = advanced.position
             FROM advanced WHERE route = $2 AND question_id = $3 AND population_id = $4 AND subject_id = $5`,
            [home, route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT, id],
          );
        }
        return dispatch();
      },
    },
    () => rated.read(home, [id, newId(route)]),
  );
  expect(changed).toBe(true);
  expect(connections).toBe(1);
  expect(statements.filter((sql) => sql.startsWith('BEGIN'))).toHaveLength(1);
  expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
  expect(snapshot.position).toBe(original);
  expect(snapshot.subjects).toHaveLength(1);
  expect(snapshot.subjects[0]).toMatchObject({
    id,
    labels: [{ language: 'en', value: 'Concurrent rating' }],
    publicRating: { subjectId: id, count: 5, mean: 6.5, revision: '1' },
  });
  const next = await rated.read(home, [id]);
  expect(next.position).toBe(original + 1n);
  expect(next.subjects[0]?.publicRating).toMatchObject({ subjectId: id, mean: 8, revision: '2' });
});

test('catalogue text candidates preserve current terms and defer adopted searchable names to full disclosure', async () => {
  const book = await ok(
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels: { en: 'A book', ja: '本' },
      descriptions: { en: 'A description' },
      aliases: { en: ['First alias', 'Second alias'] },
    },
    201,
  );
  const id: string = book.subject.id;
  const home = subjectPartition(id);
  const snapshot = await source.read(home, [id]);
  const { relationFacetOverflow, ...terms } = snapshot.subjects[0]!;
  expect(await source.readCatalogueTextCandidate!(id)).toEqual({ ...snapshot, subjects: [terms] });
  const absent = newId(routeOf(id)!);
  expect(await source.readCatalogueTextCandidate!(absent)).toEqual({ ...snapshot, subjects: [] });
  const rich = await ok(
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels: { en: 'A second book' },
      statements: { 'schema:name': [statement('schema:name', { language: 'en', text: 'An adopted title' })] },
    },
    201,
  );
  expect(await source.readCatalogueTextCandidate!(rich.subject.id)).toBeNull();
});

test("the source reads a subject's terms and adopted Global statements in one snapshot at the partition position", async () => {
  const soseki = await person('Natsume Soseki');
  const work = (
    await ok(
      '/v1/subjects',
      {
        type: 'schema:Movie',
        labels: { en: 'I Am a Cat', ja: '吾輩は猫である' },
        descriptions: { en: 'A film adaptation' },
        aliases: { ja: ['猫'], en: ['Wagahai wa Neko de Aru', 'I am a cat'] },
        statements: {
          'schema:name': [statement('schema:name', { language: 'ja', text: '吾輩は猫である' })],
          'schema:alternateName': [
            statement('schema:alternateName', { language: 'ja-Latn', text: 'Wagahai wa Neko de Aru' }),
          ],
          'schema:author': [statement('schema:author', soseki.id)],
          'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
          'schema:datePublished': [
            statement('schema:datePublished', {
              time: '+1905-01-01T00:00:00Z',
              precision: 11,
              calendarmodel: GREGORIAN,
            }),
          ],
        },
      },
      201,
    )
  ).subject as Record<string, any>;
  const proposed = await ok(
    `/v1/subjects/${work.id}/candidates`,
    {
      statement: {
        ...statement('schema:inLanguage', 'en'),
        references: [{ parts: [statement('schema:url', 'https://example.org/record')] }],
      },
    },
    201,
  );
  expect(proposed.candidate).toBeString();

  const partition = subjectPartition(work.id);
  const absent = newId(routeOf(work.id)!);
  const snapshot = await source.read(partition, [work.id, absent]);
  expect(snapshot).toEqual({
    partition,
    position: await position(partition),
    subjects: [
      {
        id: work.id,
        type: 'schema:Movie',
        relationFacetOverflow: expect.arrayContaining(['schema:author']),
        visibility: 'visible',
        redirect: null,
        securityRevision: 0,
        labels: [
          { language: 'en', value: 'I Am a Cat' },
          { language: 'ja', value: '吾輩は猫である' },
        ],
        aliases: [
          { language: 'en', value: 'Wagahai wa Neko de Aru' },
          { language: 'en', value: 'I am a cat' },
          { language: 'ja', value: '猫' },
        ],
        descriptions: [{ language: 'en', value: 'A film adaptation' }],
        statements: expect.arrayContaining([
          { property: 'schema:name', value: '吾輩は猫である', language: 'ja' },
          { property: 'schema:alternateName', value: 'Wagahai wa Neko de Aru', language: 'ja-Latn' },
          { property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } },
          {
            property: 'schema:datePublished',
            value: '+1905-01-01T00:00:00Z',
            facet: { kind: 'time', year: 1905, month: 1, day: 1 },
          },
        ]),
      },
    ],
  });
  expect(snapshot.subjects[0]!.statements).toHaveLength(4);
  const indexed = documentActions(snapshot, [work.id])[0]!;
  expect(indexed).toMatchObject({
    op: 'index',
    document: { names: expect.arrayContaining(['吾輩は猫である', 'Wagahai wa Neko de Aru']) },
  });

  const elsewhere = newId((routeOf(work.id)! + 16) % 65_536);
  const names = subjectSource(pool, new Uint8Array(32).fill(4)).readBookCandidateNames!;
  const { relationFacetOverflow, ...book } = snapshot.subjects[0]!;
  expect(relationFacetOverflow).toContain('schema:author');
  const window = await names([work.id, absent, elsewhere]);
  expect(window?.get(partition)).toEqual({
    ...snapshot,
    subjects: [
      {
        ...book,
        aliases: [],
        descriptions: [],
        statements: book.statements.filter(({ property }) => property === 'schema:inLanguage'),
      },
    ],
  });
  expect(window?.get(subjectPartition(elsewhere))?.subjects).toEqual([]);

  const [language] = work.statements['schema:inLanguage'].map(({ id }: { id: string }) => id);
  await ok(`/v1/subjects/${work.id}/candidates/${language}:hide`, { reason: 'spam' });
  const hidden = (await source.read(partition, [work.id])).subjects[0]!;
  expect(hidden.securityRevision).toBe(1);
  expect(hidden.statements.map(({ property }) => property).sort()).toEqual([
    'schema:alternateName',
    'schema:datePublished',
    'schema:name',
  ]);
  expect((await names([work.id]))?.get(partition)?.subjects[0]).toMatchObject({
    securityRevision: 1,
    statements: [],
  });

  await expect(source.read(partition, [elsewhere])).rejects.toThrow(TypeError);
  await expect(
    source.read(
      partition,
      Array.from({ length: 257 }, () => newId(routeOf(work.id)!)),
    ),
  ).rejects.toThrow(TypeError);
});

test('complete work-link reads distinguish absence from concealed targets without returning hidden identities', async () => {
  const work = (await ok('/v1/subjects', { type: 'schema:Book', labels: { en: 'Link source work' } }, 201))
    .subject as Record<string, any>;
  const edition = (
    await ok(
      '/v1/subjects',
      {
        type: 'bf:Instance',
        labels: { en: 'Link source edition' },
        statements: { 'schema:exampleOfWork': [statement('schema:exampleOfWork', work.id)] },
      },
      201,
    )
  ).subject as Record<string, any>;
  const routeKey = new Uint8Array(32).fill(4);
  const links = subjectSource(pool, routeKey).readCompleteWorkLinks;
  const home = subjectPartition(edition.id);
  let key = randomUUID();
  while (subjectPartition(subjectTarget(routeKey, accounts.editor, key).id) !== home) key = randomUUID();
  const missing = (await ok('/v1/subjects', { type: 'bf:Instance', labels: { en: 'Unlinked edition' } }, 201, key))
    .subject as Record<string, any>;

  const reservations: { operations: number; keys: number }[] = [];
  const current = await links(home, [edition.id, missing.id], {
    reserve: (reservation) => reservations.push(reservation),
  });
  expect(current.get(edition.id)).toEqual({ complete: true, values: [{ kind: 'work', id: work.id }] });
  expect(current.get(missing.id)).toEqual({ complete: true, values: [] });
  expect(reservations.reduce((total, reservation) => total + reservation.operations, 0)).toBeGreaterThan(0);
  expect(reservations.reduce((total, reservation) => total + reservation.keys, 0)).toBeGreaterThan(0);

  await ok(`/v1/subjects/${work.id}:hide`, { reason: 'private target' });
  const concealed = await links(home, [edition.id]);
  expect(concealed.get(edition.id)).toEqual({ complete: true, values: [{ kind: 'unknown' }] });
  expect(JSON.stringify(concealed.get(edition.id))).not.toContain(work.id);
});

test('hidden and taken-down subjects are reported for deletion and the count follows restoration', async () => {
  const subject = await person('Mori Ogai');
  const before = await counted(subject.id);
  await ok(`/v1/subjects/${subject.id}:hide`, { reason: 'spam' });
  expect(await counted(subject.id)).toBe(before - 1);
  await ok(`/v1/subjects/${subject.id}:takedown`, {
    notice: { complaint: 'Rights holder notice.', received_at: '2026-10-25T09:00:00Z' },
  });
  expect(await counted(subject.id)).toBe(before - 1);
  const takenDown = (await source.read(subjectPartition(subject.id), [subject.id])).subjects[0]!;
  expect([takenDown.visibility, takenDown.securityRevision]).toEqual(['taken_down', 2]);
  await ok(`/v1/subjects/${subject.id}:restore`, { reason: 'Counter-notice accepted.' });
  expect(await counted(subject.id)).toBe(before);
});

test('every command that appends a revision names the subject in a subject event', async () => {
  const subject = await person('Akutagawa Ryunosuke');
  const proposed = await ok(
    `/v1/subjects/${subject.id}/candidates`,
    {
      statement: {
        ...statement('schema:birthDate', { time: '+1892-03-01T00:00:00Z', precision: 11, calendarmodel: GREGORIAN }),
        references: [{ parts: [statement('schema:url', 'https://example.org/record')] }],
      },
    },
    201,
  );
  const candidate = proposed.candidate as string;
  await ok(`/v1/subjects/${subject.id}/candidates/${candidate}:accept`, {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  await ok(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:birthDate',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: null,
  });
  const { rows } = await admin.query(
    `SELECT type, data FROM core.outbox
     WHERE partition_no = $1 AND subject = $2 AND type LIKE 'com.rezics.subject.%'
     ORDER BY position, event_seq`,
    [subjectPartition(subject.id), subject.id],
  );
  expect(rows).toEqual([
    { type: 'com.rezics.subject.created.v1', data: { id: subject.id } },
    { type: 'com.rezics.subject.revised.v1', data: { id: subject.id, revision: 2, kind: 'propose' } },
    { type: 'com.rezics.subject.revised.v1', data: { id: subject.id, revision: 3, kind: 'accept' } },
    { type: 'com.rezics.subject.revised.v1', data: { id: subject.id, revision: 4, kind: 'adopt' } },
  ]);
  const read = (await source.read(subjectPartition(subject.id), [subject.id])).subjects[0]!;
  expect(read.statements).toEqual([
    {
      property: 'schema:birthDate',
      value: '+1892-03-01T00:00:00Z',
      facet: { kind: 'time', year: 1892, month: 3, day: 1 },
    },
  ]);
});
