export declare const MAL_LIMITS: {
    readonly bytes: 2097152;
    readonly wireBytes: 4194304;
    readonly evidenceBytes: 12582912;
    readonly rows: 500;
    readonly page: 20;
    readonly depth: 16;
    readonly uploads: 3;
};
export type MalValue = {
    kind: 'missing' | 'unknown' | 'invalid' | 'zero' | 'value';
    raw?: string;
    value?: string | number;
    precision?: 'year' | 'month' | 'day';
};
export type MalRow = {
    index: number;
    kind: 'anime' | 'manga';
    title: string;
    identifier: {
        namespace: string;
        source: string;
        value: string;
    };
    status: MalValue;
    role: string | null;
    score: MalValue & {
        scale: {
            min: 1;
            max: 10;
            step: 1;
        };
    };
    progress: Record<string, MalValue>;
    dates: Record<string, MalValue>;
    notes: MalValue;
    tags: MalValue;
    repeats: MalValue;
    privacy: MalValue;
    timestamps: Record<string, MalValue>;
    fields: Record<string, string>;
    retained: {
        field: string;
        reason: string;
    }[];
};
export declare function malInvalid(reason: string, row?: number): never;
export declare function malDate(raw: string | undefined): MalValue;
/** Uploaded XML stays inert; raw evidence is stored privately, never interpolated in failures. */
export declare function parseMal(xml: string): MalRow[];
