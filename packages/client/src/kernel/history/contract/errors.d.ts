export declare class IdentityHistoryWorkUnavailable extends Error {
    constructor();
}
export declare class OperationalWorkUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
export declare class HistorySealedError extends Error {
    constructor();
}
/** The original JSON response is too large to retain as one native receipt. */
export declare class HistoryReceiptTooLargeError extends TypeError {
    constructor();
}
