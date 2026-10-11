import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/recipes.md', [
  {
    id: 'RECIPE01',
    scenario: 'Same ingredient appears in two stages',
    requiredResult: 'Distinct occurrences and quantities.',
  },
  {
    id: 'RECIPE02',
    scenario: 'Scale exact fraction with ambiguous unit',
    requiredResult: 'No invented conversion; preserve source lexical.',
  },
  {
    id: 'RECIPE03',
    scenario: 'Import text/structured Recipe steps',
    requiredResult: 'Order/groups and unparsed residuals retained.',
  },
  {
    id: 'RECIPE04',
    scenario: 'Two Realm recipe variants',
    requiredResult: 'Shared Main Version with separate adoption.',
  },
  {
    id: 'RECIPE05',
    scenario: 'Compute nutrition/yield',
    requiredResult: 'Coverage and unit basis explicit.',
  },
  {
    id: 'RECIPE06',
    scenario: 'Withdraw source after human confirmation',
    requiredResult: 'Independent native support survives.',
  },
  {
    id: 'RECIPE07',
    scenario: 'Publish an own Recipe Structure without notes',
    requiredResult: 'Remain private until admitted publication; anonymous readers see only the exact approved Structure, while drafts, notes, targets and media stay private through edit, withdrawal and recovery.',
  },
]);
