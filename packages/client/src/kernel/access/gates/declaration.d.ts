export type Exposure = {
    kind: 'public';
} | {
    kind: 'gate';
    group: string;
};
/** Parse trusted route metadata once, when the production kernel is composed. */
export declare function parseExposure(detail: unknown): Exposure;
