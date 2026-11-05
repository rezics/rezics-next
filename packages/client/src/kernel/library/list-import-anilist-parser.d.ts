/** Upload dialect v1, based on the retained AniList GraphQL reference, not an official export format. */
export type JsonObject = Record<string, unknown>;
export declare const ANILIST_LIMITS: {
    readonly bytes: 1048576;
    readonly rows: 200;
    readonly page: 20;
    readonly uploads: 5;
    readonly depth: 24;
};
export declare function object(value: unknown): value is JsonObject;
export declare class AniListInputError extends Error {
    constructor();
}
export type AniListRow = {
    evidence: JsonObject;
    group: JsonObject | null;
    identifiers: {
        source: 'anilist' | 'myanimelist';
        externalId: string;
    }[];
    fields: {
        field: string;
        validity: 'valid' | 'unknown' | 'invalid';
        reason: string;
    }[];
    scoreLexeme?: string;
};
export declare function parseAniList(upload: string, scoreFormat?: string): {
    document: unknown;
    scoreFormat: string | null;
    rows: AniListRow[];
};
