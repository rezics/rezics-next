import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Population } from '../support/growth.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { createSubject, readSubject } from '../../src/semantic/subject.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts, type Fact } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { listSubjectRelations } from '../../src/semantic/links.ts';
import {
  FRESHNESS_POLL_MS,
  FRESHNESS_WAIT_MS,
  linksCaughtUp,
  waitForSubjectLinks,
} from '../../src/semantic/link-freshness.ts';
import type { SessionComponent } from '../../src/tokens/session.ts';
import type { AccountActor } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const role = newId(513 * 16);
const arc = newId(513 * 16);
const NIL = '00000000-0000-0000-0000-000000000000';
const BASE_ROUTE = 513 * 16;
const tokenRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
  clientId: 'growth-relations',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const digest = new Uint8Array(32).fill(31);
const statement = (target: string) => ({
  property: { id: 'schema:author' },
  value: { type: 'value', content: target },
  qualifiers: [
    { property: { id: 'wdt:P3831' }, value: { type: 'value', content: role } },
    { property: { id: 'wdt:P518' }, value: { type: 'value', content: arc } },
  ],
  references: [],
});
const rowsFor = (subject: string, input: unknown, release?: typeof bundledRelease): Fact[] =>
  itemFacts(subject, input, 'schema:Book', release);

let db: GrowthDatabase;
let anchor = '';
let anchorRoute = 0;
let people: string[] = [];
let peopleLabels: Fact[][] = [];
let relationFacts: Fact[] = [];
let population: Population;
let growthHead: SessionComponent | undefined;

