import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { releaseDigest, valueSchema, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import {
  MAX_RELATION_FACET_VALUES,
  type IndexedSubject,
  type RelationFacetProbe as SharedRelationFacetProbe,
} from '../../src/search/source.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { LINKS_CHANGED, SUBJECT_REVISED } from '../../src/semantic/events.ts';
import { factDataTypes, itemFacts } from '../../src/semantic/item.ts';
import { linkChanges } from '../../src/semantic/link-changes.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import * as semanticSource from '../../src/semantic/search-source.ts';
import { writeFacts } from '../../src/semantic/write-facts.ts';
import {
  capture,
  costOf,
  withoutCatalogStatements,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const route = 32160,
  partition = partitionOf(route);
let db: GrowthDatabase;
const release: Release = structuredClone(bundledRelease);
release.catalogue = { id: 'https://example.test/relation-facet-growth', version: '1' };
release.prefixes.ex = 'https://example.test/';
release.filters = {};
const itemProperty = (id: string) => ({
  iri: `https://example.test/${id.slice(3)}`,
  labels: { en: id },
  mappings: [],
  datatype: 'wikibase-item' as const,
  value: valueSchema('wikibase-item'),
  multivalued: true,
  qualifiers: [],
  targets: ['schema:Person'],
});
for (const id of ['ex:key']) release.properties[id] = itemProperty(id);
release.properties['ex:credit'] = {
  ...itemProperty('ex:credit'),
  qualifiers: ['ex:key'],
  relation: { group: 'credit', inverse: 'none', order: 'name', slotKey: 'ex:key' },
};
release.types['schema:Book']!.properties = ['ex:credit', 'schema:author', 'schema:inLanguage'];
release.types['schema:Book']!.facets = ['schema:author', 'ex:credit', 'schema:inLanguage'];
const digest = releaseDigest(release);
const people = Array.from({ length: 4226 }, () => newId(route));
const target = people[0]!;
const missing = newId(route);
const snak = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });
type RelationFacetProbe = Pick<SharedRelationFacetProbe, 'subject' | 'property' | 'value'>;
type Probe = RelationFacetProbe;
type Port = {
  matchRelationFacets?: (partition: number, probes: readonly Probe[]) => Promise<(boolean | 'not_proven')[]>;
};

type RebuildRunner = { run(partition: number): Promise<{ status: 'read' | 'busy'; examined: number; done: boolean }> };
const rebuildConsumer = `facet_growth_${randomUUID().replaceAll('-', '')}`;
function runner(consumer = rebuildConsumer): RebuildRunner {
  const factory = (
    semanticSource as unknown as {
      relationFacetRebuilds?: (options: {
        pool: GrowthDatabase['pool'];
        routeKey: Uint8Array;
        consumer: string;
        pageSize: number;
      }) => RebuildRunner;
    }
  ).relationFacetRebuilds;
  expect(typeof factory, 'missing production relationFacetRebuilds bounded durable runner').toBe('function');
  return factory!({ pool: db.pool, routeKey: new Uint8Array(32).fill(81), consumer, pageSize: 16 });
}
async function catchUp(rebuild: RebuildRunner) {
  for (let page = 0; page < 100000; page++) {
    const result = await rebuild.run(partition);
    expect(result.status).toBe('read');
    expect(result.examined).toBeLessThanOrEqual(16);
    if (result.done) return;
  }
  throw new Error('Quiescent rebuild must finish without restart/starvation');
}

function subjects(ids: string[], type: string): Population {
  return {
    name: `relation-facet-${type}`,
    hotPartition: partition,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const id = ids[ordinal]!,
        transaction = randomUUID();
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type,
            recorded_transaction_id: transaction,
            current_facts: 1,
            current_release: digest,
          },
        ],
        'semantic.revision': [
          { route, subject_id: id, revision: 1, kind: 'create', release: digest, recorded_transaction_id: transaction },
        ],
        'semantic.fact': itemFacts(id, { labels: { en: `Fixture ${ordinal}` } }).map((fact) => ({
          ...fact,
          route,
          subject_id: id,
          recorded_transaction_id: transaction,
          release: null,
        })),
      };
    },
  };
}
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, release);
  await seed(db, subjects(people, 'schema:Person'), { from: 0, to: people.length });
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

