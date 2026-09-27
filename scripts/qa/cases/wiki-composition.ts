import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/wiki-composition.md', [
  {
    id: 'WIKI01',
    scenario: 'Mount one Collection in two Zones',
    requiredResult: 'Shared members; independent presentation/context.',
  },
  {
    id: 'WIKI02',
    scenario: 'Remove mount or retire Zone capability',
    requiredResult: 'Content and Realm capability remain valid.',
  },
  {
    id: 'WIKI03',
    scenario: 'Private members in public Collection',
    requiredResult: 'No title/count/snippet leakage.',
  },
  {
    id: 'WIKI04',
    scenario: 'Dynamic Collection saved and captured',
    requiredResult: 'Query definition separate from stored snapshot membership.',
  },
  {
    id: 'WIKI05',
    scenario: 'Realm accepts old body while source edits',
    requiredResult: 'Serving text/search/media use accepted selection.',
  },
  {
    id: 'WIKI06',
    scenario: 'Reorder repeated members',
    requiredResult: 'Occurrence identity and exact history retained.',
  },
]);
