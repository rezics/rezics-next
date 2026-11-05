import type { Static } from 'typebox';
export declare const VNDB_LABEL_LIMITS: {
    readonly rows: 8;
    readonly mappings: 8;
    readonly items: 64;
    readonly page: 8;
    readonly selectionBytes: 16384;
    readonly sourceNameBytes: 1024;
    readonly applyMs: 5000;
};
export declare const vndbLabelDigest: (value: unknown) => string;
export declare const vndbLabelChoiceSchema: import("typebox").TObject<{
    rows: import("typebox").TArray<import("typebox").TObject<{
        ordinal: import("typebox").TInteger;
        reviewId: import("typebox").TString;
    }>>;
    mappings: import("typebox").TArray<import("typebox").TObject<{
        source: import("typebox").TString;
        target: import("typebox").TUnion<[import("typebox").TObject<{
            labelId: import("typebox").TString;
            revision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            name: import("typebox").TString;
        }>]>;
    }>>;
}>;
export type VndbLabelChoice = Static<typeof vndbLabelChoiceSchema>;
export type LabelIdentity = {
    id: string;
    revision: number;
};
export type VndbLabelMapping = VndbLabelChoice['mappings'][number] & {
    label: LabelIdentity | null;
    creator?: VndbLabelOperand;
    admission: 'ready' | 'unsupported' | 'refused';
    reason: 'state-label' | 'name-occupied' | 'label-unavailable' | null;
};
export type VndbLabelOperand = {
    ordinal: number;
    reviewId: string;
    sourceDigest: string;
    matchDigest?: string;
    subjectId: string | null;
    source: string | null;
    mapping: number;
    assignment: (LabelIdentity & {
        effective: boolean;
    }) | null;
};
export type VndbLabelStatus = 'ready' | 'applied' | 'already_present' | 'stale' | 'unsupported' | 'refused';
export type VndbLabelResult = {
    reason: string | null;
    retryable: boolean;
    label: LabelIdentity | null;
    assignment: LabelIdentity | null;
};
export type VndbLabelItem = {
    item_no: number;
    operand: VndbLabelOperand;
    status: VndbLabelStatus;
    result: VndbLabelResult | null;
};
export type VndbLabelPlan = {
    preview_id: string;
    state: 'reviewed' | 'applying' | 'cancelled';
    expires_at: Date;
    mappings: VndbLabelMapping[];
    item_count: number;
};
export declare const VNDB_STATE_LABELS: Set<string>;