// Like growth-relations, seed authoritative compact facts.
// writeFacts and real link-change envelopes exercise derived-state maintenance; no fake source or prefilled answer.
async function grow(subject: string, from: number, to: number) {
  for (let offset = from; offset < to; offset += 32) {
    const end = Math.min(to, offset + 32);
    const authors = people
      .slice(offset, end)
      .map((id) => ({ ...snak('schema:author', id), qualifiers: [], references: [] }));
    const slots = people.slice(offset, end).map((key) => ({
      ...snak('ex:credit', target),
      qualifiers: [snak('ex:key', key)],
      references: [],
    }));
    const facts = itemFacts(
      subject,
      { labels: { en: 'Growth anchor' }, statements: { 'schema:author': authors, 'ex:credit': slots } },
      'schema:Book',
      release,
    ).filter((fact) => fact.kind === 'statement');
    const revision = end + 1;
    await runCommand(db.pool, { partition }, async (tx, { transactionId }) => {
      await tx.query(
        `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
        VALUES ($1,$2,$3,'adopt',$4,$5)`,
        [route, subject, revision, digest, transactionId],
      );
      await writeFacts(tx, {
        route,
        subject_id: subject,
        transaction_id: transactionId,
        facts: facts.map((fact) => ({ ...fact, release: digest, relation: true })),
      });
      // Retracted history grows for both the absent author and the same-target slotKey pair.
      // Reads must never fold relation history to find current members.
      const history = itemFacts(
        subject,
        {
          labels: { en: 'History' },
          statements: {
            'schema:author': [{ ...snak('schema:author', missing), qualifiers: [], references: [] }],
            'ex:credit': [
              { ...snak('ex:credit', target), qualifiers: [snak('ex:key', people[4225]!)], references: [] },
            ],
          },
        },
        'schema:Book',
        release,
      ).filter((fact) => fact.kind === 'statement');
      await writeFacts(tx, {
        route,
        subject_id: subject,
        transaction_id: transactionId,
        facts: Array.from({ length: end - offset }, (_, index) =>
          history.flatMap((fact) => [
            { ...fact, relation: true, log_seq: (offset + index) * 2 + 1, release: digest },
            {
              ...fact,
              relation: true,
              operation: 'retract' as const,
              log_seq: (offset + index) * 2 + 2,
              release: digest,
            },
          ]),
        ).flat(),
      });
      const changes = linkChanges([], facts, factDataTypes(release, facts), {
        subject,
        release,
        type: 'schema:Book',
        identityFacts: [],
      });
      return {
        value: null,
        events: [
          { type: SUBJECT_REVISED, subject, data: { id: subject, revision, kind: 'adopt' } },
          { type: LINKS_CHANGED, subject, data: { subject, revision, security_revision: 0, changes } },
        ],
      };
    });
  }
}

