import type { FacetDefinition } from '../compiler/facet.ts';

/**
 * A Main Version's standing mean in one Realm rating question: the bound rating Context supplies
 * the question, its Account population and its 1-10 scale. Unrated Works never fall in a range.
 */
export const ratingFacet = {
  name: 'rating',
  version: 1,
  labels: { en: 'Rating', 'zh-Hant': '評分', 'zh-Hans': '评分', ja: '評価', ko: '평점', de: 'Bewertung',
    fr: 'Note', es: 'Valoración' },
  appliesTo: 'resource',
  subject: 'schema:CreativeWork',
  path: [{ kind: 'triple', predicate: 'rv:mainVersion' }, { kind: 'rating', target: 'rv:MainVersion',
    cadence: '<https://rezics.com/definition/rating-standing-v1>',
    population: '<https://rezics.com/definition/rating-account-principal-population-v1>',
    aggregation: '<https://rezics.com/definition/rating-latest-per-rater-mean-v1>', scale: { min: 1, max: 10 } }],
  parameters: [{ key: 'ratingContext', value: { kind: 'class', class: 'rv:RatingContext' } }],
  values: [{ kind: 'datatype', datatype: 'xsd:decimal', min: '1', max: '10' }],
  operators: ['range'],
  source: 'context',
  cost: { maxValues: 2, graphReads: 1 },
} as const satisfies FacetDefinition;
