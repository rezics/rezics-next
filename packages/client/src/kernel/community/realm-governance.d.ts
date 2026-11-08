import { type CommandAuthorization } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import type { RealmContinuity } from './contract/index.ts';
export type { RealmContinuity } from './contract/index.ts';
export declare function RealmReadOnlyError(): {
    new (): {
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
        readonly code: import("../http/problem-error.ts").ProblemCode;
        readonly detail: string | undefined;
        readonly errors: readonly import("../http/problem-error.ts").FieldError[] | undefined;
        readonly headers: Record<string, string> | undefined;
        readonly extensions: Readonly<Record<string, unknown>> | undefined;
        readonly effectStatus: 'not_applicable' | 'not_applied' | undefined;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type RealmReadOnlyError = InstanceType<ReturnType<typeof RealmReadOnlyError>>;
export declare function realmContinuityView(row: {
    ownership_state: string;
    orphaned_at: string | null;
    claim_eligible_at: string | null;
}): RealmContinuity;
/** The transaction rechecks and locks the same native identity before receipt replay
 * or a new write. A concurrent succession cannot slip between this check and commit.
 * This guard consumes ordinary Access authorization; it grants no action itself.
 */
export declare function realmGovernanceAuthorization(authorization: CommandAuthorization, resource: Resource): CommandAuthorization;
