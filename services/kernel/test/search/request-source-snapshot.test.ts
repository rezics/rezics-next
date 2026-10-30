import { expect, test } from 'bun:test';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { discloseFacetValues } from '../../src/search/facets.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';

test('wrong-home current facts cannot disclose either a hit or a facet label', async () => {
  const id = newId(160),
    partition = partitionOf(routeOf(id)!);
  const subject: IndexedSubject = {
    id,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Wrong-home facts' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const source: SubjectSource = {
    async read() {
      return { partition: partition + 1, position: 1n, subjects: [subject] };
    },
    async count() {
      throw new Error('Request hydration must not enumerate');
    },
  };
  await expect(
    checkHits(source, [{ id, partition, securityRevision: 1, matched: [] }], new Map()),
  ).rejects.toBeInstanceOf(Error);
  await expect(discloseFacetValues(source, [id])).rejects.toBeInstanceOf(Error);
});
