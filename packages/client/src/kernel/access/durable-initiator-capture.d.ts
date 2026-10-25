import type { AccessContext, Actor } from '../request/access.ts';
import type { DurableInitiatorRecord } from './durable-initiator.ts';
export declare class DurableInitiatorCaptureUnavailableError extends Error {
    constructor();
}
/** Capture immutable creation fields after command admission, during prepare and
 * before target connection checkout or any write. Bind context with
 * commandAccessContext(context, attempt). The actor must be the exact admitted
 * account object. No account read is added: floor/operator reuse admission's
 * observation at this live attempt T. requestedBy adds one native assignment
 * unique-index seek at T, O(log A); missing, revoked or invalid evidence denies.
 * Only these allowlisted fields belong in the owning module's immutable record.
 * Unadmitted, refused, expired or mismatched contexts throw the typed error.
 */
export declare function captureDurableInitiator(context: AccessContext, actor: Actor): Promise<Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'>>;
/** Lowercase SHA-256 of RFC 8785 canonical JSON of the entire bounded immutable
 * DurableInitiatorRecord, O(record size). Use as the native creation receipt's
 * durableInitiator response; restoration uses this identical commitment.
 */
export declare function durableInitiatorCommitment(record: DurableInitiatorRecord): string;
