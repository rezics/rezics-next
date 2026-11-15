export { PROBLEM_TYPE_BASE, PROBLEMS, ProblemError, type ProblemCode, type FieldErrorCode, type FieldError, } from './problem-error.ts';
export { issuePointers } from '@rezics/definitions/validate';
export { problemSchema } from './problem-schema.ts';
/** Enter only after the command returned its committed outcome. A failed response
 * read retains its ordinary problem code without claiming the write rolled back.
 */
export declare function withAppliedCommandEffect<T>(read: () => Promise<T>): Promise<T>;
export declare function logInternalError(options: {
    requestId: string;
    method: string;
    route?: string | undefined;
    cause: unknown;
    commandIndex?: number | undefined;
    event?: 'internal_error' | 'dependency_unavailable';
}): void;
export declare function logDeadlineExceeded(context: {
    method: string;
    id: string;
    route?: string | undefined;
}): void;
export declare function problemResponse(error: unknown, context: {
    method: string;
    id: string;
    action?: string;
    route?: string | undefined;
}): Response;
