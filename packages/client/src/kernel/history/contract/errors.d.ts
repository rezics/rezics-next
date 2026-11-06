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
