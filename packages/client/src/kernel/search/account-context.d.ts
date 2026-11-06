/** Optional public presentation, never searchable text or evidence of Account eligibility. */
export type AccountBiography = {
    state: 'available';
    text: string;
    truncated: boolean;
} | {
    state: 'absent' | 'withheld' | 'unavailable';
};
export type AccountContext = {
    biography: AccountBiography;
    followTarget: {
        state: 'available';
        id: string;
        label: string;
        type: string;
        source: string;
    } | {
        state: 'unavailable';
    };
};
export declare const ACCOUNT_CONTEXT_LIMITS: Readonly<{
    biographyBytes: 1024;
    contextBytes: 8192;
    pageSize: 100;
}>;
/** The native read supplies at most 1025 code points, before any foreign hydration. */
export declare function accountBiography(value: string | null | undefined): AccountBiography;
