import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-threads-and-replies',
  {
    visitor: pending('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    stranger: pending('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    member: pending('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    owner: pending('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    moderator: pending('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
    operator: pending('conceals closed placed threads, descendants, canonical lookup, placement and counts'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm names and original Work text by the fixture owner Person; reply text retains the member Person as author. Roster listing is subject-controlled consent.',
    },
  },
);
