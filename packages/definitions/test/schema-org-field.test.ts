import { expect, test } from 'bun:test';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { validateRelease, type Release } from '../src/index.ts';

async function fixture(schemaType?: unknown) {
  const schema = {
    id: 'https://example.test/seo-types',
    name: 'seo_types',
    version: '1.0.0',
    prefixes: { linkml: 'https://w3id.org/linkml/', ex: 'https://example.test/' },
    imports: ['linkml:types'],
    default_range: 'string',
    classes: {
      Work: {
        class_uri: 'ex:Work',
        ...(schemaType === undefined ? {} : { annotations: { schema_org_type: schemaType } }),
      },
    },
  };
  return compileCatalogue({
    root: 'seo.yaml',
    schemas: { 'seo.yaml': JSON.stringify(schema) },
    presentation: { 'seo/en': 'types:\n  ex:Work: Example work\n' },
  });
}
const metadata = (release: Release) => release.types['ex:Work'] as unknown as { schemaOrgType?: unknown };

test('a fixture profile changes its JSON-LD type through configuration alone', async () => {
  const jsonLdTypes: string[] = [];
  for (const type of ['CreativeWork', 'Book', '3DModel']) {
    const iri = `https://schema.org/${type}`;
    const release = await fixture(iri);
    expect(metadata(release).schemaOrgType).toBe(iri);
    expect(validateRelease(release)).toEqual([]);
    jsonLdTypes.push((metadata(release).schemaOrgType as string).slice('https://schema.org/'.length));
  }
  expect(jsonLdTypes).toEqual(['CreativeWork', 'Book', '3DModel']);
});

test('missing legacy metadata stays valid and unsafe type IRIs are rejected', async () => {
  const legacy = await fixture();
  expect(metadata(legacy).schemaOrgType).toBeUndefined();
  expect(validateRelease(legacy)).toEqual([]);
  for (const bad of [
    'javascript:Book',
    'https://evil.test/Book',
    'https://schema.org/Book?x=1',
    'https://schema.org/Book/Other',
    7,
  ]) {
    await expect(fixture(bad)).rejects.toBeInstanceOf(CatalogueError);
    const release = structuredClone(legacy);
    metadata(release).schemaOrgType = bad;
    expect(validateRelease(release).some((error) => error.pointer.endsWith('/schemaOrgType'))).toBe(true);
  }
});
