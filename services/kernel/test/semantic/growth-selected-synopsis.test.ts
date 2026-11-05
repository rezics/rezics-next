import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { slotId } from '../../src/semantic/slots.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import {
  attributionFixture,
  cited,
  registeredBangumi,
  routeKey,
  source,
  status,
  type AttributionFixture,
} from './support/source-record-attribution.ts';

let db: GrowthDatabase;
let f: AttributionFixture;
let selected: { subject: string; path: string; projection: unknown; records: unknown[] };

beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await attributionFixture(db, db.openPool({ max: 1, connectionTimeoutMillis: 10_000 }));
  const book = await f.create();
  const candidates: string[] = [];
  const records = [await f.filled(book.origin)];
  for (let index = 0; index < 2; index++) {
    const origin = { ...source(), field_group: 'summary' as const };
    const statement = cited('schema:abstract', { language: 'en', document: fromPlainText(`Fixed synopsis ${index}`) });
    if (index === 1) statement.references = [];
    const candidate = await f.propose(book.id, origin, statement, {
      license: 'CC0-1.0',
      obligations: [],
      attribution: 'Summary author',
    });
    candidates.push(candidate);
    status(
      await f.call('POST', `/v1/subjects/${book.id}/candidates/${candidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      }),
      200,
    );
    records.push(await f.filled(origin));
  }
  status(
    await f.call('POST', `/v1/subjects/${book.id}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:abstract',
      mode: 'replace',
      expected_head: null,
      selection: candidates.map((candidate) => ({ candidate, rank: 'preferred' })),
    }),
    200,
  );
  const subject = await f.read(book.id);
  const second = subject.statements['schema:abstract'][1];
  expect(second.id).toBe(candidates[1]);
  const input = { statement: second.id, ...second.value.content, context: GLOBAL_CONTEXT, release: subject.release };
  const path = `/v1/subjects/${book.id}?${new URLSearchParams({ selectedSynopsis: JSON.stringify(input) })}`;
  const positive = status(await f.call('GET', path, undefined, null), 200);
  expect(positive.selectedSynopsis.kind).toBe('matched');
  expect(positive.selectedSynopsis.fact.references).toEqual([]);
  expect(positive.subject.sourceRecords).toEqual(expect.arrayContaining(records));
  expect(positive.subject.sourceRecords).toHaveLength(records.length);
  selected = { subject: book.id, path, projection: positive.selectedSynopsis, records: positive.subject.sourceRecords };
}, 120_000);
afterAll(async () => {
  await db?.close();
});

type Axis = 'unrelated' | 'history' | 'source-records';
function population(axis: Axis, base: number): Population {
  const route = routeOf(selected.subject)!;
  return {
    name: `selected-synopsis-${axis}`,
    hotPartition: partitionOf(route),
    hotShare: 0.5,
    rows({ ordinal }) {
      const transaction = randomUUID();
      const origin = source(`${axis}-${ordinal}-${transaction}`);
      const home = tupleRoute(routeKey, origin.source, origin.external_id);
      if (axis === 'source-records')
        return {
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
        };
      const subject = axis === 'history' ? selected.subject : newId(home);
      const owner = axis === 'history' ? route : home;
      const candidate = newId(owner);
      const revision = axis === 'history' ? base + ordinal * 2 + 1 : 2;
      const labels = itemFacts(subject, { labels: { en: `Unrelated ${ordinal}` } }, 'schema:Book');
      return {
        ...(axis === 'unrelated'
          ? {
              'semantic.subject': [
                {
                  route: owner,
                  subject_id: subject,
                  type: 'schema:Book',
                  recorded_transaction_id: transaction,
                  current_facts: labels.length,
                  current_release: bundledDigest,
                },
              ],
              'semantic.fact': labels.map((fact) => ({
                ...fact,
                route: owner,
                subject_id: subject,
                recorded_transaction_id: transaction,
                release: null,
                relation: false,
              })),
              'semantic.redirect': [
                {
                  route: owner,
                  subject_id: subject,
                  sequence: 1,
                  target: selected.subject,
                  recorded_transaction_id: transaction,
                },
              ],
              'content.imported_field': [
                {
                  route: owner,
                  id: newId(owner),
                  subject,
                  candidate,
                  revision: 1,
                  body: null,
                  body_sha256: Buffer.alloc(32, ordinal % 256),
                  source: { ...origin, field_group: 'summary', references: [] },
                  rights: { license: 'CC0-1.0', obligations: [], attribution: 'Unrelated author' },
                  language: 'en',
                  availability: 'erased',
                },
              ],
            }
          : {}),
        'semantic.revision': [
          ...(axis === 'unrelated'
            ? [
                {
                  route: owner,
                  subject_id: subject,
                  revision: 1,
                  kind: 'create',
                  release: bundledDigest,
                  recorded_transaction_id: transaction,
                  source: origin,
                },
              ]
            : []),
          {
            route: owner,
            subject_id: subject,
            revision,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: transaction,
            source: origin,
          },
          {
            route: owner,
            subject_id: subject,
            revision: revision + 1,
            kind: 'retract',
            release: bundledDigest,
            recorded_transaction_id: randomUUID(),
            source: origin,
          },
        ],
        'semantic.candidate': [
          {
            route: owner,
            subject_id: subject,
            candidate_id: candidate,
            slot_id: slotId(subject, 'schema:inLanguage'),
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
          { route: owner, subject_id: subject, candidate_id: candidate, revision: revision + 1, references: [] },
        ],
      };
    },
  };
}

for (const axis of ['unrelated', 'history', 'source-records'] as const) {
  test(`exact synopsis native work stays keyed as ${axis} grows independently`, async () => {
    const base = (
      await db.admin.query(
        'SELECT max(revision)::int AS revision FROM semantic.revision WHERE route=$1 AND subject_id=$2',
        [routeOf(selected.subject), selected.subject],
      )
    ).rows[0].revision;
    const report = await checkGrowth(db, {
      name: `selected-synopsis-${axis}`,
      scales: [64, 512, 4096],
      rule: 'series',
      repetitions: 5,
      warmups: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      grow: async (_, scale, previous) => {
        await seed({ pool: db.pool, admin: db.admin }, population(axis, base), { from: previous, to: scale });
      },
      operation: async () => {
        const body = status(await f.call('GET', selected.path, undefined, null), 200);
        expect(body.selectedSynopsis).toEqual(selected.projection);
        expect(body.subject.sourceRecords).toEqual(selected.records);
        return body;
      },
    });
    const relations = [
      ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
    ];
    assertGrowthAccessPaths(`selected-synopsis-${axis}`, report.samples, relations);
    for (const sample of report.samples)
      for (const repetition of sample.occurrenceRepetitions) {
        expect(repetition.statements.every((row) => row.backend !== undefined)).toBe(true);
        expect(new Set(repetition.statements.map((row) => row.backend)).size).toBeLessThanOrEqual(1);
        for (const home of ['access.', 'content.', 'semantic.'])
          expect(repetition.statements.some((row) => row.statement.includes(home))).toBe(true);
      }
    console.info(`GROWTH_SAMPLES ${JSON.stringify({ check: `selected-synopsis-${axis}`, samples: report.samples })}`);
  }, 120_000);
}
