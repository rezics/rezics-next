import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { COPY_WORK_DISCLOSURE_MAX_RAW, readCopyWorkDisclosure } from '../../src/semantic/copy-work-disclosure.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type GrowthReport, type Population } from '../support/growth.ts';
import { createListPresentationFixture } from './support/list-presentation-fixture.ts';

const nil = '00000000-0000-0000-0000-000000000000';

function allPaths(report: GrowthReport) {
  const relations = [
    ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
  ];
  assertGrowthAccessPaths(report.name, report.samples, relations);
  console.info(`GROWTH_SAMPLES ${JSON.stringify(report)}`);
}

test('copy/work disclosure stays bounded at 64/512/4096 unrelated subjects and old relation history', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const work = await f.create('schema:Book', {}, { en: 'Growth work' });
    const edition = await f.create('bf:Instance', {}, { en: 'Growth edition' });
    const candidate = await f.propose(edition, 'schema:exampleOfWork', work);
    await f.adopt(edition, 'schema:exampleOfWork', [candidate]);
    const empty = await f.create('bf:Instance', {}, { en: 'Growth empty' });
    const page = [edition, empty, edition];
    const route = routeOf(edition)!;
    const data: Population = {
      name: 'copy-work-disclosure-unrelated',
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows({ route: placed, ordinal }) {
        const subject = newId(placed);
        const transaction = randomUUID();
        return {
          'semantic.subject': [
            {
              route: placed,
              subject_id: subject,
              type: 'schema:Book',
              current_release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          'semantic.revision': [
            {
              route: placed,
              subject_id: subject,
              revision: 1,
              kind: 'create',
              release: bundledDigest,
              recorded_transaction_id: transaction,
            },
          ],
          'semantic.outbound_link': [
            {
              route,
              subject_id: edition,
              context_id: GLOBAL_CONTEXT,
              property: 'schema:exampleOfWork',
              filter_value: nil,
              order_key: `h${ordinal.toString().padStart(8, '0')}`,
              target_subject_id: subject,
              statement_id: newId(route),
              slot_id: newId(route),
              relation: true,
              source_revision: 1,
              source_security_revision: 0,
              target_type: 'schema:Book',
              value: 'value',
              present: false,
              recorded_transaction_id: transaction,
            },
          ],
        };
      },
    };
    const report = await checkGrowth(f.db, {
      name: 'Copy/work disclosure current window',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(db, scale, previous) {
        await seed(db, data, { from: previous, to: scale });
      },
      async operation() {
        const deps = { ...(await f.deps()), deadline: Date.now() + 180_000 };
        const observed = await readCopyWorkDisclosure(deps, { identities: page, languages: ['en'] });
        expect(observed.results.get(edition)).toEqual({
          state: 'available',
          works: [{ id: work, labels: { en: 'Growth work' } }],
        });
        expect(observed.results.get(empty)).toEqual({ state: 'available', works: [] });
        await expect(
          readCopyWorkDisclosure(deps, { identities: Array(COPY_WORK_DISCLOSURE_MAX_RAW + 1).fill(edition) }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
        return { bytes: Buffer.byteLength(JSON.stringify([...observed.results]), 'utf8') };
      },
    });
    allPaths(report);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBe(report.samples[0]!.cost.rows);
      expect(sample.cost.responseBytes).toBe(report.samples[0]!.cost.responseBytes);
    }
  } finally {
    await f.close();
  }
}, 1_800_000);
