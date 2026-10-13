import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/withdraw-a-realm-attachment', {
  visitor: proved('authentication is required on both withdrawal paths'),
  stranger: proved('neither withdrawal path admits an unrelated Person'),
  member: proved('ordinary membership admits neither withdrawal path'),
  owner: proved(
    'Realm-only and Zone-only owners each end the attachment immediately and independently',
  ),
  moderator: proved(
    'moderation alone refuses; delegated Realm stewardship withdraws without Zone authority',
  ),
  operator: proved(
    'bare platform authority refuses; exact Zone and Realm mandates independently withdraw',
  ),
});
