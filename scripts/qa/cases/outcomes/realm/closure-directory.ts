import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-directory',
  {
    visitor: proved('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    stranger: proved('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    member: proved('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    owner: proved('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    moderator: proved('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    operator: proved('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm names by each fixture owner Person.',
    },
  },
);
