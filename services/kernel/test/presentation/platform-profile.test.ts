import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  planReads,
  platformRegistry,
  profileDigest,
  resolveTemplate,
  templateViews,
  validateProfile,
  type CompositionDocument,
} from '@rezics/composition';
import { admitFilter, parseFilter, type FilterRelease } from '@rezics/filter';
import { createPool } from '../../src/database/pool.ts';
import { activeProfile } from '../../src/presentation/profiles.ts';
import { platformProfile, setupPresentation } from '../../src/presentation/setup.ts';

const presentation = new URL('../../../../packages/definitions/presentation/', import.meta.url);
const verticals = readdirSync(presentation, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const starters = verticals
  .map((vertical) => ({ vertical, file: new URL(`${vertical}/zone.json`, presentation) }))
  .filter(({ file }) => existsSync(file))
  .map(({ vertical, file }) => ({ vertical, value: JSON.parse(readFileSync(file, 'utf8')) as unknown }));
const release = bundledRelease as unknown as FilterRelease;
const placeholder = '00000000-0000-8000-8000-000000000000';

test('the platform profile is valid and gives every bundled type a default page', () => {
  expect(validateProfile(platformRegistry, platformProfile())).toEqual([]);
  expect(platformProfile().bases.map(({ base }) => base)).toEqual(['schema:CreativeWork', 'schema:CreativeWorkSeries']);
  expect(platformProfile().types.map(({ type }) => type)).toEqual([
    'schema:Organization',
    'schema:Person',
    'skos:Concept',
    'wd:Q95074',
  ]);
  expect(platformProfile().routes.map(({ route }) => route)).toEqual(['/']);
  for (const [type, definition] of Object.entries(bundledRelease.types)) {
    const { scope, key } = resolveTemplate(platformProfile(), { type, bases: definition.bases });
    const typeKey =
      type === 'schema:Organization' || type === 'schema:Person' || type === 'skos:Concept' || type === 'wd:Q95074'
        ? type
        : null;
    const baseKey = definition.bases.find(
      (candidate) => candidate === 'schema:CreativeWorkSeries' || candidate === 'schema:CreativeWork',
    );
    expect({ type, scope, key }).toEqual(
      typeKey
        ? { type, scope: 'type', key: typeKey }
        : baseKey
          ? { type, scope: 'base', key: baseKey }
          : { type, scope: 'generic', key: null },
    );
  }
});

test('every list in a shipped document is admitted by the bundled release', () => {
  const templates = [
    ['generic', platformProfile().generic] as const,
    ...platformProfile().bases.map((entry) => [entry.base, entry] as const),
    ...platformProfile().types.map((entry) => [entry.type, entry] as const),
  ];
  const documents: [string, CompositionDocument][] = [
    ...templates.flatMap(([name, template]) =>
      Object.entries(templateViews(template)).map(([view, document]): [string, CompositionDocument] => [
        `${name}/${view}`,
        document!,
      ]),
    ),
    ...starters.flatMap(({ vertical, value }) =>
      ((value as { pages?: { route: string; document: CompositionDocument }[] }).pages ?? []).map(
        ({ route, document }): [string, CompositionDocument] => [`${vertical}/${route}`, document],
      ),
    ),
  ];
  for (const [name, document] of documents) {
    for (const read of Object.values(planReads(platformRegistry, document, { subject: placeholder }).reads)) {
      if (read.kind !== 'search') continue;
      let refusal: unknown = null;
      try {
        admitFilter(parseFilter(read.body.filter), release);
      } catch (error) {
        refusal = error;
      }
      expect({ name, filter: read.body.filter, refusal }).toEqual({ name, filter: read.body.filter, refusal: null });
    }
  }
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(() => pool.end());

test('setup activates the platform profile once', async () => {
  const digest = profileDigest(platformProfile());
  expect(await setupPresentation(pool)).toBe(digest);
  expect(await setupPresentation(pool)).toBe(digest);
  expect((await activeProfile(pool))?.digest).toBe(digest);
});
