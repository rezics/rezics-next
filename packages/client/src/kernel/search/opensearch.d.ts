export type SearchQuery = Record<string, string | number | boolean>;
/** Internal physical byte reservation and absolute caller deadline. The meter returns no verdict. */
export type SearchRequestWork = Readonly<{
    bytes: number;
    deadline: number;
    settle(bytes: number): void;
}>;
export type SearchRequestOptions = {
    query?: SearchQuery;
    timeoutMs?: number;
    work?: SearchRequestWork;
};
export type OpenSearch = {
    request<T = unknown>(method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD', path: string, body?: unknown, options?: SearchRequestOptions): Promise<{
        status: number;
        body: T;
    }>;
    bulk<T = unknown>(lines: readonly unknown[], options?: {
        query?: SearchQuery;
        timeoutMs?: number;
    }): Promise<T>;
    /** Exact native bigint NDJSON; optional only for historical Subject-only test transports. */
    bulkRaw?<T = unknown>(body: string, options?: {
        query?: SearchQuery;
        timeoutMs?: number;
    }): Promise<T>;
};
export declare class OpenSearchError extends Error {
    status: number;
    type: string | null;
    reason: string | null;
    body: unknown;
    constructor(status: number, body: unknown);
}
export declare class SearchUnavailableError extends Error {
    constructor(message?: string, options?: ErrorOptions);
}
export declare function createOpenSearch(url: string, options?: {
    timeoutMs?: number;
    /** Internal tests may only lower the hard ceiling. */ maxResponseBytes?: number;
}): OpenSearch;
