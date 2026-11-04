import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, type PresentationProfile } from '@rezics/composition';
import { releaseDigest } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bundledSources } from '../../../../packages/definitions/src/bundled.ts';
import { compileCatalogue } from '../../../../packages/definitions/src/compile.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { cataloguePageMetadata } from '../../src/presentation/semantic-page.ts';
import { openGrowthDatabase, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import { seedSemanticPopulation, unrelatedSemanticPopulation } from './planner-fixtures.ts';
import { verticalManifests } from '../support/manifests.ts';
import { createRealAccess } from './real-access.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
let fileId: string;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000266';
const routeKey = new Uint8Array(32).fill(116);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(117)]]) };
const actions = ['subject:create', 'subject:read', 'statement:propose', 'presentation:read'];
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: {
    views: {
      overview: {
        root: { props: {} },
        content: [
          { type: 'SubjectHeader', props: { id: 'header' } },
          { type: 'Statements', props: { id: 'file-facts', properties: ['wdt:P4092', 'wdt:P3575', 'rezics:codec'] } },
          { type: 'RelationGroups', props: { id: 'episodes', property: 'schema:encodesCreativeWork', limit: 20 } },
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
  real = await createRealAccess(db.admin, { editor }, actions);
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({ pool: db.pool, routeKey, tokens, access: real.access, writeRate: real.writeRate });
  const response = await app.handle(
    new Request('http://kernel.test/v1/subjects', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${real.bearer('editor')}`,
        'content-type': 'application/json',
        'idempotency-key': `"${randomUUID()}"`,
      },
      body: JSON.stringify({
        type: 'schema:MediaObject',
        labels: { en: 'Measured catalogue file' },
        statements: {
          'wdt:P4092': [
            {
              property: { id: 'wdt:P4092' },
              value: { type: 'value', content: 'exact-hash' },
              qualifiers: [{ property: { id: 'rezics:hashAlgorithm' }, value: { type: 'value', content: 'sha256' } }],
              references: [],
            },
          ],
        },
      }),
    }),
  );
  const body = (await response.json()) as any;
  expect(response.status).toBe(201);
  fileId = body.subject.id;
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

test('current file descriptors stay data driven as released vertical manifests expand', async () => {
  const source = bundledSources();
  for (const count of [10, 100]) {
    const verticals = verticalManifests(count);
    const release = await compileCatalogue({
      ...source,
      schemas: { ...source.schemas, ...verticals.schemas },
      presentation: { ...source.presentation, ...verticals.presentation },
    });
    const page = cataloguePageMetadata(release, releaseDigest(release), 'schema:MediaObject');
    expect(page?.state).toBe('released');
    expect(page?.definitions?.types['schema:MediaObject']?.properties).toContain('wdt:P4092');
    expect(page?.definitions?.types['schema:MediaObject']?.properties).toContain('rezics:releaseGroup');
    expect(page?.definitions?.properties).toHaveProperty('rezics:hashAlgorithm');
  }
});

test('released file page work and response bytes stay fixed as unrelated semantic population grows', async () => {
  const population = unrelatedSemanticPopulation('catalogue-file-page-unrelated', 4094).population;
  const scales = [64, 512, 4096] as const;
  await checkGrowth(db, {
    name: 'Catalogue file identity page',
    scales,
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    grow: async (database, scale, previous) => {
      await seedSemanticPopulation(database, population, { from: previous, to: scale });
    },
    operation: async () => {
      const response = await app.handle(
        new Request('http://kernel.test/v1/pages:read', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${real.bearer('editor')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ target: { subject: fileId }, languages: ['en'] }),
        }),
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as any;
      expect(page.catalogue).toMatchObject({ state: 'released', type: 'schema:MediaObject', digest: bundledDigest });
      expect(page.catalogue.definitions.properties).toHaveProperty('wdt:P4092');
      expect(page.viewer.actions.statementPropose).toBe('allowed');
      expect(Object.values(page.reads).some((read: any) => read.status === 200 && read.body.subject?.id === fileId)).toBe(
        true,
      );
      return page;
    },
  });
  expect(cataloguePageMetadata(bundledRelease, bundledDigest, 'wd:Q82753')).toMatchObject({
    state: 'unsupported',
    type: 'wd:Q82753',
  });
});
