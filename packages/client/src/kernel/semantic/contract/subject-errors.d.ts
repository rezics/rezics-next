/** Subject command/read failures shared without loading editorial command implementations. */
export declare class SubjectNotFoundError extends Error {
}
export declare class EditorialConflictError extends Error {
}
export declare class SubjectRedirectError extends Error {
    readonly from: string;
    readonly to: string;
    constructor(from: string, to: string);
}
