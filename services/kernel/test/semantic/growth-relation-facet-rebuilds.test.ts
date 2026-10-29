import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { runCommand } from '../../src/command/command.ts';
import type { Relay } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  assertGrowth,
  capture,
  costOf,
  medianCost,
  openGrowthDatabase,
  seed,
  settle,
  type Cost,
} from '../support/growth.ts';
import { writeSubject } from '../../src/semantic/subject.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const db = await openGrowthDatabase(url);
const routeKey = new Uint8Array(32).fill(84);
const editor = newId(30016);
const actions = ['subject:create', 'subject:batch_write', 'source_fence:takedown'];
const access = await createRealAccess(db.admin, { editor }, actions);
const kernel = createKernel({
  pool: db.pool,
  routeKey,
  access: access.access,
  writeRate: createWriteRateLimiter({
    secret: 'facet-rebuild-growth-test-secret-32',
    overrides: JSON.stringify(
      Object.fromEntries(
        ['anonymous', 'new-account', 'member', 'trusted', 'service'].map((p) => [
          p,
          { write: { maximum: 1000000, seconds: 60 } },
        ]),
      ),
    ),
  }),
});
const release = structuredClone(bundledRelease);
release.catalogue = { id: 'https://example.test/facet-rebuild-growth', version: '1' };
release.types['schema:Book']!.facets = ['schema:author'];
release.types['schema:Book']!.properties = ['schema:author', 'schema:contributor'];
release.filters = {};
const consumer = 'semantic_relation_facet_rebuilds';
const changed = 'com.rezics.subject.relation_facet_changed.v1';
const continued = 'com.rezics.semantic.facet_rebuild.continued.v1';
const pageSize = 4;
const sourceRoutes = [32000, 32016]; // Fixed source partition count at every scale.
const source = {
  source: 'openlibrary',
  external_id: randomUUID(),
  field_group: 'facts' as const,
  record_revision: 'unversioned',
  digest: 'e'.repeat(64),
  converter_revision: 'openlibrary@1',
};
let tuple = tupleRoute(routeKey, source.source, source.external_id);
while (sourceRoutes.map(partitionOf).includes(partitionOf(tuple))) {
  source.external_id = randomUUID();
  tuple = tupleRoute(routeKey, source.source, source.external_id);
}
const home = partitionOf(tuple);
const partitions = [...new Set([home, ...sourceRoutes.map(partitionOf)])];
const ids: string[] = [];
let target: string;
let worker: Relay;
let revision = '';
let priorEvents = 0;
let priorContinuation = 0;

const snak = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });

