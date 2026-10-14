import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-threads-and-replies',
  {
    visitor: proved('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    stranger: proved('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    member: proved('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    owner: proved('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    moderator: proved('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    operator: proved('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm names and original Work text by the fixture owner Person; reply text retains the member Person as author. Roster listing is subject-controlled consent.',
    },
  },
);
