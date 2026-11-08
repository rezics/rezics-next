import type { Item, ItemFact, ItemFactRow } from './item-values.ts';
export declare const RELATED_SUBJECT_BATCH_LIMIT = 256;
export declare const SUBJECT_CREATE_KIND = "subject.create";
export declare const GLOBAL_SUBJECT_CONTEXT = "00000000-0000-8000-8000-000000000000";
export type SubjectComponent = {
    partition: number;
    epoch: number;
    position: bigint;
};
export type CreateSubjectProjection = {
    subject: Item;
    component: SubjectComponent;
    replayed: boolean;
};
export type SubjectFactPlan = Readonly<{
    subjectId: string;
    type: string;
    facts: readonly ItemFact[];
    dataTypes: Readonly<Record<string, string>>;
    relationProperties: readonly string[];
}>;
export type ProjectedSubjectItem = Readonly<{
    item: Item;
    facts: readonly ItemFactRow[];
}>;
export type SubjectIdentityCapture = Readonly<{
    original: string;
    revision: number;
    transactionId: string;
    redirect: string | null;
}>;
