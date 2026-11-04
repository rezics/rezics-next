import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { statementSlotId } from '../../src/semantic/item.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type GrowthReport, type Population } from '../support/growth.ts';
import {
  citedValue,
  createListPresentationFixture,
  listRouteKey,
  type ListPresentationFixture,
} from './support/list-presentation-fixture.ts';

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

function population(f: ListPresentationFixture, anchor: string): Population {
  return {
    name: 'release-source-meaning-unrelated',
    hotPartition: partitionOf(routeOf(anchor)!),
    hotShare: 1,
    rows({ route, ordinal }) {
      const subject = newId(route),
        candidate = newId(route),
        transaction = randomUUID();
      const property = 'schema:keywords',
        slot = statementSlotId(subject, property);
      const source = 'release_growth',
        external_id = `unrelated-${ordinal}`;
      return {
        'semantic.subject': [
          {
            route,
            subject_id: subject,
            type: 'skos:Concept',
            current_release: bundledDigest,
            recorded_transaction_id: transaction,
          },
        ],
        'semantic.revision': [
          {
            route,
            subject_id: subject,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: transaction,
          },
          {
            route,
            subject_id: subject,
            revision: 2,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: randomUUID(),
          },
        ],
        'semantic.candidate': [
          {
            route,
            subject_id: subject,
            candidate_id: candidate,
            slot_id: slot,
            property,
            rank: 'normal',
            statement: { ...citedValue(property, subject), qualifiers: [], rank: 'normal' },
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

test('fixed-page native work stays bounded at 64, 512 and 4096 unrelated source concepts', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const work = await f.create('wd:Q689445', {}, { en: 'Requested visual-novel work' });
    const prior = await f.create('wd:Q20631656', {}, { en: 'Requested prior release' });
    const release = await f.create('wd:Q20631656', { 'wdt:P155': prior }, { en: 'Requested current release' });
    const workLink = await f.propose(release, 'schema:exampleOfWork', work);
    await f.checked('POST', `/v1/subjects/${release}/candidates/${workLink}:accept`, {
      context: GLOBAL_CONTEXT,
      expected_head: null,
    });
    await f.checked('POST', `/v1/subjects/${release}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:exampleOfWork',
      target: work,
      mode: 'replace',
      selection: [{ candidate: workLink, rank: 'normal' }],
      expected_head: null,
    });
    await f.drain();
    const data = population(f, release);
    const report = await checkGrowth(f.db, {
      name: 'Requested release slots among unrelated source concepts',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(db, scale, previous) {
        await seed(db, data, { from: previous, to: scale });
      },
      async operation() {
        const read = await f.call('GET', `/v1/subjects/${release}`);
        expect(read.status, JSON.stringify(read.body)).toBe(200);
        const statements = read.body.subject.statements as Record<string, { value: { content: unknown } }[]>;
        expect(statements['wdt:P155']?.map((row) => row.value.content)).toEqual([prior]);
        expect(statements['schema:exampleOfWork']?.map((row) => row.value.content)).toEqual([work]);
        const page = await f.call('GET', `/v1/subjects/${release}/relations?property=wdt%3AP155&limit=20`);
        expect(page.status, JSON.stringify(page.body)).toBe(200);
        expect((page.body.relations as unknown[]).length).toBe(1);
        expect(page.body.next).toBeNull();
        return {};
      },
    });
    allPaths(report);
  } finally {
    await f.close();
  }
}, 600_000);
