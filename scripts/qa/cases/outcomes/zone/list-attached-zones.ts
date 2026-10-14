import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/list-attached-zones', {
  visitor: proved(
    'receives the same concealed answer for missing, one-attachment and fifty-attachment Realms',
  ),
  stranger: proved(
    'receives the same concealed answer for missing, one-attachment and fifty-attachment Realms',
  ),
  member: proved('membership and Zone-only ownership reveal no attachment inventory'),
  owner: proved('traverses every attachment with withdrawal coordinates and honest continuation'),
  moderator: proved(
    'moderation alone conceals inventory; delegated stewardship lists until revoked',
  ),
  operator: proved(
    'exact live Realm mandate traverses the attachment inventory with withdrawal coordinates',
  ),
});
