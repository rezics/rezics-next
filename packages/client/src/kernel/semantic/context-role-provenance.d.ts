import { type CommandTransaction } from '../command/command.ts';
import { type ContextAccessPort, type ContextRoleOccurrenceInput } from './context-access-port.ts';
export type ContextRoleEnrollmentResult = Readonly<{
    state: 'enrolled';
    contextKey: string;
}> | Readonly<{
    state: 'pending';
}> | Readonly<{
    state: 'not-applicable';
}>;
/** Access must lock and validate its native occurrence before calling this Source port.
 * Enrollment shares the caller's command and its deferred native commit constraint.
 * It grants no permission and acknowledges no history receiving or account closure.
 */
export declare function enrollContextRoleProvenance(tx: CommandTransaction, input: Readonly<{
    route: number;
    occurrence: ContextRoleOccurrenceInput;
}>, accessPort?: ContextAccessPort): Promise<ContextRoleEnrollmentResult>;
