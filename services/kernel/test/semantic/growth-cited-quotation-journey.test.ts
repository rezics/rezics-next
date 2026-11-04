import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { bundledDigest, bundledRelease, bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { RELEASE_LIMITS, validateRelease } from '@rezics/definitions';
import { fromPlainText } from '@rezics/document';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { derivedId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000231';
const routeKey = new Uint8Array(32).fill(43);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(44)]]) };
const scales = [64, 512, 4096] as const;
let quotationId: string;
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: {
        root: { props: {} },
        content: [
          { type: 'SubjectHeader', props: { id: 'header' } },
          {
            type: 'Statements',
            props: {
              id: 'quotation-facts',
              properties: ['schema:text', 'schema:spokenByCharacter', 'schema:about', 'schema:creator'],
            },
          },
        ],
      },
    },
  },
  bases: [],
  types: [],
  routes: [],
};

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  await bootstrapProfile(db.pool, profile);
  real = await createRealAccess(db.admin, { editor }, ['subject:create', 'subject:read', 'statement:propose']);
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:create');
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:read');
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    receiptKeys: testReceiptKeys(),
    access: real.access,
    writeRate: real.writeRate,
  });
  const created = await app.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${real.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      body: JSON.stringify({
        type: 'schema:Quotation',
        labels: { en: 'Fixed quotation' },
        statements: {
          'schema:text': [
            {
              property: { id: 'schema:text' },
              value: {
                type: 'value',
                content: { document: fromPlainText('Fixed line'), language: 'en', licence: 'CC-BY-4.0' },
              },
              references: [
                {
                  parts: [
                    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/q' } },
                  ],
                },
              ],
            },
          ],
          'schema:spokenByCharacter': [
            {
              property: { id: 'schema:spokenByCharacter' },
              value: { type: 'somevalue' },
              references: [
                {
                  parts: [
                    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/s' } },
                  ],
                },
              ],
            },
          ],
        },
      }),
    }),
  );
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as {
    subject: { id: string; statements: Record<string, { value: { type: string } }[]> };
  };
  expect(createdBody.subject.statements['schema:spokenByCharacter']?.[0]?.value.type).toBe('somevalue');
  quotationId = createdBody.subject.id;
  const projection = linkProjection(db.pool);
  const partition = partitionOf(routeOf(quotationId)!);
  let caughtUp = false;
  for (let step = 0; step < 200; step++) {
    const result = await projection.run(partition);
    if (result.status === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    if (result.envelopes === 0) {
      caughtUp = true;
      break;
    }
  }
  if (!caughtUp) throw new Error('Semantic link projection did not catch up');
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

const unrelatedNamespace = '00000000-0000-4000-8000-00000000c100';
function unrelated(): Population {
  return {
    name: 'cited-quotation-unrelated',
    hotPartition: 4094,
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const id = derivedId(unrelatedNamespace, `cited-quotation-unrelated:${ordinal}`, route);
      const tx = randomUUID();
      const facts = itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } });
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: tx,
            visibility: 'visible',
            security_revision: 0,
            current_facts: facts.length,
            current_release: bundledDigest,
            projection_pending: false,
          },
        ],
        'semantic.revision': [
          {
            route,
            subject_id: id,
            revision: 1,
            kind: 'create',
            release: bundledDigest,
            recorded_transaction_id: tx,
          },
        ],
        'semantic.fact': facts.map((fact) => ({
          ...fact,
          route,
          subject_id: id,
          recorded_transaction_id: tx,
          release: null,
          relation: false,
        })),
      };
    },
  };
}

test('fixed quotation page work stays bounded as unrelated facts grow', async () => {
  const population = unrelated();
  const report = await checkGrowth(db, {
    name: 'cited quotation page',
    scales,
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) => {
      const target = { pool: database.pool, admin: database.admin };
      const range = { from: previous, to: scale };
      await seed(
        target,
        {
          ...population,
          rows: (placement) => {
            const rows = population.rows!(placement);
            return {
              'semantic.subject': rows['semantic.subject']!,
              'semantic.revision': rows['semantic.revision']!,
            };
          },
        },
        range,
      );
      await seed(
        target,
        {
          ...population,
          rows: (placement) => ({ 'semantic.fact': population.rows!(placement)['semantic.fact']! }),
        },
        range,
      );
    },
    operation: async () => {
      const response = await app.handle(
        new Request('http://kernel.test/v1/pages:read', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${real.bearer('editor')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ target: { subject: quotationId }, languages: ['en'] }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        viewer?: { kind: string };
        reads: Record<string, { status: number; body?: any }>;
      };
      expect(body.viewer).toEqual({ kind: 'account' });
      const facts = Object.values(body.reads).find(
        (result) => result.status === 200 && result.body?.subject?.id === quotationId,
      )?.body;
      expect(facts.subject.id).toBe(quotationId);
      expect(facts.subject.statements['schema:text'][0].value.content.language).toBe('en');
      expect(facts.subject.statements['schema:spokenByCharacter'][0].value.type).toBe('somevalue');
      const document = facts.documents[facts.subject.statements['schema:text'][0].id];
      expect(document.availability).toBe('available');
      expect(document.language).toBe('en');
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
});

test('ten and one hundred extra document and relation manifests keep generic engines', async () => {
  for (const count of [10, 100]) {
    const bundled = bundledSources();
    const classes = Array.from(
      { length: count },
      (_, index) => `  ExtraQuote${index}:
    is_a: Thing
    class_uri: schema:ExtraQuote${index}
    slots: [extraText${index}, extraAbout${index}]
    annotations:
      cover_ratio: 5:7
      schema_org_type: https://schema.org/Quotation
      list_presentation:
        imageAspect: portrait
        keyFacts: []`,
    ).join('\n');
    const slots = Array.from(
      { length: count },
      (_, index) => `  extraText${index}:
    slot_uri: schema:extraText${index}
    annotations:
      datatype: document
  extraAbout${index}:
    slot_uri: schema:extraAbout${index}
    range: CreativeWork
    annotations:
      datatype: wikibase-item
      relation_group: association
      inverse: none`,
    ).join('\n');
    const extraYaml = `id: https://rezics.com/catalogue/extra-quotes
name: extra-quotes
version: 1.0.0
prefixes:
  linkml: https://w3id.org/linkml/
  schema: http://schema.org/
imports:
  - linkml:types
  - core
classes:
${classes}
slots:
${slots}
`;
    const labels = {
      types: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`schema:ExtraQuote${index}`, `extra ${index}`]),
      ),
      properties: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          [`schema:extraText${index}`, 'text'],
          [`schema:extraAbout${index}`, 'about'],
        ]).flat(),
      ),
    };
    const release = await compileCatalogue({
      ...bundled,
      schemas: {
        ...bundled.schemas,
        'extra-quotes.yaml': extraYaml,
        'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n  - extra-quotes\n`,
      },
      presentation: { ...bundled.presentation, 'extra-quotes/en': JSON.stringify(labels) },
    });
    expect(validateRelease(release)).toEqual([]);
    expect(Object.keys(release.types)).toHaveLength(Object.keys(bundledRelease.types).length + count);
    expect(release.properties['schema:text']?.datatype).toBe('document');
    expect(release.properties['schema:about']?.datatype).toBe('wikibase-item');
    expect(Buffer.byteLength(JSON.stringify(release))).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
    expect(release.types['schema:Quotation']).toEqual(bundledRelease.types['schema:Quotation']);
  }
});