beforeAll(async () => {
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await bootstrapRelease(db.pool, release);
});
afterAll(() => db.close());
async function post(path: string, body: unknown, key = randomUUID()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.bearer('editor')}`,
        'idempotency-key': `"${key}"`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  const result = (await response.json()) as any;
  expect(response.status, JSON.stringify(result)).toBe(path === '/v1/subjects' ? 201 : 200);
  return result;
}
async function createAt(route: number, type = 'schema:Book') {
  const id = newId(route);
  await runCommand(db.pool, { partition: partitionOf(route) }, (tx, { transactionId }) =>
    writeSubject(tx, transactionId, {
      target: { route, id },
      item: {
        type,
        labels: { en: 'Growth source' },
      },
      release: { digest: releaseDigest(release), release },
    }),
  );
  return id;
}
async function drain() {
  for (let round = 0; round < 30000; round++) {
    let count = 0;
    for (const partition of partitions) {
      const result = await worker.run(partition);
      expect(result.status).toBe('read');
      if (result.status === 'read') count += result.envelopes;
    }
    if (!count) return;
  }
  throw new Error('Facet rebuild catch-up did not finish');
}
async function count(type: string) {
  return Number(
    (
      await db.admin.query("SELECT count(*) FROM core.outbox WHERE type=$1 AND data->>'external_id'=$2", [
        type,
        source.external_id,
      ])
    ).rows[0].count,
  );
}
async function verify(scale: number, measuredPage: boolean) {
  if (measuredPage) {
    expect(await count(changed)).toBe(priorEvents + pageSize);
    expect(await count(continued)).toBe(priorContinuation + 1);
  }
  await drain();
  const rows = await db.admin.query(
    "SELECT partition_no,subject FROM core.outbox WHERE type=$1 AND data->>'external_id'=$2 AND data->>'securityRevision'=$3",
    [changed, source.external_id, revision],
  );
  expect(rows.rows.map((row) => row.subject).sort()).toEqual([...ids].sort());
  expect(rows.rows).toHaveLength(scale);
  for (const row of rows.rows) expect(row.partition_no).toBe(partitionOf(routeOf(row.subject)!));
}
async function prepare() {
  await post('/v1/sourceFences:takedown', {
    source: source.source,
    externalId: source.external_id,
    fieldGroup: 'facts',
    reason: 'Growth continuation cause',
  });
  // The first page is setup. Internal bookkeeping envelopes can precede its continuation.
  const result = await worker.run(home);
  expect(result.status).toBe('read');
  const next = await db.admin.query(
    `SELECT position,epoch,data->>'securityRevision' AS revision
    FROM core.outbox WHERE partition_no=$1 AND type=$2 AND data->>'external_id'=$3
    ORDER BY position DESC LIMIT 1`,
    [home, continued, source.external_id],
  );
  expect(next.rows).toHaveLength(1);
  revision = next.rows[0].revision;
  // Position the real relay checkpoint just before the durable continuation under measurement.
  await db.admin.query(
    'UPDATE core.consumer_checkpoint SET epoch=$3,position=$4 WHERE consumer=$1 AND partition_no=$2',
    [consumer, home, next.rows[0].epoch, String(BigInt(next.rows[0].position) - 1n)],
  );
  priorEvents = await count(changed);
  priorContinuation = await count(continued);
}

test('facet rebuild relay work per page is independent of tuple fanout and event history', async () => {
  const path = '../../src/semantic/relation-facet-rebuilds.ts';
  expect(
    await Bun.file(new URL(path, import.meta.url)).exists(),
    'SEMANTIC must provide the independent relationFacetRebuilds Relay',
  ).toBe(true);
  const module = (await import(path)) as {
    relationFacetRebuilds(options: { pool: typeof db.pool; routeKey: Uint8Array; pageSize: number }): Relay;
  };
  worker = module.relationFacetRebuilds({ pool: db.pool, routeKey, pageSize });
  expect(worker.consumer).toBe(consumer);
  expect(sourceRoutes.map(partitionOf)).not.toContain(home);
  target = await createAt(sourceRoutes[0]!, 'schema:Person');
  const samples: { scale: number; cost: Cost }[] = [];
  for (const scale of [64, 512, 4096]) {
    if (ids.length) {
      // Fresh imports are needed because Content has no restore operation. Keep tuple home fixed.
      do {
        source.external_id = randomUUID();
        tuple = tupleRoute(routeKey, source.source, source.external_id);
      } while (partitionOf(tuple) !== home);
      ids.length = 0;
    }
    // Production writes seed all touched source/provenance/inverse/version/receipt/outbox relations.
    // No fabricated dependency table or callback stands in for persisted registration work.
    await seed(
      db,
      {
        name: 'facet-rebuild-imports',
        hotPartition: home,
        hotShare: 1,
        write: async (_target, { ordinal }) => {
          const subject = await createAt(sourceRoutes[ordinal % 2]!);
          ids.push(subject);
          const proposal = () => ({
            op: 'propose',
            key: randomUUID(),
            source,
            subject,
            statement: {
              ...snak('schema:author', target),
              qualifiers: [],
              references: [{ parts: [snak('schema:url', 'https://example.test/growth')] }],
            },
          });
          const old = await post('/v1/subjects:batchWrite', { commands: [proposal()] });
          expect(old.results[0].status).toBe(201);
          const retracted = await post('/v1/subjects:batchWrite', {
            commands: [
              {
                op: 'retract',
                key: randomUUID(),
                source,
                subject,
                candidate: old.results[0].value.candidate,
                references: [{ parts: [snak('schema:url', 'https://example.test/retraction')] }],
              },
            ],
          });
          expect(retracted.results[0].status).toBe(200);
          const live = await post('/v1/subjects:batchWrite', { commands: [proposal()] });
          expect(live.results[0].status).toBe(201);
        },
      },
      { from: 0, to: scale },
    );
    await seed(
      db,
      {
        name: 'facet-unrelated-outbox-history',
        hotPartition: home,
        hotShare: 1,
        write: async () => {
          await runCommand(db.pool, { partition: home }, async () => ({
            value: null,
            events: [
              {
                type: 'com.rezics.subject.revised.v1',
                subject: target,
                data: { id: target, revision: 1, kind: 'identity' },
              },
            ],
          }));
        },
      },
      { from: 0, to: scale },
    );
    await seed(
      db,
      {
        name: 'facet-unrelated-redirects',
        hotPartition: partitionOf(sourceRoutes[0]!),
        hotShare: 1,
        rows: ({ ordinal }) => {
          const route = sourceRoutes[ordinal % 2]!;
          const subject = newId(route);
          const transaction = randomUUID();
          return {
            'semantic.subject': [
              {
                route,
                subject_id: subject,
                type: 'schema:Book',
                current_release: releaseDigest(release),
                recorded_transaction_id: transaction,
              },
            ],
            'semantic.redirect': [
              { route, subject_id: subject, sequence: 1, target, recorded_transaction_id: transaction },
            ],
          };
        },
      },
      { from: 0, to: scale },
    );
    await drain();
    await settle(db, { analyze: true });
    const costs = [];
    for (let sample = 0; sample < 4; sample++) {
      await prepare();
      await settle(db, { analyze: true });
      const step = async () => {
        const result = await worker.run(home); // SINGLE continuation; source commands execute inside this call.
        expect(result.status).toBe('read');
        if (result.status === 'read') expect(result.envelopes).toBe(1);
      };
      if (sample === 0) await step(); // At least one unmeasured warmup on fresh consumable work.
      else {
        const measured = await capture(db, step);
        costs.push(costOf(measured.capture)); // Shared examined-row, statement and block classifiers.
      }
      await verify(scale, true); // Final validation and whole-fanout catch-up are outside capture.
    }
    samples.push({ scale, cost: medianCost(costs) });
  }
  assertGrowth(samples, { rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
}, 600_000);
