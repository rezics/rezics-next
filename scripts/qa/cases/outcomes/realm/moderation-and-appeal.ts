import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/moderation-and-appeal', {
  visitor: proved('admitted anonymous requests disclose no ban or appeal and cannot mutate the sanction'),
  stranger: proved('cannot impersonate another appellant; controls an appeal for their own unjoined sanctioned subject'),
  member: proved('opens one stable appeal, refuses changed intent, and reads a reversal without the decider identity'),
  owner: proved('uses explicit creation moderation and member-management grants to reverse; cannot impersonate the appellant'),
  moderator: proved('joined scoped moderator can dismiss but cannot restore without member management or act in another Realm'),
  operator: proved('platform mandate grants neither private member reads, appellant control nor Realm-local appeal decisions'),
});
