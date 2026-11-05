import { type AniListRow } from './list-import-anilist-parser.ts';
export declare const ANILIST_LABEL_LIMITS: {
    readonly rows: 20;
    readonly values: 32;
    readonly selected: 8;
    readonly newLabels: 4;
    readonly pageBytes: 8388608;
};
type State = 'missing' | 'unknown' | 'invalid' | 'empty' | 'available' | 'unsupported' | 'oversized';
export type AniListLabelValue = {
    key: string;
    value: string;
    origin: 'customLists' | 'customContainer';
    member: boolean;
};
/** Interpret only the retained, documented boolean map and explicitly custom group container. */
export declare function aniListLabelEvidence(row: AniListRow): {
    membership: State;
    grouping: string;
    values: AniListLabelValue[];
    selectable: AniListLabelValue[];
    tagEvidence: {
        entry: State;
        media: State;
        membership: 'unavailable';
    };
    tags: State;
    reason: string;
};
export {};
