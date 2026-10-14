import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-roster',
  {
    visitor: proved('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    stranger: proved('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    member: proved('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    owner: proved('conceals closed public and management rosters, role holders and retained pagination like a real absent Realm'),
    moderator: proved('conceals closed roster, featured members and retained pagination like a real absent Realm'),
    operator: proved('conceals closed roster, featured members and retained pagination like a real absent Realm'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm names by each fixture owner Person; member and moderator names are subject-controlled identity data with their own listing consent.',
    },
  },
);
