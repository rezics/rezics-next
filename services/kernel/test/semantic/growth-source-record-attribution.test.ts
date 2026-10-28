import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { slotId } from '../../src/semantic/slots.ts';
import {
  assertGrowth,
  capture,
  costOf,
  growthByteViolations,
  medianCost,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type Cost,
  type Capture,
} from '../support/growth.ts';
import {
  attributionFixture,
  cited,
  metadataPath,
  records,
  registeredBangumi,
  routeKey,
  source,
  status,
  type AttributionFixture,
} from './support/source-record-attribution.ts';

let db: GrowthDatabase;
let f: AttributionFixture;
const scales = [64, 512, 4096] as const;
beforeAll(async () => {
  db = await openGrowthDatabase();
  // All original pools remain instrumented by the native harness, including this max-1 pool.
  f = await attributionFixture(db, db.openPool({ max: 1, connectionTimeoutMillis: 10_000 }));
});
afterAll(async () => {
  await db?.close();
});

async function series(
  name: string,
  data: Population,
  operation: () => Promise<unknown>,
  inspect: (cost: Cost, raw: Capture) => void,
) {
  const samples: { scale: number; cost: Cost }[] = [];
  let previous = 0;
  for (const scale of scales) {
    await seed({ pool: db.pool, admin: db.admin }, data, { from: previous, to: scale });
    await db.admin.query('VACUUM (ANALYZE)');
    await operation();
    const costs: Cost[] = [];
    for (let run = 0; run < 5; run++) {
      const measured = await capture(db, operation, { includeBackends: true });
      const cost = costOf(measured.capture);
      inspect(cost, measured.capture);
      for (const [relation, relationCost] of Object.entries(cost.relations)) {
        if (/^(semantic|content)\./.test(relation))
          expect(relationCost.sequentialScans, `${name}: ${relation}`).toBe(0);
      }
      expect(measured.capture.statementBackends?.every((pid) => pid !== undefined)).toBe(true);
      expect(new Set(measured.capture.statementBackends).size).toBeLessThanOrEqual(1);
      costs.push(cost);
    }
    samples.push({ scale, cost: medianCost(costs) });
    previous = scale;
  }
  assertGrowth(samples, { rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
  expect(growthByteViolations(samples, { requestBytes: 'constant', responseBytes: 'constant' })).toEqual([]);
  console.info(`GROWTH_SAMPLES ${JSON.stringify({ check: name, samples })}`);
}
function population(name: string, subject: string, base: number, axis: 'unrelated' | 'candidates'): Population {
  const subjectRoute = routeOf(subject)!;
  return {
    name,
    hotPartition: partitionOf(subjectRoute),
    hotShare: 0.5,
    rows({ ordinal }) {
      const origin = source(`${name}-${ordinal}`);
      const home = tupleRoute(routeKey, origin.source, origin.external_id);
      const id = axis === 'candidates' ? subject : newId(home);
      const ownerRoute = axis === 'candidates' ? subjectRoute : home;
      const candidate = newId(ownerRoute);
      const revision = axis === 'candidates' ? base + ordinal * 2 + 1 : 2;
      const transaction = randomUUID();
      const labels = itemFacts(id, { labels: { en: `Unrelated record ${ordinal}` } }, 'schema:Book', undefined);
      // Native-shaped unrelated rows, original provenance, immutable history and retractions.
      return {
        'core.receipt': [
          {
            partition_no: partitionOf(home),
            principal_kind: 'account',
            principal_id: f.accounts.importer,
            command_kind: 'source_record.set_metadata',
            idempotency_key: `${name}-${ordinal}`,
            request_digest: Buffer.alloc(32, ordinal % 256),
            epoch: 1,
            position: 1,
            transaction_id: transaction,
            response: { record: registeredBangumi(origin.external_id), metadata_revision: 1, effect: 'filled' },
          },
        ],
        'semantic.source_record': [
          {
            route: home,
            source: origin.source,
            external_id: origin.external_id,
            metadata_revision: 1,
            record: registeredBangumi(origin.external_id),
            recorded_transaction_id: transaction,
          },
        ],
        ...(axis === 'unrelated'
          ? {
              'semantic.subject': [
                {
                  route: ownerRoute,
                  subject_id: id,
                  type: 'schema:Book',
                  recorded_transaction_id: transaction,
                  current_facts: labels.length,
                  current_release: bundledDigest,
                },
              ],
              'semantic.fact': labels.map((fact) => ({
                ...fact,
                route: ownerRoute,
                subject_id: id,
                recorded_transaction_id: transaction,
                release: null,
                relation: false,
              })),
              'semantic.external_claim': [
                {
                  route: home,
                  source: origin.source,
                  external_id: origin.external_id,
                  subject_id: id,
                  recorded_transaction_id: transaction,
                },
              ],
            }
          : {}),
        'semantic.revision': [
          ...(axis === 'unrelated'
            ? [
                {
                  route: ownerRoute,
                  subject_id: id,
                  revision: 1,
                  kind: 'create',
                  release: bundledDigest,
                  recorded_transaction_id: transaction,
                  source: origin,
                },
              ]
            : []),
          {
            route: ownerRoute,
            subject_id: id,
            revision,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: transaction,
            source: origin,
          },
          {
            route: ownerRoute,
            subject_id: id,
            revision: revision + 1,
            kind: 'retract',
            release: bundledDigest,
            recorded_transaction_id: randomUUID(),
            source: origin,
          },
        ],
        'semantic.candidate': [
          {
            route: ownerRoute,
            subject_id: id,
            candidate_id: candidate,
            slot_id: slotId(id, 'schema:inLanguage'),
            property: 'schema:inLanguage',
            rank: 'normal',
            statement: { ...cited('schema:inLanguage', 'fr'), qualifiers: [] },
            release: bundledDigest,
            revision,
            origin: 'proposal',
            view_order: 0,
            relation: false,
          },
        ],
        'semantic.retraction': [
          {
            route: ownerRoute,
            subject_id: id,
            candidate_id: candidate,
            revision: revision + 1,
            references: cited().references,
          },
        ],
      };
    },
  };
}

async function displayed() {
  const book = await f.create();
  const origins = [source(), source()];
  const expected = [];
  const candidates = [];
  for (const [i, origin] of origins.entries()) {
    candidates.push(await f.propose(book.id, origin, cited('schema:inLanguage', i === 0 ? 'ja' : 'en')));
    status(
      await f.call('POST', `/v1/subjects/${book.id}/candidates/${candidates[i]}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      }),
      200,
    );
    expected.push(await f.filled(origin));
  }
  await f.adopt(book.id, candidates);
  const read = await f.read(book.id);
  expect(records(read)).toEqual(expected);
  const revision = (
    await db.admin.query(
      'SELECT max(revision)::int AS revision FROM semantic.revision WHERE route=$1 AND subject_id=$2',
      [routeOf(book.id), book.id],
    )
  ).rows[0].revision as number;
  return { book, origins, candidates, expected, revision };
}

test('native record reads and metadata writes stay bounded through replay hidden private foreign fences and growth', async () => {
  // Genuine positive reads/writes precede every revocation; no missing port is a growth pass.
  const shown = await displayed();
  const foreign = status(
    await f.call('POST', '/v1/subjects', { type: 'schema:Person', labels: { en: 'Foreign author' } }),
    201,
  ).subject;
  const foreignBook = await f.create();
  const foreignOrigin = source();
  const foreignCandidate = await f.propose(foreignBook.id, foreignOrigin, cited('schema:author', foreign.id));
  await f.select(foreignBook.id, foreignCandidate, 'schema:author', foreign.id);
  const foreignRecord = await f.filled(foreignOrigin);
  await f.drain(foreignBook.id, foreign.id);
  expect(records(await f.read(foreignBook.id))).toEqual([foreignRecord]);
  const agent = await ensureAccountAgent(f.pool, { account: f.accounts.person, kind: 'person', name: 'Consent owner' });
  const privateOrigin = source();
  const privateBook = await f.historical(privateOrigin, { target: agent.subject.id, account: f.accounts.person });
  const privateRecord = await f.filled(privateOrigin);
  const hidden = await displayed();
  await f.drain(shown.book.id, hidden.book.id, privateBook.id, agent.subject.id);
  status(
    await f.call('POST', `/v1/subjects/${hidden.book.id}/candidates/${hidden.candidates[0]}:hide`, {
      reason: 'Paused hidden support',
    }),
    200,
  );
  status(
    await f.call('POST', '/v1/sourceFences:takedown', {
      source: hidden.origins[1]!.source,
      externalId: hidden.origins[1]!.external_id,
      fieldGroup: 'facts',
      reason: 'Paused fenced support',
    }),
    200,
  );
  status(await f.call('POST', `/v1/subjects/${foreign.id}:hide`, { reason: 'Paused foreign target' }), 200);
  const paths = [
    { name: 'public', id: shown.book.id, as: null, expected: shown.expected },
    { name: 'hidden-fenced', id: hidden.book.id, as: null, expected: [] },
    { name: 'foreign-withheld', id: foreignBook.id, as: null, expected: [] },
    { name: 'private-audience', id: privateBook.id, as: 'person' as const, expected: [privateRecord] },
    { name: 'private-public', id: privateBook.id, as: null, expected: [] },
  ];
  for (const axis of ['unrelated', 'candidates'] as const) {
    for (const path of paths) {
      const name = `source-attribution-${axis}-${path.name}-${randomUUID()}`;
      // Each same-subject series gets nonoverlapping immutable history revisions.
      const base = (
        await db.admin.query(
          'SELECT max(revision)::int AS revision FROM semantic.revision WHERE route=$1 AND subject_id=$2',
          [routeOf(path.id), path.id],
        )
      ).rows[0].revision as number;
      await series(
        name,
        population(name, path.id, base, axis),
        async () => {
          const subject = await f.read(path.id, path.as);
          expect(records(subject)).toEqual(path.expected);
          return subject;
        },
        (cost, raw) => {
          const hydrated = cost.relations['semantic.source_record']?.rows ?? 0;
          expect(hydrated).toBeLessThanOrEqual(path.expected.length);
          if (path.expected.length) expect(hydrated).toBeGreaterThan(0);
          // Captures include tuple fences, original/terminal and foreign proof work, not just metadata SQL.
          expect(raw.statements.some((sql) => /access\./.test(sql))).toBe(true);
        },
      );
    }
  }
  // Ordinary projections have remained paused throughout all revocation captures.
  status(
    await f.call('POST', '/v1/sourceFences:takedown', {
      source: shown.origins[0]!.source,
      externalId: shown.origins[0]!.external_id,
      fieldGroup: 'facts',
      reason: 'Partial fence',
    }),
    200,
  );
  expect(records(await f.read(shown.book.id))).toEqual([shown.expected[1]!]);
}, 120_000);

test('metadata fill replay duplicate correction and denial are exact tuple work as unrelated native history grows', async () => {
  const shown = await displayed();
  const origin = shown.origins[0]!;
  const record = shown.expected[0]!;
  const replayKey = randomUUID();
  const replay = await f.metadata(origin, record, null, replayKey);
  status(replay, 200);
  for (const mode of ['fill', 'replay', 'duplicate', 'correction', 'denied'] as const) {
    let revision = 1;
    const name = `source-metadata-${mode}-${randomUUID()}`;
    await series(
      name,
      population(name, shown.book.id, shown.revision, 'unrelated'),
      async () => {
        if (mode === 'replay') {
          expect(await f.metadata(origin, record, null, replayKey)).toEqual(replay);
        } else if (mode === 'denied') {
          status(
            await f.call(
              'POST',
              metadataPath,
              {
                source: origin.source,
                external_id: origin.external_id,
                metadata: record,
                expected_metadata_revision: null,
              },
              'ordinary',
            ),
            403,
          );
        } else if (mode === 'correction') {
          const result = status(
            await f.metadata(
              origin,
              { ...record, attribution: `Correction ${String(revision).padStart(6, '0')}` },
              revision,
            ),
            200,
          );
          expect(result.metadata_revision).toBe(++revision);
        } else if (mode === 'duplicate') {
          const result = status(await f.metadata(origin, { name: record.name, url: record.url }), 200);
          expect(result.effect).toBe('noEffect');
        } else {
          status(await f.metadata(source(), record), 201);
        }
      },
      (cost) => {
        expect(cost.relations['semantic.source_record']?.rows ?? 0).toBeLessThanOrEqual(mode === 'denied' ? 0 : 2);
      },
    );
  }
}, 120_000);
