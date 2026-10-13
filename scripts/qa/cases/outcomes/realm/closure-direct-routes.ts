import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-direct-routes',
  {
    visitor: pending('conceals closed home, teaser, adoptions, decisions and Zone entry while live controls remain readable'),
    stranger: pending('conceals closed home, teaser, adoptions, decisions and Zone entry while live controls remain readable'),
    member: pending('conceals closed home, teaser, adoptions, decisions and Zone entry while live controls remain readable'),
    owner: pending('conceals closed home, teaser, adoptions, decisions and Zone entry while live controls remain readable'),
    moderator: pending('conceals closed home, teaser, adoptions, decisions and Zone entry while live controls remain readable'),
    operator: pending('conceals closed home, teaser, adoptions, decisions and Zone entry while live controls remain readable'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm and Zone names and independently published original Work text by the fixture owner Person; Realm adoption retains that authorship.',
    },
  },
);
