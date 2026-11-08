export declare class LibraryEntryInvalidError extends TypeError {
    constructor(message?: string);
}
export declare function LibraryEntryLifecycleConflictError(): {
    new (reason: 'stale' | 'occupied' | 'expired'): {
        readonly reason: 'stale' | 'occupied' | 'expired';
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type LibraryEntryLifecycleConflictError = InstanceType<ReturnType<typeof LibraryEntryLifecycleConflictError>>;
export declare function LibraryEntryStateRestoreConflictError(): {
    new (reason: 'stale' | 'unavailable' | 'unchanged'): {
        readonly reason: 'stale' | 'unavailable' | 'unchanged';
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type LibraryEntryStateRestoreConflictError = InstanceType<ReturnType<typeof LibraryEntryStateRestoreConflictError>>;