function createPopulation(): Population {
  let current: Population;
  current = {
    name: 'semantic-growth-relations',
    hotPartition: partitionOf(anchorRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const target = people[ordinal]!;
      const targetTransaction = randomUUID();
      const relationTransaction = randomUUID();
      const relationFact = relationFacts[ordinal]!;
      const key = labelOrderKey({ en: `Author ${String(ordinal).padStart(4, '0')}` });
      return {
        'semantic.subject': [
          {
            route: anchorRoute,
            subject_id: target,
            type: 'schema:Person',
            recorded_transaction_id: targetTransaction,
            visibility: 'visible',
            security_revision: 0,
            current_facts: 1,
            current_release: bundledDigest,
          },
        ],
        'semantic.revision': [
          {
            route: anchorRoute,
            subject_id: target,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: targetTransaction,
          },
          {
            route: anchorRoute,
            subject_id: anchor,
            revision: ordinal + 2,
            kind: 'adopt',
            release: bundledDigest,
            recorded_transaction_id: relationTransaction,
          },
        ],
        'semantic.fact': [
          ...peopleLabels[ordinal]!.map((fact) => ({
            ...fact,
            route: anchorRoute,
            subject_id: target,
            recorded_transaction_id: targetTransaction,
            release: null,
          })),
          {
            ...relationFact,
            route: anchorRoute,
            subject_id: anchor,
            recorded_transaction_id: relationTransaction,
            release: bundledDigest,
          },
        ],
        'semantic.outbound_link': [NIL, role, arc].map((filter_value) => ({
          route: anchorRoute,
          subject_id: anchor,
          property: 'schema:author',
          filter_value,
          order_key: key,
          target_subject_id: target,
          statement_id: relationFact.statement_id,
          slot_id: relationFact.slot_id,
          relation: true,
          source_type: 'schema:Book',
          source_order_key: '',
          outbound_order: 'name',
          source_revision: ordinal + 2,
          source_security_revision: 0,
          target_revision: 0,
          target_type: 'schema:Person',
          external: null,
          value: 'value',
          present: true,
          recorded_transaction_id: relationTransaction,
        })),
      };
    },
    finish: async (admin, range) => {
      await admin.query(
        `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
         SELECT $1,$2,'schema:author',filter_value,$4 FROM unnest($3::uuid[]) filter_value
         ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
        [anchorRoute, anchor, [NIL, role, arc], range.to],
      );
      if (range.to > range.from)
        await admin.query('UPDATE semantic.partition_subjects SET visible=visible+$2 WHERE partition_no=$1', [
          partitionOf(anchorRoute),
          range.to - range.from,
        ]);
    },
  };
  return current;
}

async function grow(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
}

function middleCursor(size: number): string {
  const after = Math.floor(size / 2) - 1;
  const key = labelOrderKey({ en: `Author ${String(after).padStart(4, '0')}` });
  const target = people[after]!;
  const statementId = relationFacts[after]!.statement_id!;
  return encodeCursor(
    tokenRing,
    {
      operation: 'subject.relations',
      parameters: {
        subject: anchor,
        property: 'schema:author',
        context: GLOBAL_CONTEXT,
        filter: arc,
        type: null,
        language: null,
      },
    },
    { epoch: 1, after: [key, target, statementId] },
  );
}

async function actualHead(database: GrowthDatabase): Promise<SessionComponent> {
  const result = await database.admin.query<{ partition_no: number; epoch: number; position: string }>(
    'SELECT partition_no, epoch, position FROM core.partition WHERE partition_no = $1',
    [partitionOf(anchorRoute)],
  );
  const head = result.rows[0];
  if (!head) throw new Error('Growth partition disappeared');
  return { partition: head.partition_no, epoch: head.epoch, position: BigInt(head.position) };
}

async function setCheckpoint(database: GrowthDatabase, position: bigint): Promise<void> {
  const head = await actualHead(database);
  await database.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     VALUES ($1, 'semantic_links', $2, $3)
     ON CONFLICT (partition_no, consumer) DO UPDATE
     SET epoch = EXCLUDED.epoch, position = EXCLUDED.position, updated_at = now()`,
    [head.partition, head.epoch, position],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await bootstrapRelease(db.pool, bundledRelease);
  await activeRelease(db.pool);
  anchor = newId(BASE_ROUTE);
  anchorRoute = routeOf(anchor)!;
  await createSubject(db.pool, {
    actor,
    target: { route: anchorRoute, id: anchor },
    idempotencyKey: randomUUID(),
    digest,
    item: { type: 'schema:Book', labels: { en: 'Relation growth anchor' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  people = Array.from({ length: 4_096 }, () => newId(anchorRoute));
  peopleLabels = people.map((id, index) => rowsFor(id, { labels: { en: `Author ${String(index).padStart(4, '0')}` } }));
  relationFacts = people.map((id) =>
    rowsFor(
      anchor,
      { labels: { en: 'Relation growth anchor' }, statements: { 'schema:author': [statement(id)] } },
      bundledRelease,
    ).find((fact) => fact.kind === 'statement')!,
  );
  population = createPopulation();
  growthHead = await actualHead(db);
}, 60_000);

afterAll(async () => {
  if (db) await db.close();
});

test('A subject read examines the same rows whatever the number of relations it holds', async () => {
  const report = await checkGrowth(db, {
    name: 'A subject read examines the same rows whatever the number of relations it holds',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 5,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    slack: {
      rows: { absolute: 2, relative: 0.1 },
      blocks: { absolute: 4, relative: 0.5 },
      statements: { absolute: 0, relative: 0 },
    },
    grow,
    prepare: async (database) => {
      const head = await actualHead(database);
      growthHead = head;
      await setCheckpoint(database, head.position);
      if (!(await linksCaughtUp(database.pool, [head], anchor, Date.now() + 30_000)))
        throw new Error('Seeded outbound projection did not reach the actual partition head');
    },
    operation: async (database, scale) => {
      const pageCursor = middleCursor(scale);
      const subject = await readSubject(database.pool, anchor, async () => true, GLOBAL_CONTEXT);
      if (!subject) throw new Error('Growth anchor disappeared');
      const page = await listSubjectRelations(database.pool, tokenRing, {
        subject: anchor,
        property: 'schema:author',
        context: GLOBAL_CONTEXT,
        filter: arc,
        limit: 25,
        cursor: pageCursor,
        release: bundledRelease,
        authorize: async () => true,
        seen: [],
      });
      if (subject.subject.statements['schema:author']?.length !== 12)
        throw new Error(`Expected a 12 statement preview at ${scale}`);
      if (subject.subject.relationCounts['schema:author'] !== scale)
        throw new Error(`Expected ${scale} relation count, got ${subject.subject.relationCounts['schema:author']}`);
      if (page.relations.length !== 25 || page.count.value !== scale || !page.count.exact)
        throw new Error(`Expected a 25 statement middle page at ${scale}`);
      return { subject: subject.subject, page };
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  console.info(
    'Growth median costs (1 warmup, 5 repetitions):',
    report.samples.map(({ scale, cost }) => ({
      scale,
      rows: cost.rows,
      blocks: cost.blocks,
      statements: cost.statements,
    })),
  );
});

test('a genuinely waiting link freshness probe has constant work per poll across relation growth', async () => {
  const waitBudget = FRESHNESS_WAIT_MS;
  const holdBehind = async (database: GrowthDatabase) => {
    const head = await actualHead(database);
    growthHead = head;
    if (head.position <= 0n) throw new Error('Waiting probe requires a nonzero actual partition head');
    await setCheckpoint(database, head.position - 1n);
  };
  const waitBehind = async (database: GrowthDatabase): Promise<boolean> => {
    const head = growthHead;
    if (!head) throw new Error('Growth partition head was not prepared');
    return waitForSubjectLinks(database.pool, [head], anchor, Date.now() + waitBudget * 2);
  };
  const report = await checkGrowth(db, {
    name: 'A genuinely waiting link freshness probe has constant work per poll across relation growth',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 5,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    slack: {
      rows: { absolute: 2, relative: 0.1 },
      blocks: { absolute: 4, relative: 0.5 },
      statements: { absolute: 0, relative: 0 },
    },
    grow,
    warmup: async (database) => {
      await holdBehind(database);
      if (await waitBehind(database)) throw new Error('The held semantic_links checkpoint unexpectedly caught up');
    },
    prepare: holdBehind,
    operation: async (database) => {
      const caughtUp = await waitBehind(database);
      if (caughtUp) throw new Error('The held semantic_links checkpoint unexpectedly caught up');
      return caughtUp;
    },
  });

  const perPollStatements: number[] = [];
  for (const sample of report.samples) {
    for (const run of sample.occurrenceRepetitions) {
      const polls = run.statements.filter(({ statement }) =>
        statement.includes('FROM core.consumer_checkpoint'),
      ).length;
      const statements = run.statements.length;
      expect(polls).toBeGreaterThan(0);
      expect(polls).toBeLessThanOrEqual(Math.ceil(waitBudget / FRESHNESS_POLL_MS) + 1);
      expect(statements % polls).toBe(0);
      perPollStatements.push(statements / polls);
    }
  }
  expect(new Set(perPollStatements).size).toBe(1);
});
