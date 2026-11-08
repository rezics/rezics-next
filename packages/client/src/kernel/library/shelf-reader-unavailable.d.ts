/** Missing native evidence is retryable; it must never become a ready empty shelf. */
export declare function ShelfReadUnavailableError(): {
    new (binding: string): {
        readonly binding: string;
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
export type ShelfReadUnavailableError = InstanceType<ReturnType<typeof ShelfReadUnavailableError>>;
