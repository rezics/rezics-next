import { expect, test } from 'bun:test';
import { createReleasedRelationDirectionResolver } from '@rezics/definitions';
import { releaseDigest, valueSchema, DATA_TYPES, type Release } from '../src/index.ts';
import { bundledDigest, bundledRelease } from '../src/bundled.ts';
import { releaseDigest as portableDigest } from '../src/browser.ts';

test('browser package exports load portable helpers and compiled data without native initialization', async () => {
  const result = await Bun.build({
    entrypoints: [import.meta.path],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'definitions-browser-boundary',
        setup(build) {
          // Replace only this test entry, so all package exports and transitive
          // dependencies use the real browser resolver without aliases or shims.
          build.onLoad({ filter: /browser-loading\.test\.ts$/ }, () => ({
            loader: 'ts',
            contents: `
              import * as definitions from '@rezics/definitions';
              import * as bundled from '@rezics/definitions/bundled';
              import * as validation from '@rezics/definitions/validate';
              import * as bulk from '@rezics/definitions/bulk';
              import * as media from '@rezics/definitions/media-import';
              export { definitions, bundled, validation, bulk, media };
            `,
          }));
          build.onResolve({ filter: /^(?:node:|recheck(?:\/|$))/ }, ({ path }) => {
            throw new Error(`Native dependency in browser exports: ${path}`);
          });
          build.onLoad({ filter: /\/(?:pattern-safety|publication-construction)\.ts$/ }, ({ path }) => {
            throw new Error(`Native initialization in browser exports: ${path}`);
          });
        },
      },
    ],
  });
  expect(result.logs).toEqual([]);
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  const source = await result.outputs[0]!.text();
  const loaded = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as {
    definitions: typeof import('../src/browser.ts');
    bundled: typeof import('../src/bundled-browser.ts');
    validation: typeof import('../src/validate.ts');
    bulk: typeof import('../src/bulk.ts');
    media: typeof import('../src/media-import.ts');
  };
  expect(loaded.definitions.DATA_TYPES).toEqual(DATA_TYPES);
  for (const datatype of DATA_TYPES) expect(loaded.definitions.valueSchema(datatype)).toEqual(valueSchema(datatype));
  expect(loaded.bundled.bundledRelease).toEqual(bundledRelease);
  expect(loaded.bundled.bundledDigest).toBe(bundledDigest);
  expect(loaded.definitions.releaseDigest(loaded.bundled.bundledRelease)).toBe(bundledDigest);
  const defaultDirections = createReleasedRelationDirectionResolver(bundledRelease, bundledDigest);
  const browserDirections = loaded.definitions.createReleasedRelationDirectionResolver(
    loaded.bundled.bundledRelease,
    loaded.bundled.bundledDigest,
  );
  const requests: Parameters<typeof defaultDirections.resolve>[] = [
    ['schema:Person', 'wdt:P725', 'inverse'],
    ['wd:Q95074', 'schema:character', 'inverse'],
    ['wd:Q95074', 'wdt:P725', 'inverse', { viaQualifier: 'wdt:P453' }],
    ['wd:Q95074', 'wdt:P453', 'inverse'],
    ['schema:Movie', 'wdt:P725', 'inverse'],
    ['schema:Person', 'rezics:notReleased', 'forward'],
  ];
  for (const request of requests)
    expect(browserDirections.resolve(...request)).toEqual(defaultDirections.resolve(...request));
  expect(
    loaded.definitions.createReleasedRelationDirectionResolver(undefined, undefined).resolve(
      'schema:Person',
      'wdt:P725',
      'inverse',
    ),
  ).toEqual(
    createReleasedRelationDirectionResolver(undefined, undefined).resolve('schema:Person', 'wdt:P725', 'inverse'),
  );
  const input = { type: 'schema:Person', labels: { en: 'Browser helper' } };
  expect(loaded.validation.checkSubjectInput(input, loaded.bundled.bundledRelease).violations).toEqual([]);
  expect(loaded.validation.checkSubjectStructure({ ...input, labels: {} }).violations).toContainEqual({
    pointer: '/labels',
    code: 'required',
  });
  expect(loaded.bulk.BATCH_LIMIT).toBe(100);
  expect(typeof loaded.media.checkMediaImportRequest).toBe('function');
  // Server operations are absent, rather than returning invented verdicts.
  expect(loaded.definitions).not.toHaveProperty('validateRelease');
  expect(loaded.bundled).not.toHaveProperty('bundledSources');
});

test('portable release digests retain native canonical JSON and UTF-8 identities', () => {
  const releases: Release[] = [bundledRelease];
  const unicode = structuredClone(bundledRelease);
  unicode.generator.name = '人物 — café 👩🏽‍💻';
  releases.push(unicode, Object.fromEntries(Object.entries(unicode).reverse()) as Release);
  for (const release of releases) expect(portableDigest(release)).toBe(releaseDigest(release));
  expect(portableDigest(releases[1]!)).toBe(portableDigest(releases[2]!));
  expect(portableDigest(unicode)).not.toBe(bundledDigest);
});
