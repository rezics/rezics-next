import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { GrowthSample, Population } from '../support/growth.ts';
import { capture, costOf, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { createSubject, readSubject } from '../../src/semantic/subject.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts, type Fact } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { listSubjectRelations } from '../../src/semantic/links.ts';
import type { AccountActor } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
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
  qualifiers: [],
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
        'semantic.outbound_link': [
          {
            route: anchorRoute,
            subject_id: anchor,
            property: 'schema:author',
            filter_value: NIL,
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
          },
        ],
      };
    },
    finish: async (admin, range) => {
      await admin.query(
        `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
         VALUES ($1,$2,'schema:author',$3,$4)
         ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
        [anchorRoute, anchor, NIL, range.to],
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

async function grow(previous: number, scale: number): Promise<void> {
  await seed({ pool: db.pool, admin: db.admin }, population, { from: previous, to: scale });
  await db.admin.query('ANALYZE semantic.subject');
  await db.admin.query('ANALYZE semantic.fact');
  await db.admin.query('ANALYZE semantic.outbound_link');
  await db.admin.query('ANALYZE semantic.outbound_link_count');
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
        filter: null,
        type: null,
        language: null,
      },
    },
    { epoch: 1, after: [key, target, statementId] },
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
  people = Array.from({ length: 3_000 }, () => newId(anchorRoute));
  peopleLabels = people.map((id, index) => rowsFor(id, { labels: { en: `Author ${String(index).padStart(4, '0')}` } }));
  relationFacts = people.map((id) =>
    rowsFor(
      anchor,
      { labels: { en: 'Relation growth anchor' }, statements: { 'schema:author': [statement(id)] } },
      bundledRelease,
    ).find((fact) => fact.kind === 'statement')!,
  );
  population = createPopulation();
}, 60_000);

afterAll(async () => {
  if (db) await db.close();
});

test('A subject read examines the same rows whatever the number of relations it holds', async () => {
  const samples: GrowthSample[] = [];
  let previous = 0;
  for (const scale of [100, 1_000, 3_000]) {
    await grow(previous, scale);
    const pageCursor = middleCursor(scale);
    const measured = await capture(db, async () => {
      const subject = await readSubject(db.pool, anchor, async () => true, GLOBAL_CONTEXT);
      if (!subject) throw new Error('Growth anchor disappeared');
      const page = await listSubjectRelations(db.pool, tokenRing, {
        subject: anchor,
        property: 'schema:author',
        context: GLOBAL_CONTEXT,
        limit: 25,
        cursor: pageCursor,
        release: bundledRelease,
        authorize: async () => true,
        seen: [],
        caughtUp: true,
      });
      if (subject.subject.statements['schema:author']?.length !== 12)
        throw new Error(`Expected a 12 statement preview at ${scale}`);
      if (subject.subject.relationCounts['schema:author'] !== scale)
        throw new Error(`Expected ${scale} relation count, got ${subject.subject.relationCounts['schema:author']}`);
      if (page.relations.length !== 25 || page.count.value !== scale)
        throw new Error(`Expected a 25 statement middle page at ${scale}`);
      return { subject: subject.subject, page };
    });
    samples.push({ scale, cost: costOf(measured.capture) });
    previous = scale;
  }

  const first = samples[0]!.cost;
  const allowedRows = Math.max(2, first.rows * 0.1);
  const allowedBlocks = Math.max(4, first.blocks * 0.5);
  expect(Math.max(...samples.map(({ cost }) => cost.rows)) - first.rows).toBeLessThanOrEqual(allowedRows);
  expect(Math.max(...samples.map(({ cost }) => cost.blocks)) - first.blocks).toBeLessThanOrEqual(allowedBlocks);
  expect(samples.map(({ cost }) => cost.statements)).toEqual([first.statements, first.statements, first.statements]);
});
