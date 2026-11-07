import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const language = 'schema:inLanguage';

test('language remains filterable where registered while file language remains metadata', () => {
  for (const key of ['rezics:AnimeRelease', 'schema:Book', 'schema:Quotation']) {
    expect(bundledRelease.types[key]?.properties).toContain(language);
    expect(bundledRelease.types[key]?.facets).toContain(language);
  }
  expect(bundledRelease.types['schema:MediaObject']?.properties).toContain(language);
  expect(bundledRelease.types['schema:MediaObject']?.facets).not.toContain(language);
});
