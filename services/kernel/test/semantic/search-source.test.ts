import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createRealAccess } from './real-access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

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
  routeKey: new Uint8Array(32).fill(4),
  writeRate: realAccess.writeRate,
});

async function call(method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        ...(body === undefined ? {} : { 'idempotency-key': `"${randomUUID()}"`, 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
async function ok(path: string, body: unknown, status = 200) {
  const answer = await call('POST', path, body);
  expect([path, answer.response.status]).toEqual([path, status]);
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

test("the source reads a subject's terms and adopted Global statements in one snapshot at the partition position", async () => {
  const soseki = await person('Natsume Soseki');
  const work = (
    await ok(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'I Am a Cat', ja: '吾輩は猫である' },
        descriptions: { en: 'A satirical novel' },
        aliases: { ja: ['猫'], en: ['Wagahai wa Neko de Aru', 'I am a cat'] },
        statements: {
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
        type: 'schema:Book',
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
        descriptions: [{ language: 'en', value: 'A satirical novel' }],
        statements: expect.arrayContaining([
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
  expect(snapshot.subjects[0]!.statements).toHaveLength(2);

  const [language] = work.statements['schema:inLanguage'].map(({ id }: { id: string }) => id);
  await ok(`/v1/subjects/${work.id}/candidates/${language}:hide`, { reason: 'spam' });
  const hidden = (await source.read(partition, [work.id])).subjects[0]!;
  expect(hidden.securityRevision).toBe(1);
  expect(hidden.statements.map(({ property }) => property).sort()).toEqual(['schema:datePublished']);

  const elsewhere = newId((routeOf(work.id)! + 16) % 65_536);
  await expect(source.read(partition, [elsewhere])).rejects.toThrow(TypeError);
  await expect(
    source.read(
      partition,
      Array.from({ length: 257 }, () => newId(routeOf(work.id)!)),
    ),
  ).rejects.toThrow(TypeError);
});

test('subjects that are not visible or redirected are reported for deletion and the count follows them', async () => {
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

  const [survivor, redirected] = [await person('Higuchi Ichiyo'), await person('Higuchi Natsu')]
    .map(({ id }) => id as string)
    .sort();
  const redirectedBefore = await counted(redirected!);
  await ok('/v1/subjects:merge', { subjects: [survivor, redirected] });
  expect(await counted(redirected!)).toBe(redirectedBefore - 1);
  const merged = (await source.read(subjectPartition(redirected!), [redirected!])).subjects[0]!;
  expect([merged.redirect, merged.visibility]).toEqual([survivor!, 'hidden']);
  const count = await source.count(subjectPartition(redirected!));
  expect(count.position).toBe(await position(subjectPartition(redirected!)));
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
