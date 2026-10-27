import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { itemFacts, type Fact } from '../../src/semantic/item.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import {
  aggregateFixture,
  nil,
  property,
  ring,
  statement,
  type AggregateFixture,
} from './support/aggregate-disclosure.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let fixture: AggregateFixture;
let target: string;
let firstHidden: string;
let lastHidden: string;
let population: Population;
const sources = Array.from({ length: 4094 }, (_, ordinal) => newId(27616 + (ordinal % 4) * 16));
const unrelated = sources.map(() => newId(27800));
const labels = sources.map((_, ordinal) => `Source ${String(ordinal + 1).padStart(5, '0')}`);
const facts: Fact[][] = [];

beforeAll(async () => {
  db = await openGrowthDatabase(url);
  fixture = await aggregateFixture(db);
  target = (await fixture.create('Growth target')).id;
  firstHidden = (await fixture.create('Source 00000', [target])).id;
  lastHidden = (await fixture.create('Source 99999', [target])).id;
  await fixture.drain();
  await fixture.hide(firstHidden);
  await fixture.hide(lastHidden, 'takedown');
  // From here on, no projection.run or relay advances. Seed only native-shaped storage as the shared harness does.
  population = {
    name: 'semantic-aggregate-foreign-degree',
    hotPartition: partitionOf(routeOf(target)!),
    hotShare: 1,
    rows({ ordinal }) {
      const id = sources[ordinal]!;
      const route = routeOf(id)!;
      const transaction = randomUUID();
      const sourceFacts = itemFacts(
        id,
        { labels: { en: labels[ordinal]! }, statements: { [property]: [statement(target)] } },
        'schema:Book',
        bundledRelease,
      );
      facts[ordinal] = sourceFacts;
      const relation = sourceFacts.find((row) => row.kind === 'statement')!;
      const noise = unrelated[ordinal]!;
      const noiseTransaction = randomUUID();
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transaction,
            current_facts: sourceFacts.length,
            current_release: bundledDigest,
          },
          {
            route: routeOf(noise)!,
            subject_id: noise,
            type: 'schema:Person',
            recorded_transaction_id: noiseTransaction,
            current_facts: 1,
            current_release: bundledDigest,
          },
        ],
        'semantic.revision': [
          {
            route,
            subject_id: id,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transaction,
          },
          {
            route: routeOf(noise)!,
            subject_id: noise,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: noiseTransaction,
          },
        ],
        'semantic.fact': [
          ...sourceFacts.map((fact) => ({
            ...fact,
            route,
            subject_id: id,
            recorded_transaction_id: transaction,
            release: fact.kind === 'statement' ? bundledDigest : null,
            relation: fact.kind === 'statement',
          })),
          ...itemFacts(noise, { labels: { en: `Unrelated ${ordinal}` } }, 'schema:Person', bundledRelease).map(
            (fact) => ({
              ...fact,
              route: routeOf(noise)!,
              subject_id: noise,
              recorded_transaction_id: noiseTransaction,
              release: null,
            }),
          ),
        ],
        'semantic.outbound_link': [
          {
            route,
            subject_id: id,
            property,
            filter_value: nil,
            order_key: labelOrderKey({ en: 'Growth target' }),
            target_subject_id: target,
            statement_id: relation.statement_id,
            slot_id: relation.slot_id,
            relation: true,
            source_type: 'schema:Book',
            source_order_key: labelOrderKey({ en: labels[ordinal]! }),
            outbound_order: 'name',
            source_revision: 1,
            target_type: 'schema:Person',
            value: 'value',
            present: true,
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.outbound_link_count': [{ route, subject_id: id, property, filter_value: nil, value: 1 }],
        'semantic.inbound_link': [
          {
            route: routeOf(target)!,
            subject_id: target,
            property,
            filter_value: nil,
            source_subject_id: id,
            statement_id: relation.statement_id,
            source_revision: 1,
            source_type: 'schema:Book',
            order_key: labelOrderKey({ en: labels[ordinal]! }),
            present: true,
            recorded_transaction_id: transaction,
          },
        ],
      };
    },
    async finish(admin, range) {
      const additions = new Map<number, number>();
      for (let ordinal = range.from; ordinal < range.to; ordinal++) {
        for (const id of [sources[ordinal]!, unrelated[ordinal]!]) {
          const partition = partitionOf(routeOf(id)!);
          additions.set(partition, (additions.get(partition) ?? 0) + 1);
        }
      }
      for (const [partition, added] of additions)
        await admin.query('UPDATE semantic.partition_subjects SET visible=visible+$2 WHERE partition_no=$1', [
          partition,
          added,
        ]);
      await admin.query(
        `UPDATE semantic.inbound_link_count SET value=$1 WHERE context_id=$2 AND route=$3 AND subject_id=$4 AND property=$5 AND filter_value=$6`,
        [range.to + 2, GLOBAL_CONTEXT, routeOf(target), target, property, nil],
      );
    },
  };
});
afterAll(async () => {
  if (db) await db.close();
});

test('aggregate disclosure checks examine only bounded page candidates as foreign degree grows', async () => {
  const disclosures: { scale: number; page: string; hasCount: boolean; leaked: boolean }[] = [];
  const report = await checkGrowth(db, {
    name: 'current aggregate disclosure on first and deep foreign-source pages',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 5,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, population, {
        from: Math.max(0, previous - 2),
        to: scale - 2,
      });
      expect(await fixture.stored(target)).toBe(scale);
    },
    async operation(_database, scale) {
      const middle = Math.floor((scale - 2) / 2);
      const cursorFor = (type: string | null) =>
        encodeCursor(
          ring,
          { operation: 'subject.links', parameters: { subject: target, property, filter: null, type, language: null } },
          {
            epoch: 1,
            after: [
              labelOrderKey({ en: labels[middle]! }),
              sources[middle]!,
              facts[middle]!.find((row) => row.kind === 'statement')!.statement_id!,
            ],
          },
        );
      for (const [name, query] of [
        ['first', ''],
        ['deep', `&cursor=${encodeURIComponent(cursorFor(null))}`],
        ['typed-first', '&type=schema:Book'],
        ['typed-deep', `&type=schema:Book&cursor=${encodeURIComponent(cursorFor('schema:Book'))}`],
      ] as const) {
        const page = await fixture.inverse(target, `&limit=3${query}`);
        expect(page.links.length).toBeGreaterThan(0);
        expect(page.links.length).toBeLessThanOrEqual(3);
        expect(page.next).toEqual(expect.any(String));
        expect(page.freshness.consistency).toBe('eventual');
        disclosures.push({
          scale,
          page: name,
          hasCount: Object.hasOwn(page, 'count'),
          leaked: page.links.some((row: any) => row.subject === firstHidden || row.subject === lastHidden),
        });
      }
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  expect(report.samples.every((sample) => sample.cost.rows > 0 && sample.cost.statements > 0)).toBe(true);
  // Check disclosure after all native scales were measured, so an expected wire red cannot mask cost growth.
  expect(disclosures.filter((row) => row.hasCount || row.leaked)).toEqual([]);
}, 60_000);
