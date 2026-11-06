import type { IdentityEpochParticipantPorts } from '../contract/identity-epoch-ports.ts';

/** Install the fixed participant set once. Only the two named ports are kept; there is no default, extra key or
 * caller-selected list, and the installed object is frozen.
 */
export function createIdentityEpochParticipants<Native>(
  ports: IdentityEpochParticipantPorts<Native>,
): IdentityEpochParticipantPorts<Native> {
  return Object.freeze({
    version: 1 as const,
    'search-canonical-index': ports['search-canonical-index'],
    'library-private-follow-counts': ports['library-private-follow-counts'],
  });
}
