import { securityResponseLimits } from './security-response-bounds';

/** Fixed closed JSON projections: UTF-8 bytes, with six bytes per escaped UTF-16 unit.
 * UUIDs are ASCII, not arbitrary escaped strings. Native human proof IDs remain opaque.
 */
const uuid = '00000000-0000-0000-0000-000000000000';
const escaped = (units: number) => '\u0000'.repeat(units);
export const membershipResponseBytes = Object.freeze({
  roster: JSON.stringify({
    organizationId: uuid,
    viewer: { accountId: escaped(securityResponseLimits.id), role: 'member', leave: 'unavailable' },
    members: {
      state: 'ready',
      items: Array.from({ length: 20 }, () => ({
        accountId: uuid,
        account: { id: uuid, kind: 'organization', handle: escaped(256), displayName: escaped(256) },
        role: 'member',
        actions: { changeRole: 'unavailable', remove: 'unavailable' },
      })),
      next: escaped(4096),
    },
  }).length,
  selected: JSON.stringify({
    organizationId: uuid,
    memberAccountId: uuid,
    membership: { role: 'member', reservationId: uuid },
  }).length,
});
