import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/boards', {
  visitor: proved('browses bounded and empty Concept boards, conceals retired boards and requires sign-in for placement changes'),
  stranger: proved('browses Concept boards and cannot change placements without Realm authority'),
  member: proved('classifies their own conversation without changing another author’s placement'),
  owner: proved('manages Realm board placements and reads bounded, empty and retired boards'),
  moderator: proved('manages placements within Realm jurisdiction and can name a Concept scope'),
  operator: proved('needs explicit board authority and can name a Concept scope in role impact'),
});
