import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest, validateRelease } from '@rezics/definitions';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { listSubjectRelations } from '../../src/semantic/links.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId } from '../../src/route/route.ts';
import { positionKey } from '../../src/semantic/link-keys.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { verticalManifests } from '../support/manifests.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
let eventRevision: string;
const route = 16128;
const event = newId(route);
const venue = newId(route);
const area = newId(route);
const instrument = newId(route);
const performers = Array.from({ length: 21 }, () => newId(route));
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(81)]]) };
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'music-context-growth',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};

async function create(id: string, type: string, label: string, digest: string) {
  await createSubject(db.pool, {
    actor,
    target: { route, id },
    idempotencyKey: id,
    digest: new Uint8Array(32),
    item: { type, labels: { en: label } },
    release: { digest, release: bundledRelease },
    authorize: async () => true,
  });
}

function statementRows(subject: string, type: string, statements: Record<string, BatchStatement[]>) {
  return itemFacts(subject, { statements }, type, bundledRelease).filter((fact) => fact.kind === 'statement');
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  const digest = await bootstrapRelease(db.pool, bundledRelease);
  await create(event, 'schema:MusicEvent', 'Selected music event', digest);
  await create(venue, 'schema:MusicVenue', 'Selected venue', digest);
  await create(area, 'schema:AdministrativeArea', 'Selected area', digest);
  await create(instrument, 'wd:Q34379', 'Selected instrument', digest);
  for (const [index, id] of performers.entries())
    await create(id, 'schema:Person', `Selected performer ${index}`, digest);

  const eventStatements = statementRows('' + event, 'schema:MusicEvent', {
    'schema:location': [
      {
        property: { id: 'schema:location' },
        value: { type: 'value', content: venue },
        qualifiers: [],
        references: [],
      },
    ],
    'schema:performer': performers.map((id, index) => ({
      property: { id: 'schema:performer' },
      value: { type: 'value', content: id },
      qualifiers: [
        { property: { id: 'wdt:P1303' }, value: { type: 'value', content: instrument } },
        { property: { id: 'wdt:P1932' }, value: { type: 'value', content: `Credit ${index + 1}` } },
      ],
      references: [],
    })),
  });
  const venueStatements = statementRows('' + venue, 'schema:MusicVenue', {
    'schema:containedInPlace': [
      {
        property: { id: 'schema:containedInPlace' },
        value: { type: 'value', content: area },
        qualifiers: [],
        references: [],
      },
    ],
  });
  eventRevision = randomUUID();
  const venueRevision = randomUUID();
  const outbound = [
    ...eventStatements.map((fact, index) => {
      const isPerformer = fact.property === 'schema:performer';
      const target = isPerformer ? performers[index - 1]! : venue;
      const order = isPerformer ? positionKey(String(index)) : positionKey('1');
      return {
        route,
        subject_id: event,
        property: fact.property!,
        filter_value: isPerformer ? instrument : '00000000-0000-0000-0000-000000000000',
        order_key: order,
        target_subject_id: target,
        statement_id: fact.statement_id!,
        slot_id: fact.slot_id,
        relation: true,
        source_type: 'schema:MusicEvent',
        source_order_key: order,
        outbound_order: 'name',
        source_revision: 2,
        source_security_revision: 0,
        target_revision: 1,
        target_type: isPerformer ? 'schema:Person' : 'schema:MusicVenue',
        external: null,
        value: 'value',
        present: true,
        recorded_transaction_id: eventRevision,
      };
    }),
    ...venueStatements.map((fact) => ({
      route,
      subject_id: venue,
      property: fact.property!,
      filter_value: '00000000-0000-0000-0000-000000000000',
      order_key: positionKey('1'),
      target_subject_id: area,
      statement_id: fact.statement_id!,
      slot_id: fact.slot_id,
      relation: true,
      source_type: 'schema:MusicVenue',
      source_order_key: positionKey('1'),
      outbound_order: 'name',
      source_revision: 2,
      source_security_revision: 0,
      target_revision: 1,
      target_type: 'schema:AdministrativeArea',
      external: null,
      value: 'value',
      present: true,
      recorded_transaction_id: venueRevision,
    })),
  ];
  await seed(
    db,
    {
      name: 'selected-music-context-window',
      hotPartition: route >> 4,
      hotShare: 1,
      rows: ({ ordinal }) => ({
        'semantic.revision':
          ordinal === 0
            ? [
                {
                  route,
                  subject_id: event,
                  revision: 2,
                  kind: 'adopt',
                  release: bundledDigest,
                  recorded_transaction_id: eventRevision,
                },
                {
                  route,
                  subject_id: venue,
                  revision: 2,
                  kind: 'adopt',
                  release: bundledDigest,
                  recorded_transaction_id: venueRevision,
                },
              ]
            : [],
        'semantic.fact':
          ordinal === 0
            ? [...eventStatements, ...venueStatements].map((fact) => ({
                ...fact,
                route,
                subject_id: eventStatements.includes(fact) ? event : venue,
                recorded_transaction_id: eventStatements.includes(fact) ? eventRevision : venueRevision,
                release: bundledDigest,
                relation: true,
              }))
            : [],
        'semantic.outbound_link': ordinal === 0 ? outbound : [],
        'semantic.outbound_link_count':
          ordinal === 0
            ? [
                {
                  route,
                  subject_id: event,
                  property: 'schema:location',
                  filter_value: '00000000-0000-0000-0000-000000000000',
                  value: 1,
                },
                {
                  route,
                  subject_id: event,
                  property: 'schema:performer',
                  filter_value: instrument,
                  value: performers.length,
                },
                {
                  route,
                  subject_id: venue,
                  property: 'schema:containedInPlace',
                  filter_value: '00000000-0000-0000-0000-000000000000',
                  value: 1,
                },
              ]
            : [],
      }),
    },
    { from: 0, to: 1 },
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
});

