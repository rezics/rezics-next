import { expect, test } from 'bun:test';
import { RELEASE_FORMAT, releaseDigest, type Release } from '@rezics/definitions';
import { compilePublicFilterConsumerCapture } from '../../src/search/public-filter-consumer.ts';
import { parseText } from '../../src/search/text.ts';

test('negative qualified alternatives retain qualifier keys independently of containing overflow properties', () => {
  const property = (name: string, qualifiers: string[] = []) => ({
    iri: `https://example.test/${name}`,
    labels: { en: name },
    mappings: [],
    datatype: 'wikibase-item' as const,
    multivalued: true,
    qualifiers,
    value: {},
  });
  const release: Release = {
    format: RELEASE_FORMAT,
    catalogue: { id: 'qualified', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: {},
    types: {
      'schema:Book': {
        iri: 'https://schema.org/Book',
        labels: { en: 'Book' },
        mappings: [],
        bases: [],
        properties: ['schema:author'],
        facets: ['schema:author'],
      },
    },
    properties: {
      'schema:author': property('author', ['rezics:role']),
      'rezics:role': property('role'),
    },
  };
  const id = '018f0000-0000-7000-8000-00a000000009';
  const compiled = compilePublicFilterConsumerCapture(
    {
      filterDocument: {
        or: [
          { type: { in: ['schema:Book'] } },
          {
            not: {
              statement: {
                property: 'schema:author',
                in: [id],
                qualifiers: [{ property: 'rezics:role', in: [id] }],
              },
            },
          },
        ],
      },
      text: parseText('novel -secret'),
      sort: 'collections',
      size: 20,
    },
    { release, digest: releaseDigest(release), type: 'schema:Book' },
  );
  expect(compiled.dependencyKeys).toContainEqual({ kind: 'property', property: 'rezics:role' });
  expect(compiled.dependencyKeys).toContainEqual({ kind: 'property', property: 'schema:author' });
  expect(compiled.dependencyKeys).toContainEqual({ kind: 'type' });
  for (const order of ['id', 'name', 'relevance', 'collections'] as const)
    expect(compiled.dependencyKeys).toContainEqual({ kind: 'order', order });
  expect(compiled.filterLeaves.find((leaf) => leaf.facet === 'statement')?.negated).toBe(true);
  expect(compiled.capture.overflowProperties).toEqual(['schema:author']);
});
