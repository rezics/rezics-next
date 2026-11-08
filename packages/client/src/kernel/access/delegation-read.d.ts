import { type KernelClock } from '../clock.ts';
import type { AccessClient } from '../request/access.ts';
import { type AccessWorkAccounting } from './work.ts';
export type AssignmentEvidence = {
    kind: 'none';
} | {
    kind: 'unresolved';
} | {
    kind: 'resolved';
    principalId: string;
    assignedActorId: string;
    requestId: string;
    valid: string;
};
/** Separately anchored point read for trusted Auth issuance and other Access
 * consumers. A present but unresolvable principal never becomes absence.
 */
export declare function readAssignment(client: AccessClient, requestedBy: string | null, assignedActorId: string, clock?: KernelClock, work?: AccessWorkAccounting): Promise<AssignmentEvidence>;
