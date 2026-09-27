import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/ratings-and-event-time.md', [
  {
    id: 'RATE01',
    scenario: 'A rates 2,2,8 and B rates 6',
    requiredResult: 'Latest-per-rater 7; mean-per-rater 5; pooled 4.5 labeled separately.',
  },
  {
    id: 'RATE02',
    scenario: 'Correct standing/daily/experience observation',
    requiredResult: 'Same observation revision; intentional new slot creates new identity.',
  },
  {
    id: 'RATE03',
    scenario: 'Daily vote around DST with persona switch',
    requiredResult: 'Server calendar and private uniqueness hold.',
  },
  {
    id: 'RATE04',
    scenario: 'Withdraw latest opinion',
    requiredResult: 'Older public opinion is not resurrected.',
  },
  {
    id: 'RATE05',
    scenario: 'Change question versus aggregation default',
    requiredResult: 'New context for meaning; policy revision for reduction only.',
  },
  {
    id: 'RATE06',
    scenario: 'Compare Realm and Global scores',
    requiredResult: 'Distinct populations/scales and explicit synthesis policy.',
  },
  {
    id: 'RATE07',
    scenario: 'Month-only event queried by day',
    requiredResult: 'Possible versus definite match preserved.',
  },
  {
    id: 'RATE08',
    scenario: 'Named concepts point to same event',
    requiredResult: 'Deduplicated event/date authority, distinct topic identities.',
  },
  {
    id: 'RATE09',
    scenario: 'Change date/source during histogram rebuild',
    requiredResult: 'Fenced generation and explicit cursor restart.',
  },
]);