test('relation facet source and point probes stay bounded as relation degree grows', async () => {
  const source = subjectSource(db.pool);
  const port = source as Port;
  expect(typeof port.matchRelationFacets, 'semantic source must provide matchRelationFacets').toBe('function');
  const match = port.matchRelationFacets!.bind(port);
  const projection = linkProjection(db.pool);
  const rebuild = runner();
  const operations = ['snapshot', 'present outside sample', 'absent', 'same-target slotKey membership'] as const;
  // Independent reports prevent one cheap operation from masking a scan in a different operation.
  for (const operation of operations) {
    const subject = newId(route);
    await seed(db, subjects([subject], 'schema:Book'), { from: 0, to: 1 });
    // Saturate the fixed sample before the smallest measured scale; a 64-to-128 fill is not degree growth.
    await grow(subject, 0, MAX_RELATION_FACET_VALUES);
    let present = '';
    const report = await checkGrowth(db, {
      name: `relation facet ${operation}`,
      scales: [64, 512, 4096],
      warmups: 1,
      repetitions: 3,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_database, scale, previous) => {
        await grow(subject, previous + MAX_RELATION_FACET_VALUES, scale + MAX_RELATION_FACET_VALUES);
        // Derived-state work belongs to seeding, and is recorded by checkGrowth's grow attribution.
        // Any source-triggered catch-up inside operation is also captured; never subtract runner SQL.
        for (;;) {
          const result = await projection.run(partition);
          if (result.status === 'busy') throw new Error('Owned growth partition unexpectedly busy');
          if (result.envelopes === 0) break;
        }
        await catchUp(rebuild);
        const snapshot = (await source.read(partition, [subject])).subjects[0] as IndexedSubject & {
          relationFacetOverflow?: string[];
        };
        const sample = snapshot.statements.filter((row) => row.property === 'schema:author');
        expect(sample).toHaveLength(MAX_RELATION_FACET_VALUES);
        expect(snapshot.relationFacetOverflow?.slice().sort()).toEqual(['schema:author']);
        expect(snapshot.statements.filter((row) => row.property === 'ex:credit').map(({ value }) => value)).toEqual([
          target,
        ]);
        const sampled = new Set(sample.map((row) => row.value));
        present = people.slice(0, scale + MAX_RELATION_FACET_VALUES).find((id) => !sampled.has(id))!;
        expect(present).toBeDefined();
      },
      operation: async () => {
        if (operation === 'snapshot') {
          const snapshot = (await source.read(partition, [subject])).subjects[0]!;
          expect(snapshot.statements.filter((row) => row.property === 'schema:author').length).toBeLessThanOrEqual(
            MAX_RELATION_FACET_VALUES,
          );
          return snapshot;
        }
        const probe: Probe = { subject, property: 'schema:author', value: operation === 'absent' ? missing : present };
        if (operation === 'same-target slotKey membership') {
          probe.property = 'ex:credit';
          probe.value = target;
        }
        const result = await match(partition, [probe]);
        expect(result).toEqual([operation === 'absent' ? 'not_proven' : true]);
        return result;
      },
    });
    expect(report.samples).toHaveLength(3);
  }
}, 300_000);

test('relation facet witness rebuild stays bounded per durable page as degree and history grow', async () => {
  const rebuild = runner();
  const subject = newId(route);
  await seed(db, subjects([subject], 'schema:Book'), { from: 0, to: 1 });
  const report = await checkGrowth(db, {
    name: 'relation facet witness rebuild page',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async (_database, scale, previous) => {
      await grow(subject, previous, scale);
    },
    operation: async () => {
      // Exactly one production step, including relay/catalogue/background SQL, is measured.
      const result = await rebuild.run(partition);
      expect(result.status).toBe('read');
      expect(result.examined).toBeGreaterThan(0);
      expect(result.examined).toBeLessThanOrEqual(16);
      return result;
    },
  });
  expect(report.samples).toHaveLength(3);
  // Total remaining work may grow. Capture every remaining page individually; never subtract background work.
  for (let page = 0; ; page++) {
    expect(page).toBeLessThan(100000);
    const measured = await capture(db, () => rebuild.run(partition));
    expect(measured.value.status).toBe('read');
    expect(measured.value.examined).toBeLessThanOrEqual(16);
    const cost = costOf(withoutCatalogStatements('witness catch-up page', measured.capture));
    expect(cost.relations.relation_facet_statement?.rows ?? 0).toBeLessThanOrEqual(17);
    if (measured.value.done) break;
  }
  const source = subjectSource(db.pool);
  const snapshot = (await source.read(partition, [subject])).subjects[0]!;
  expect(snapshot.statements.filter((row) => row.property === 'schema:author')).toHaveLength(128);
  const match = (source as Port).matchRelationFacets!;
  expect(await match(partition, [{ subject, property: 'ex:credit', value: target }])).toEqual([true]);
}, 300_000);
