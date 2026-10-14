import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-feed',
  {
    visitor: proved('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    stranger: proved('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    member: proved('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    owner: proved('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    moderator: proved('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
    operator: proved('omits closed Realm feed occurrences and head counts while credited independent originals remain traversable'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Original fixture title and text by the owner Person, with explicit native author credit. The Realm adoption is a separate selection of that independently published original; review authority is not authorship.',
    },
  },
);

