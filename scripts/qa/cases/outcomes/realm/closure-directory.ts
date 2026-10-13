import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/closure-directory',
  {
    visitor: pending('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    stranger: pending('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    member: pending('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    owner: pending('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    moderator: pending('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
    operator: pending('omits a closed Realm from every directory sort, filtered traversal and declared successor while retaining live rows'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic Realm names by each fixture owner Person.',
    },
  },
);
