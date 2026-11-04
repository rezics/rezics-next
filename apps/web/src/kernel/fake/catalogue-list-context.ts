import type { CatalogueContext } from '../../features/pages/catalogue-list-context/model';

export const catalogueIds = {
  book: '018f0000-0000-7000-8000-00a000000001',
  film: '018f0000-0000-7000-8000-00a000000002',
  creator: '018f0000-0000-7000-8000-00a000000003',
  realm: '018f0000-0000-7000-8000-00a000000004',
};
const source = { label: { en: 'Public catalogue source' }, observation: 'source-revision-7' };

/** Authored consumer examples for the reserved producer seam; not recorded native responses. */
export function catalogueExample(film = false) {
  const id = film ? catalogueIds.film : catalogueIds.book;
  const catalogueContext = {
    version: 1,
    subject: id,
    target: { id },
    observation: 'page-observation-7',
    state: 'ready',
    medium: { en: film ? 'Film' : 'Book' },
    creators: [
      {
        property: film ? 'schema:director' : 'schema:author',
        direction: 'subject-to-creator',
        role: { en: film ? 'Director' : 'Author' },
        name: { en: film ? 'Aki Mori' : 'Akira Mori' },
        target: { id: catalogueIds.creator },
        qualifiers: [{ label: { en: 'Credited as' }, value: { en: 'A. Mori' } }],
        source,
      },
    ],
    facts: [
      {
        property: 'schema:datePublished',
        label: { en: 'Published' },
        value: film ? { kind: 'time', year: 2005, month: 3 } : { kind: 'time', year: 1998 },
        source,
      },
    ],
    statistic: film
      ? {
          measure: { en: 'Provider rating' },
          value: 8.2,
          scale: { min: 0, max: 10 },
          count: 124,
          source,
        }
      : null,
    more: true,
  } satisfies CatalogueContext;
  return {
    id,
    type: film ? 'schema:Movie' : 'schema:Book',
    labels: { en: 'The Crossing' },
    summary: null,
    listPresentation: { imageAspect: 'portrait', keyFacts: ['schema:datePublished'] },
    catalogueContext,
  };
}
