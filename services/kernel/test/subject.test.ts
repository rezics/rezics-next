import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { IdempotencyConflictError } from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';
import type { AccountActor } from '../src/request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../src/route/route.ts';
import { itemFacts, resolveItem, SubjectInputError } from '../src/semantic/item.ts';
import {
  createSubject,
  readLabels,
  readSubject,
  SubjectAccessDeniedError,
  subjectTarget,
} from '../src/semantic/subject.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const routeKey = new Uint8Array(32).fill(7);
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const allow = async () => true;
const digest = (text: string) => createHash('sha256').update(text).digest();
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const soseki = newId(0x1234);
const novel = newId(0x5678);
const shortStory = newId(0x9abc);
const source = {
  property: { id: 'schema:url' },
  value: { type: 'value', content: 'https://www.aozora.gr.jp/cards/000148/card773.html' },
};
const book = {
  labels: { en: 'Kokoro', ja: 'こゝろ' },
  descriptions: { en: 'novel by Natsume Sōseki' },
  aliases: { ja: ['心', 'こころ'] },
  statements: {
    'schema:author': [
      {
        property: { id: 'schema:author' },
        value: { type: 'value', content: soseki },
        references: [{ parts: [source] }],
      },
      { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
    ],
    'schema:genre': [
      { property: { id: 'schema:genre' }, value: { type: 'value', content: novel }, rank: 'preferred' },
      { property: { id: 'schema:genre' }, value: { type: 'value', content: shortStory }, rank: 'deprecated' },
    ],
    'schema:isbn': [
      {
        property: { id: 'schema:isbn' },
        value: { type: 'value', content: '978-4-10-101013-7' },
        references: [{ parts: [source] }],
      },
    ],
    'schema:numberOfPages': [
      {
        property: { id: 'schema:numberOfPages' },
        value: { type: 'value', content: { amount: '+384', unit: '1' } },
        qualifiers: [{ property: { id: 'schema:url' }, value: { type: 'novalue' } }],
      },
    ],
  },
};
async function partitionPosition(partition: number): Promise<bigint> {
  const { rows } = await admin.query('SELECT position FROM core.partition WHERE partition_no = $1', [partition]);
  return BigInt(rows[0].position);
}
function create(
  item: unknown,
  key = randomUUID(),
  options: { digest?: Uint8Array; authorize?: () => Promise<boolean> } = {},
) {
  return createSubject(pool, {
    actor,
    target: subjectTarget(routeKey, actor.accountId, key),
    idempotencyKey: key,
    digest: options.digest ?? digest(JSON.stringify(item)),
    item,
    authorize: options.authorize ?? allow,
  });
}

test('a created book is anchored by its idempotency key and reads back as a Wikibase item', async () => {
  const key = randomUUID();
  const created = await create(book, key);
  const route = anchorRoute(routeKey, `${actor.accountId}\nsubject.create\n${key}`);
  const { subject } = created;
  expect(routeOf(subject.id)).toBe(route);
  expect(created.component).toEqual({
    partition: partitionOf(route),
    epoch: 1,
    position: await partitionPosition(partitionOf(route)),
  });
  expect(created.replayed).toBe(false);
  expect(subject).toEqual(resolveItem(subject.id, itemFacts(subject.id, book)));
  expect(subject.labels).toEqual(book.labels);
  const statements = Object.values(subject.statements).flat();
  expect(statements).toHaveLength(6);
  for (const entry of statements) expect(routeOf(entry.id)).toBe(route);
  expect(await readSubject(pool, subject.id, allow)).toEqual({ subject, component: created.component });
});

test('each value is one compact fact row in its slot log, written under the command write basis', async () => {
  const { subject, component } = await create(book);
  const route = routeOf(subject.id)!;
  const { rows: key } = await admin.query(
    `SELECT array_agg(a.attname ORDER BY k.ordinality)::text[] AS columns
     FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = 'semantic.fact'::regclass AND i.indisprimary`,
  );
  expect(key[0].columns).toEqual(['route', 'subject_id', 'slot_id', 'log_seq']);
  const { rows: facts } = await admin.query(
    `SELECT slot_id, array_agg(log_seq ORDER BY log_seq) AS seqs, array_agg(DISTINCT recorded_transaction_id) AS transactions
     FROM semantic.fact WHERE route = $1 AND subject_id = $2 GROUP BY slot_id`,
    [route, subject.id],
  );
  // Two labels, one description, the two Japanese aliases and six statements, in eight slots.
  expect(facts.map((slot) => slot.seqs.length).reduce((a: number, b: number) => a + b, 0)).toBe(11);
  expect(facts).toHaveLength(8);
  for (const slot of facts) {
    expect(slot.slot_id).toMatch(UUID_V8);
    expect(routeOf(slot.slot_id)).toBe(route);
    expect(slot.seqs).toEqual(slot.seqs.map((_: number, index: number) => index + 1));
  }
  const transactions = new Set(facts.flatMap((slot) => slot.transactions));
  expect(transactions.size).toBe(1);
  const { rows: basis } = await admin.query(
    'SELECT transaction_id, actor_account_id, client_id, requested_by FROM editorial.write_basis WHERE partition_no = $1 AND position = $2',
    [component.partition, String(component.position)],
  );
  expect(basis).toEqual([
    { transaction_id: [...transactions][0], actor_account_id: actor.accountId, client_id: 'web', requested_by: null },
  ]);
  const { rows: subjects } = await admin.query(
    'SELECT type, recorded_transaction_id FROM semantic.subject WHERE route = $1 AND subject_id = $2',
    [route, subject.id],
  );
  expect(subjects).toEqual([{ type: 'schema:Book', recorded_transaction_id: [...transactions][0] }]);
  const { rows: events } = await admin.query(
    'SELECT event_count, type, subject, data FROM core.outbox WHERE partition_no = $1 AND position = $2',
    [component.partition, String(component.position)],
  );
  expect(events).toEqual([
    { event_count: 1, type: 'com.rezics.subject.created.v1', subject: subject.id, data: { id: subject.id } },
  ]);
});

test('a retried create returns the same subject and a changed request under the same key is refused', async () => {
  const key = randomUUID();
  const first = await create(book, key);
  const before = await partitionPosition(first.component.partition);
  const again = await create(book, key);
  expect(again).toEqual({ ...first, replayed: true });
  const changed = { ...book, labels: { en: 'Kokoro (1914)' } };
  expect(await create(changed, key).catch((error: unknown) => error)).toBeInstanceOf(IdempotencyConflictError);
  expect(await partitionPosition(first.component.partition)).toBe(before);
});

test('invalid input is refused before anything is written', async () => {
  const key = randomUUID();
  const partition = partitionOf(anchorRoute(routeKey, `${actor.accountId}\nsubject.create\n${key}`));
  const before = await partitionPosition(partition);
  let checks = 0;
  const error = await create({ labels: { en: 'x' }, statements: { 'schema:publisher': [] } }, key, {
    authorize: async () => {
      checks++;
      return true;
    },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SubjectInputError);
  expect((error as SubjectInputError).violations).toEqual([
    { pointer: '/statements/schema:publisher', code: 'unsupported' },
  ]);
  expect(checks).toBe(0);
  expect(await partitionPosition(partition)).toBe(before);
  expect(await create(book, key)).toMatchObject({ replayed: false });
});

test('a denied create writes nothing, so the same key may be used once it is allowed', async () => {
  const key = randomUUID();
  const partition = partitionOf(anchorRoute(routeKey, `${actor.accountId}\nsubject.create\n${key}`));
  const before = await partitionPosition(partition);
  let checks = 0;
  const deny = async () => {
    checks++;
    return false;
  };
  expect(await create(book, key, { authorize: deny }).catch((error: unknown) => error)).toBeInstanceOf(
    SubjectAccessDeniedError,
  );
  expect(checks).toBe(1);
  expect(await partitionPosition(partition)).toBe(before);
  const allowed = await create(book, key);
  expect(allowed.replayed).toBe(false);
});

test('labels of referenced subjects are read in their own partitions', async () => {
  const created = await Promise.all(
    [{ en: 'Natsume Sōseki', ja: '夏目漱石' }, { en: 'novel' }, { ja: '短編小説' }].map((labels) => create({ labels })),
  );
  const ids = created.map((entry) => entry.subject.id);
  const labels = await readLabels(pool, [...ids, ids[0]!, newId(0x0042), 'not-an-id']);
  expect(labels).toEqual(
    new Map([
      [ids[0]!, { en: 'Natsume Sōseki', ja: '夏目漱石' }],
      [ids[1]!, { en: 'novel' }],
      [ids[2]!, { ja: '短編小説' }],
    ]),
  );
});

test('an unknown or malformed id reads as nothing', async () => {
  expect(await readSubject(pool, newId(0x0042), allow)).toBeNull();
  expect(await readSubject(pool, 'not-an-id', allow)).toBeNull();
  expect(await readSubject(pool, randomUUID(), allow)).toBeNull();
});

test('subject creation rejects document and media contents until content hooks are wired', () => {
  for (const property of ['schema:abstract', 'schema:image']) {
    const statement = { property: { id: property }, value: { type: 'value', content: null } };
    for (const [statements, pointer] of [
      [{ [property]: [statement] }, `/statements/${property}/0/value/content`],
      [
        {
          'schema:author': [
            { property: { id: 'schema:author' }, value: { type: 'somevalue' }, qualifiers: [statement] },
          ],
        },
        '/statements/schema:author/0/qualifiers/0/value/content',
      ],
      [
        {
          'schema:author': [
            { property: { id: 'schema:author' }, value: { type: 'somevalue' }, references: [{ parts: [statement] }] },
          ],
        },
        '/statements/schema:author/0/references/0/parts/0/value/content',
      ],
    ] as const) {
      try {
        itemFacts(soseki, { labels: { en: 'Example' }, statements });
        throw new Error('Expected rejection before content storage');
      } catch (error) {
        expect(error).toBeInstanceOf(SubjectInputError);
        expect((error as SubjectInputError).violations).toEqual([{ pointer, code: 'unsupported' }]);
      }
    }
  }
});
