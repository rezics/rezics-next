import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-feed',
  {
    visitor: pending('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    stranger: pending('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    member: pending('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    owner: pending('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    moderator: pending('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    operator: pending('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Original fixture title and text by the owner Person, with explicit native author credit. The Realm adoption is a separate selection of that independently published original; review authority is not authorship.',
    },
  },
);

