import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-roster',
  {
    visitor: pending('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    stranger: pending('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    member: pending('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    owner: pending('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    moderator: pending('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    operator: pending('conceals closed roster, featured members and retained pagination like a real absent Realm'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm names by each fixture owner Person; member and moderator names are subject-controlled identity data with their own listing consent.',
    },
  },
);
