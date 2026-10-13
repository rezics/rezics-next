import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/boards', {
  visitor: pending('needs a declared board collection and traversal operation'),
  stranger: pending('needs a declared board collection and disclosure operation'),
  member: pending('needs a declared authorized board navigation operation'),
  owner: pending('needs a declared board resource and management authority'),
  moderator: pending('needs a declared board resource and moderation jurisdiction'),
  operator: pending('needs a declared board resource and operational mandate'),
});
