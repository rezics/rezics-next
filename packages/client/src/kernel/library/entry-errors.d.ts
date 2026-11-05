export declare class LibraryConflictError extends Error {
    constructor();
}
export declare class SourceObservationCapacityError extends LibraryConflictError {
    constructor();
}
export declare class EntryAnnotationReviewStoppedError extends Error {
    readonly reason: 'cancelled' | 'expired';
    constructor(reason: 'cancelled' | 'expired');
}
