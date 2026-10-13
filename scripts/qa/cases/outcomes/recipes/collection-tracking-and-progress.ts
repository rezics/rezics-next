import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/collection-tracking-and-progress', {
  visitor: proved('browses the public recipe collection with empty personal state and authenticated writes'),
  stranger: proved('keeps whole-recipe standing and collection state private to their own Person'),
  member: proved('keeps whole-recipe standing and collection state private despite Realm membership'),
  owner: proved('curates repeated recipe members and retains private standing with replay and stale protection'),
  moderator: proved('keeps private standing without acquiring peer collection or reader authority'),
  operator: proved('keeps private standing under their own Person without inheriting an affected Person grant'),
});
