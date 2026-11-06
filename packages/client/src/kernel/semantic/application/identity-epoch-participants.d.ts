import type { IdentityEpochParticipantPorts } from '../contract/identity-epoch-ports.ts';
/** Install the fixed participant set once. Only the two named ports are kept; there is no default, extra key or
 * caller-selected list, and the installed object is frozen.
 */
export declare function createIdentityEpochParticipants<Native>(ports: IdentityEpochParticipantPorts<Native>): IdentityEpochParticipantPorts<Native>;
