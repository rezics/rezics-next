import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { statementSlotId } from '../../src/semantic/item.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type GrowthReport, type Population } from '../support/growth.ts';
import { citedValue, listRouteKey, type ListPresentationFixture } from './support/list-presentation-fixture.ts';

const property = 'rezics:releaseSupersedes';

function allPaths(report: GrowthReport) {
  const relations = [
    ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
  ];
  assertGrowthAccessPaths(report.name, report.samples, relations);
  for (const sample of report.samples) {
    for (const backends of sample.backendRepetitions) expect(new Set(backends).size).toBeLessThanOrEqual(1);
    expect(sample.cost.plans).toBeGreaterThan(0);
  }
  console.info(`GROWTH_SAMPLES ${JSON.stringify(report)}`);
}

function history(f: ListPresentationFixture, anchor: string, target: string): Population {
  return {
    name: 'release-supersession-obsolete-revisions',
    hotPartition: partitionOf(routeOf(anchor)!),
    hotShare: 1,
    rows({ route, ordinal }) {
      const subject = newId(route),
        candidate = newId(route),
        transaction = randomUUID(),
        slot = statementSlotId(subject, property),
        source = 'release_growth',
        external_id = `supersession-${ordinal}`;
      return {
        'semantic.subject': [
          {
            route,
            subject_id: subject,
            type: 'wd:Q20631656',
            current_release: bundledDigest,
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.revision': [
          { route, subject_id: subject, revision: 1, kind: 'create', release: bundledDigest, recorded_transaction_id: transaction },
          { route, subject_id: subject, revision: 2, kind: 'propose', release: bundledDigest, recorded_transaction_id: randomUUID() },
        ],
        'semantic.candidate': [
          {
            route,
            subject_id: subject,
            candidate_id: candidate,
            slot_id: slot,
            property,
            rank: 'normal',
            statement: { ...citedValue(property, target), qualifiers: [], rank: 'normal' },
            release: bundledDigest,
            revision: 2,
            origin: 'proposal',
            view_order: 0,
          },
        ],
        'semantic.fact': [
          {
            route,
            subject_id: subject,
            slot_id: slot,
            log_seq: 1,
            kind: 'statement',
            property,
            operation: 'expand',
            body: {},
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.adoption': [
          {
            route,
            subject_id: subject,
            slot_id: slot,
            context_id: GLOBAL_CONTEXT,
            head: 1,
            mode: 'replace',
            selection: [],
            revision: 2,
          },
        ],
        'access.account': [
          { route, account_id: newId(route), kind: 'actor', state: 'active', transaction_id: transaction },
        ],
        'access.resource_grant': [
          {
            route,
            resource_id: subject,
            subject_id: f.accounts.reader,
            action: 'subject:read',
            valid: '(,)',
            transaction_id: transaction,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partitionOf(route),
            transaction_id: transaction,
            epoch: 1,
            position: ordinal + 1,
            principal_kind: 'account',
            principal_id: f.accounts.editor,
            client_id: 'web',
          },
        ],
        'content.source_fences': [
          {
            route: tupleRoute(listRouteKey, source, external_id),
            source,
            external_id,
            field_group: 'facts',
            taken_down: false,
            security_revision: 1,
          },
        ],
      };
    },
  };
}

test(
  'one native 20-row supersession window stays bounded as unrelated releases and obsolete revisions grow',
  async () => {
    const { createListPresentationFixture } = await import('./support/list-presentation-fixture.ts');
    const f = await createListPresentationFixture({ poolMax: 1 });
    try {
      const prior = await f.create('wd:Q20631656', {}, { en: 'Requested superseded release' });
      const current = await f.create('wd:Q20631656', { [property]: prior }, { en: 'Requested current release' });
      const data = history(f, current, prior);
      const report = await checkGrowth(f.db, {
        name: 'Native supersession relation window',
        scales: [64, 512, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
        async grow(db, scale, previousScale) {
          await seed(db, data, { from: previousScale, to: scale });
        },
        async operation() {
          const page = await f.call(
            'GET',
            `/v1/subjects/${current}/relations?property=${encodeURIComponent(property)}&limit=20`,
          );
          expect(page.status, JSON.stringify(page.body)).toBe(200);
          expect((page.body.relations as unknown[])).toHaveLength(1);
          expect(page.body.next).toBeNull();
          expect((page.body.relations as { target: string }[])[0]!.target).toBe(prior);
          return {};
        },
      });
      allPaths(report);
    } finally {
      await f.close();
    }
  },
  1_800_000,
);
