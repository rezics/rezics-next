import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { classifyUnavailability } from '../../src/request/unavailable.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { statementSlotId } from '../../src/semantic/item.ts';
import { readListPresentationFacts } from '../../src/semantic/list-presentation.ts';
import { assertGrowthAccessPaths, checkGrowth, seed, type GrowthReport, type Population } from '../support/growth.ts';
import {
  citedValue,
  createListPresentationFixture,
  listRouteKey,
  type ListPresentationFixture,
} from './support/list-presentation-fixture.ts';

function allPaths(report: GrowthReport) {
  // Every observed native relation participates, including negative/reread/Access/failed work.
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
    name: 'list-facts-native-neighborhood',
    hotPartition: partitionOf(routeOf(anchor)!),
    hotShare: 1,
    rows({ route, ordinal }) {
      const subject = newId(route),
        candidate = newId(route),
        transaction = randomUUID();
      const property = 'schema:wordCount',
        slot = statementSlotId(subject, property);
      const source = 'list_growth',
        external_id = `unrelated-${ordinal}`;
      return {
        'semantic.subject': [
          {
            route,
            subject_id: subject,
            type: 'schema:Book',
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
            statement: { ...citedValue(property, { amount: '+1', unit: '1' }), qualifiers: [], rank: 'normal' },
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

test('native list page includes positive, denied, tuple, related, sparse, race and failed work as unrelated populations grow 64/512/4096', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const publicId = await f.create('schema:Book', { 'schema:wordCount': { amount: '+12345', unit: '1' } });
    const author = await f.create('schema:Person', {}, { en: 'Withheld related author' });
    const related = await f.create('schema:Book', { 'schema:author': author });
    await f.hide(author);
    const hidden = await f.create('schema:Book', { 'schema:wordCount': { amount: '+17', unit: '1' } });
    await f.hide(hidden);
    const sparse = await f.create('schema:Book');
    const imported = await f.imported('schema:wordCount', { amount: '+99', unit: '1' });
    await f.checked('POST', '/v1/sourceFences:takedown', {
      source: imported.source.source,
      externalId: imported.source.external_id,
      fieldGroup: 'facts',
      reason: 'Native growth tuple fence',
    });
    const race = await f.create('schema:Book');
    const unknown = newId(routeOf(publicId)!);
    const page = [publicId, related, hidden, sparse, imported.id, unknown, publicId];
    const data = population(f, publicId);
    const report = await checkGrowth(f.db, {
      name: 'Current original-keyed list facts and all native guards',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(db, scale, previous) {
        await seed(db, data, { from: previous, to: scale });
      },
      async operation() {
        const deps = await f.deps();
        const result = await readListPresentationFacts(deps, page, { languages: ['en'] });
        expect(result.get(publicId)).toEqual({
          id: publicId,
          facts: { 'schema:wordCount': [{ kind: 'quantity', amount: 12345, unit: '1' }] },
        });
        for (const id of [related, sparse, imported.id]) expect(result.get(id)).toEqual({ id, facts: {} });
        expect(result.get(hidden)).toBeNull();
        expect(result.get(unknown)).toBeNull();

        // Mutate through the real API between original and terminal preparations, after releasing the source.
        let preparations = 0;
        const access = deriveAccess(deps.access, {
          async prepare(actor, action, resource, context) {
            if (resource.id === race && ++preparations === 2) await f.hide(race);
            return deps.access.prepare!(actor, action, resource, context);
          },
        });
        await expect(readListPresentationFacts({ ...deps, access }, [race])).rejects.toMatchObject({
          code: 'semantic_not_ready',
        });
        await f.checked('POST', `/v1/subjects/${race}:restore`, { reason: 'Next native race repetition' });
        await f.drain();
        // This whole failed attempt and the native restore/relay are in the inclusive shared capture.
        await expect(readListPresentationFacts(deps, Array(101).fill(publicId))).rejects.toBeInstanceOf(RangeError);
        let failure: unknown;
        try {
          await readListPresentationFacts({ ...deps, deadline: Date.now() - 1 }, [publicId]);
        } catch (error) {
          failure = error;
        }
        expect(classifyUnavailability(failure)).toBe('deadline');
        expect((await readListPresentationFacts(await f.deps(), [publicId])).get(publicId)?.id).toBe(publicId);
        expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
        return {};
      },
    });
    allPaths(report);
  } finally {
    await f.close();
  }
}, 600_000);

test('native distinct requested widths 1/8/100 grow only examined own-neighborhood work', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const ids: string[] = [];
    const report = await checkGrowth(f.db, {
      name: 'Native list fact requested width',
      scales: [1, 8, 100],
      bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
      byteBounds: { requestBytes: 'linear', responseBytes: 'linear' },
      includeBackends: true,
      counted: {
        read: (value) => value as { subjects: number },
        limits: { connections: 1 },
        bounds: { subjects: 'linear', connections: 'constant' },
      },
      async grow(_db, scale) {
        while (ids.length < scale) {
          const ordinal = ids.length;
          ids.push(
            ordinal % 3 === 0
              ? await f.create('schema:Book', { 'schema:wordCount': { amount: '+1000001', unit: '1' } })
              : ordinal % 3 === 1
                ? await f.create('schema:Movie', {
                    'schema:duration': { amount: '+5400', unit: 'http://www.wikidata.org/entity/Q11574' },
                  })
                : await f.create('schema:Recipe', {
                    'schema:cookTime': { amount: '+25', unit: 'http://www.wikidata.org/entity/Q7727' },
                  }),
          );
        }
      },
      async operation(_db, scale) {
        const values = await readListPresentationFacts(await f.deps(), ids.slice(0, scale));
        expect(values.size).toBe(scale);
        for (const id of ids.slice(0, scale)) {
          expect(values.get(id)?.id).toBe(id);
          expect(Object.values(values.get(id)!.facts).flat()).toHaveLength(1);
        }
        return { subjects: values.size };
      },
    });
    allPaths(report);
  } finally {
    await f.close();
  }
}, 600_000);
