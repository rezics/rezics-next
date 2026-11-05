import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest, validateRelease } from '@rezics/definitions';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { listSubjectRelations } from '../../src/semantic/links.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';
import { verticalManifests } from '../support/manifests.ts';
import { positionKey } from '../../src/semantic/link-keys.ts';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
const route = 16112;
const holder = newId(route);
const recording = newId(route);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(91)]]) };
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'album-release-growth',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const selectedTracks = 21;
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  const digest = await bootstrapRelease(db.pool, bundledRelease);
  for (const [id, type, label] of [
    [holder, 'schema:MusicRelease', 'Selected harbour CD'],
    [recording, 'schema:MusicRecording', 'Selected harbour take'],
  ] as const) {
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
  const adopt = randomUUID();
  const tracks = Array.from({ length: selectedTracks }, (_, index) => ({
    property: { id: 'schema:track' },
    value: { type: 'value' as const, content: recording },
    qualifiers: [
      { property: { id: 'schema:position' }, value: { type: 'value' as const, content: String(index + 1) } },
      { property: { id: 'wdt:P642' }, value: { type: 'value' as const, content: newId(route) } },
    ],
    references: [],
  }));
  const statements = itemFacts(
    holder,
    { statements: { 'schema:track': tracks } },
    'schema:MusicRelease',
    bundledRelease,
  ).filter((fact) => fact.kind === 'statement');
  await seed(
    db,
    {
      name: 'selected-album-tracks',
      hotPartition: route >> 4,
      hotShare: 1,
      rows: ({ ordinal }) => ({
        'semantic.revision':
          ordinal === 0
            ? [
                {
                  route,
                  subject_id: holder,
                  revision: 2,
                  kind: 'adopt',
                  release: bundledDigest,
                  recorded_transaction_id: adopt,
                },
              ]
            : [],
        'semantic.fact':
          ordinal === 0
            ? statements.map((fact) => ({
                ...fact,
                route,
                subject_id: holder,
                recorded_transaction_id: adopt,
                release: bundledDigest,
                relation: true,
              }))
            : [],
        'semantic.outbound_link':
          ordinal === 0
            ? statements.map((fact, index) => {
                const orderKey = positionKey(String(index + 1));
                return {
                  route,
                  subject_id: holder,
                  property: 'schema:track',
                  filter_value: '00000000-0000-0000-0000-000000000000',
                  order_key: orderKey,
                  target_subject_id: recording,
                  statement_id: fact.statement_id,
                  slot_id: fact.slot_id,
                  relation: true,
                  source_type: 'schema:MusicRelease',
                  source_order_key: orderKey,
                  outbound_order: 'position',
                  source_revision: 2,
                  source_security_revision: 0,
                  target_revision: 1,
                  target_type: 'schema:MusicRecording',
                  external: null,
                  value: 'value',
                  present: true,
                  recorded_transaction_id: adopt,
                };
              })
            : [],
        'semantic.outbound_link_count':
          ordinal === 0
            ? [
                {
                  route,
                  subject_id: holder,
                  property: 'schema:track',
                  filter_value: '00000000-0000-0000-0000-000000000000',
                  value: selectedTracks,
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

test('selected 20-track window stays fixed at 64/512/4096 unrelated releases and recordings', async () => {
  const unrelatedRoute = route + 16;
  const report = await checkGrowth(db, {
    name: 'album release recordings 20-slot window',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      await seed(
        database,
        {
          name: 'unrelated-music-population',
          hotPartition: unrelatedRoute >> 4,
          hotShare: 1,
          rows: ({ ordinal, route: grown }) => {
            const source = newId(grown);
            const target = newId(grown);
            const transaction = randomUUID();
            const facts = itemFacts(
              source,
              { labels: { en: `Unrelated release ${ordinal}` } },
              'schema:MusicRelease',
              bundledRelease,
            );
            return {
              'semantic.subject': [
                {
                  route: grown,
                  subject_id: source,
                  type: 'schema:MusicRelease',
                  recorded_transaction_id: transaction,
                  visibility: 'visible',
                  security_revision: 0,
                  current_facts: facts.length,
                  current_release: bundledDigest,
                  projection_pending: false,
                },
                {
                  route: grown,
                  subject_id: target,
                  type: 'schema:MusicRecording',
                  recorded_transaction_id: transaction,
                  visibility: 'visible',
                  security_revision: 0,
                  current_facts: 0,
                  current_release: bundledDigest,
                  projection_pending: false,
                },
              ],
              'semantic.revision': [
                {
                  route: grown,
                  subject_id: source,
                  revision: 1,
                  kind: 'create',
                  release: bundledDigest,
                  recorded_transaction_id: transaction,
                },
              ],
              'semantic.fact': facts.map((fact) => ({
                ...fact,
                route: grown,
                subject_id: source,
                recorded_transaction_id: transaction,
                release: fact.kind === 'statement' ? bundledDigest : null,
                relation: fact.kind === 'statement',
              })),
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    operation: async () => {
      const page = await listSubjectRelations(db.pool, ring, {
        routeKey: new Uint8Array(32).fill(2),
        subject: holder,
        property: 'schema:track',
        limit: 20,
        release: bundledRelease,
        authorize: async () => true,
        seen: [],
        caughtUp: true,
      });
      expect(page.relations.length).toBe(20);
      expect(page.next).not.toBeNull();
      expect(JSON.stringify(page).length).toBeLessThan(20 * 128 * 1024 + 64 * 1024);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 300_000);

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
    expect(release.types['schema:MusicRelease']?.iri).toBe('http://schema.org/MusicRelease');
    expect(release.types['schema:MusicRecording']?.iri).toBe('http://schema.org/MusicRecording');
    expect(release.properties['schema:track']?.relation?.slotKey).toBe('wdt:P642');
    expect(releaseDigest(release)).not.toBe(bundledDigest);
  }
}, 180_000);
