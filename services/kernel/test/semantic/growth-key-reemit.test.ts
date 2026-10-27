import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { LINK_KEYS_CHANGED } from '../../src/semantic/events.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import {
  capture,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Capture,
  type GrowthDatabase,
} from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const NIL = '00000000-0000-0000-0000-000000000000';
const FILTERS = [NIL, '00000000-0000-0000-0000-000000000001'];
const route = 18000;
const mirrorRoute = route + 16;
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'growth',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
let db: GrowthDatabase;

function relations(holder: string, target: string, holderRoute: number, targetRoute: number) {
  const statement = randomUUID();
  const slot = randomUUID();
  const transaction = randomUUID();
  return {
    'semantic.outbound_link': FILTERS.map((filter) => ({
      route: holderRoute,
      subject_id: holder,
      property: 'schema:author',
      filter_value: filter,
      order_key: '0initial',
      target_subject_id: target,
      statement_id: statement,
      slot_id: slot,
      relation: true,
      source_type: 'schema:Book',
      source_order_key: '0initial',
      outbound_order: 'name',
      source_revision: 1,
      source_security_revision: 0,
      target_revision: 1,
      target_type: 'schema:Book',
      external: null,
      value: 'value',
      present: true,
      recorded_transaction_id: transaction,
    })),
    'semantic.inbound_link': FILTERS.map((filter) => ({
      route: targetRoute,
      subject_id: target,
      property: 'schema:author',
      source_subject_id: holder,
      statement_id: statement,
      source_revision: 1,
      source_security_revision: 0,
      present: true,
      recorded_transaction_id: transaction,
      source_type: 'schema:Book',
      order_key: '0initial',
      filter_value: filter,
    })),
    // Relation slots are uncapped. Identity reads must not walk them to find a label/date key.
    'semantic.fact': [
      {
        route: holderRoute,
        subject_id: holder,
        slot_id: slot,
        log_seq: 1,
        operation: 'assert',
        kind: 'statement',
        language: null,
        property: 'schema:author',
        statement_id: statement,
        body: { rank: 'normal', value: { type: 'value', content: target }, qualifiers: [], references: [] },
        relation: true,
        release: bundledDigest,
        recorded_transaction_id: transaction,
      },
    ],
  };
}

beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  await seed(
    db,
    {
      name: 'key-reemit-history',
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows: ({ ordinal }) => {
        const holder = newId(route);
        const target = newId(mirrorRoute);
        const transaction = randomUUID();
        return {
          'semantic.subject': [holder, target].map((id, index) => ({
            route: index ? mirrorRoute : route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transaction,
            current_release: bundledDigest,
          })),
          'semantic.revision': [
            {
              route,
              subject_id: holder,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          ...relations(holder, target, route, mirrorRoute),
          'semantic.outbound_link_count': [
            { route, subject_id: holder, property: 'schema:author', filter_value: NIL, value: 1 },
          ],
          'semantic.inbound_link_count': [
            { route: mirrorRoute, subject_id: target, property: 'schema:author', filter_value: NIL, value: 1 },
          ],
          'core.outbox': [
            {
              partition_no: 4095,
              position: ordinal + 1,
              event_seq: 0,
              event_count: 1,
              epoch: 1,
              id: randomUUID(),
              type: 'fixture.history',
              data: {},
            },
          ],
          'core.consumer_checkpoint': [{ partition_no: ordinal, consumer: 'fixture_history' }],
        };
      },
    },
    { from: 0, to: 4096 },
  );
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

// costOf counts filtered rows and repeated index probes, not just returned rows. Inspect each SQL independently
// so a scan cannot hide behind aggregate growth tolerances or a LIMIT above a sort. Catalog classification is shared.
function pageViolations(raw: Capture, scale: number): string[] {
  const failures: string[] = [];
  const catalog = catalogStatementBound(raw);
  if (catalog.catalogStatements > catalog.allowedStatements)
    failures.push(`catalog probes ${catalog.catalogStatements} > ${catalog.allowedStatements}`);
  for (const document of raw.plans) {
    const entries = (Array.isArray(document) ? document : [document]) as { 'Query Text': string }[];
    for (const entry of entries) {
      const sql = entry['Query Text'];
      const cost = costOf({ statements: [sql], plans: [entry] });
      for (const [relation, work] of Object.entries(cost.relations)) {
        // One source page plus lookahead; mirror upserts may read old, retire old, write new and probe counters.
        const source = sql.includes('LIMIT 101');
        const limit = source ? 101 : 4 * 100 + 1;
        if (work.rows > limit)
          failures.push(`scale ${scale}: ${relation} examined ${work.rows} rows > ${limit}; SQL:\n${sql}`);
      }
    }
  }
  return failures;
}

async function checkDirection(direction: 'holder' | 'target') {
  const route = direction === 'holder' ? 18032 : 18064;
  const mirrorRoute = route + 16;
  const subject = newId(route);
  const mirror = newId(mirrorRoute);
  const holder = direction === 'holder' ? subject : mirror;
  const target = direction === 'holder' ? mirror : subject;
  const holderRoute = direction === 'holder' ? route : mirrorRoute;
  const targetRoute = direction === 'holder' ? mirrorRoute : route;
  const relay = linkProjection(db.pool);
  const partitions = [partitionOf(route), partitionOf(mirrorRoute)];
  const failures: string[] = [];
  for (const [id, at] of [
    [subject, route],
    [mirror, mirrorRoute],
  ] as const)
    await createSubject(db.pool, {
      actor,
      target: { route: at, id },
      idempotencyKey: id,
      digest: new Uint8Array(32),
      item: { type: 'schema:Book', labels: { en: 'Initial' } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });

  async function drain() {
    for (let step = 0; step < 100; step++) {
      let count = 0;
      for (const partition of partitions) {
        const result = await relay.run(partition);
        expect(result.status).toBe('read');
        if (result.status === 'read') count += result.envelopes;
      }
      if (count === 0) return;
    }
    throw new Error('Key continuation did not catch up within 100 batches');
  }
  let revision = 1;
  let key = '0initial';
  let degree = 0;
  async function verify(expected: number) {
    const result =
      direction === 'holder'
        ? await db.admin.query(
            `SELECT count(*)::int AS n FROM (
            SELECT * FROM semantic.inbound_link
            WHERE route=$1 AND subject_id=$2 AND source_subject_id=$3 AND present
            ORDER BY statement_id, filter_value LIMIT $6
          ) page WHERE source_revision=$4 AND order_key=$5 AND source_type='schema:Book'`,
            [targetRoute, target, holder, revision, key, expected],
          )
        : await db.admin.query(
            `SELECT count(*)::int AS n FROM (
            SELECT * FROM semantic.outbound_link
            WHERE route=$1 AND subject_id=$2 AND target_subject_id=$3 AND present
            ORDER BY statement_id, filter_value LIMIT $6
          ) page WHERE target_revision=$4 AND order_key=$5 AND target_type='schema:Book'`,
            [holderRoute, holder, target, revision, key, expected],
          );
    expect(result.rows[0].n).toBe(expected);
  }
  async function catchUp() {
    try {
      await drain();
      await verify(degree * FILTERS.length);
    } catch (error) {
      failures.push(`scale ${degree}: eventual ${direction} catch-up failed: ${String(error)}`);
      // A poisoned continuation must fail this acceptance, but must not prevent diagnostics at later scales.
      // Discard it only AFTER recording the failure. This is fixture recovery outside every measured step;
      // it can never make this test pass or stand in for successful eventual catch-up.
      for (const partition of partitions)
        await db.admin.query(
          `UPDATE core.consumer_checkpoint c SET position=p.position, epoch=p.epoch
          FROM core.partition p WHERE c.partition_no=p.partition_no AND c.partition_no=$1 AND c.consumer=$2`,
          [partition, relay.consumer],
        );
    }
  }
  async function prepare(repetition: number) {
    const label = `Changed ${direction} ${repetition}`;
    const result = await updateSubjectIdentity(db.pool, {
      subject,
      labels: { en: label },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });
    revision = result.value.revision;
    key = `0${label.toLowerCase()}`;
  }
  async function step() {
    // linkProjection.run uses projectBatch's finite log snapshot. With catch-up complete and one fresh identity
    // envelope, it executes one 100-link page (the other direction is empty). Continuations written by apply
    // are beyond that snapshot and require another run. Calling startRelays would instead drain them all.
    const result = await relay.run(partitionOf(route));
    expect(result.status).toBe('read');
    if (result.status === 'read') expect(result.envelopes).toBe(1);
    await verify(100);
    const pending = await db.admin.query(
      `SELECT data FROM core.outbox
      WHERE partition_no=$1 AND position>$2 AND type=$3 AND subject=$4`,
      [partitionOf(route), result.status === 'read' ? String(result.position) : '0', LINK_KEYS_CHANGED, subject],
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].data.direction).toBe(direction);
    expect(pending.rows[0].data.cursor).toHaveLength(4);
    expect(pending.rows[0].data.revision).toBe(revision);
  }
  await drain();
  try {
    const report = await checkGrowth(db, {
      name: `${direction} key re-emission`,
      scales: [64, 512, 4096],
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (_, scale, previous) => {
        if (previous) await catchUp();
        await seed(
          db,
          {
            name: `${direction}-key-degree`,
            hotPartition: partitionOf(route),
            hotShare: 1,
            rows: () => relations(holder, target, holderRoute, targetRoute),
            finish: async (admin) => {
              for (const [table, at, id] of [
                ['outbound_link_count', holderRoute, holder],
                ['inbound_link_count', targetRoute, target],
              ] as const)
                for (const filter of FILTERS)
                  await admin.query(
                    `INSERT INTO semantic.${table}(route,subject_id,property,filter_value,value)
                VALUES($1,$2,'schema:author',$3,$4) ON CONFLICT(route,subject_id,property,filter_value)
                DO UPDATE SET value=EXCLUDED.value`,
                    [at, id, filter, scale],
                  );
            },
          },
          { from: previous, to: scale },
        );
        // Two fixed filter rows per link fill a 100-row page even at degree 64. The qualifier fanout
        // stays two and the mirror partition count stays one at every scale; no small-page allowance.
        degree = scale;
        await prepare(scale);
      },
      warmup: async (_, scale, repetition) => {
        const measured = await capture(db, () => step());
        const cost = costOf(measured.capture);
        console.log(`${direction} warmup ${scale}: ${JSON.stringify(cost)}`);
        failures.push(...pageViolations(measured.capture, scale));
        await catchUp();
        // Consumable work: the measured run gets a new label, revision and envelope after the warmup drained.
        await prepare(repetition);
      },
      operation: async () => step(),
    });
    console.log(`${direction} measured: ${JSON.stringify(report.samples)}`);
  } catch (error) {
    console.error(`${direction} growth failure:`, error);
    if (error instanceof Error && 'samples' in error)
      console.error(`${direction} measured: ${JSON.stringify(error.samples)}`);
    throw error;
  } finally {
    // Kept outside capture: total catch-up legitimately grows with degree. Check even when cost is red.
    await catchUp();
    if (failures.length) console.error(`${direction} first page-bound failure: ${failures[0]}`);
    const catchUpFailure = failures.find((failure) => failure.includes('catch-up failed'));
    if (catchUpFailure) console.error(catchUpFailure);
  }
  expect(failures, failures[0]).toEqual([]);
}

test(
  'holder key re-emission processes a bounded page as its out-degree grows',
  () => checkDirection('holder'),
  120_000,
);
test('target key re-emission processes a bounded page as its in-degree grows', () => checkDirection('target'), 120_000);
