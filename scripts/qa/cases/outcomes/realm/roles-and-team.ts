import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/roles-and-team', {
  visitor: proved(
    'must authenticate before reading team identities or previewing and changing roles',
  ),
  stranger: proved('cannot read or mutate Realm roles and team without the exact grants'),
  member: proved(
    'membership permits private reads but does not authorize role or team administration',
  ),
  owner: proved(
    'enforces exact effective impact, holder privacy, replay, CAS, concurrent edits and role budget',
  ),
  moderator: proved('moderation remains available while role and team administration stays denied'),
  operator: proved(
    'platform authority neither administers Realm roles nor supplies subject representation',
  ),
});