test('music event, place and exact instrument-credit windows stay fixed as identities and same-subject history grow', async () => {
  const unrelatedRoute = route + 16;
  const report = await checkGrowth(db, {
    name: 'music context selected relation windows',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      await seed(
        database,
        {
          name: 'unrelated-music-identities',
          hotPartition: unrelatedRoute >> 4,
          hotShare: 1,
          rows: ({ ordinal, route: grown }) => {
            const subject = newId(grown);
            const transaction = randomUUID();
            const facts = itemFacts(
              subject,
              { labels: { en: `Unrelated music identity ${ordinal}` } },
              'schema:Place',
              bundledRelease,
            );
            return {
              'semantic.subject': [
                {
                  route: grown,
                  subject_id: subject,
                  type: 'schema:Place',
                  recorded_transaction_id: transaction,
                  visibility: 'visible',
                  security_revision: 0,
                  current_facts: facts.length,
                  current_release: bundledDigest,
                  projection_pending: false,
                },
              ],
              'semantic.revision': [
                {
                  route: grown,
                  subject_id: subject,
                  revision: 1,
                  kind: 'create',
                  release: bundledDigest,
                  recorded_transaction_id: transaction,
                },
              ],
              'semantic.fact': facts.map((fact) => ({
                ...fact,
                route: grown,
                subject_id: subject,
                recorded_transaction_id: transaction,
                release: fact.kind === 'statement' && fact.operation === 'assert' ? bundledDigest : null,
                relation: false,
              })),
            };
          },
        },
        { from: previous, to: scale },
      );

      await seed(
        database,
        {
          name: 'selected-event-obsolete-history',
          hotPartition: route >> 4,
          hotShare: 1,
          rows: ({ ordinal }) => {
            const slot = newId(route);
            const oldStatement = newId(route);
            const oldTarget = newId(route);
            const body = {
              rank: 'normal',
              value: { type: 'value', content: oldTarget },
              qualifiers: [{ property: { id: 'wdt:P1303' }, value: { type: 'value', content: instrument } }],
              references: [],
            };
            return {
              'semantic.fact': [
                {
                  route,
                  subject_id: event,
                  slot_id: slot,
                  log_seq: 1,
                  operation: 'assert',
                  kind: 'statement',
                  language: null,
                  property: 'schema:performer',
                  statement_id: oldStatement,
                  body,
                  recorded_transaction_id: eventRevision,
                  release: bundledDigest,
                  relation: true,
                },
                {
                  route,
                  subject_id: event,
                  slot_id: slot,
                  log_seq: 2,
                  operation: 'retract',
                  kind: 'statement',
                  language: null,
                  property: 'schema:performer',
                  statement_id: oldStatement,
                  body,
                  recorded_transaction_id: eventRevision,
                  release: null,
                  relation: true,
                },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    operation: async () => {
      const page = async (subject: string, property: string, filter?: string) =>
        listSubjectRelations(db.pool, ring, {
          routeKey: new Uint8Array(32).fill(82),
          subject,
          property,
          ...(filter ? { filter } : {}),
          limit: 20,
          release: bundledRelease,
          authorize: async () => true,
          authorizeSummary: async () => true,
          seen: [],
          caughtUp: true,
        });
      const [location, containment, credit] = await Promise.all([
        page(event, 'schema:location'),
        page(venue, 'schema:containedInPlace'),
        page(event, 'schema:performer', instrument),
      ]);
      expect(location.relations).toHaveLength(1);
      expect(location.next).toBeNull();
      expect(containment.relations).toHaveLength(1);
      expect(containment.next).toBeNull();
      expect(credit.relations).toHaveLength(20);
      expect(credit.next).not.toBeNull();
      const result = { location, containment, credit };
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(3 * 20 * 128 * 1024);
      return result;
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});

test('released music types stay on the generic engine path at 10 and 100 manifests', async () => {
  const bundled = bundledSources();
  const compile = async (count: number) => {
    const extra = verticalManifests(count);
    const imports = Array.from({ length: count }, (_, index) => `  - v${index}`).join('\n');
    return compileCatalogue({
      root: bundled.root,
      schemas: {
        ...bundled.schemas,
        ...extra.schemas,
        'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${imports}\n`,
      },
      presentation: { ...bundled.presentation, ...extra.presentation },
      contexts: bundled.contexts,
    });
  };
  for (const count of [10, 100]) {
    const release = await compile(count);
    expect(validateRelease(release)).toEqual([]);
    expect(release.types['schema:MusicEvent']?.iri).toBe('http://schema.org/MusicEvent');
    expect(release.types['schema:MusicVenue']?.iri).toBe('http://schema.org/MusicVenue');
    expect(release.types['wd:Q34379']?.iri).toBe('http://www.wikidata.org/entity/Q34379');
    expect(release.properties['schema:performer']?.relation?.slotKey).toBe('wdt:P1303');
    expect(releaseDigest(release)).not.toBe(bundledDigest);
  }
}, 180_000);
