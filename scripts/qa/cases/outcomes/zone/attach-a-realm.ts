import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/attach-a-realm', {
  visitor: proved("authentication is required to attach another Space's Realm"),
  stranger: proved("cannot edit another person's Zone to attach a Realm"),
  member: proved("ordinary Realm membership cannot attach another person's Zone"),
  // Reopened: once a second Zone attaches the Realm, the Realm's own Zone read answers 503 for these three.
  owner: pending(
    'Zone-only and Realm-only authority each refuse; both authorities attach across Spaces',
  ),
  moderator: pending('moderation alone refuses; delegated stewardship plus Zone ownership attaches'),
  operator: pending(
    'bare platform and Zone-only authority refuse; exact Zone and Realm mandates attach',
  ),
});
