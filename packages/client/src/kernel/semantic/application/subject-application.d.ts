import type { Release } from '@rezics/definitions';
import type { ItemApplication } from './item-application.ts';
import type { SubjectFactStorePort } from '../contract/domain-ports.ts';
import type { Item, ItemFactRow } from '../contract/item-values.ts';
import { type SubjectFactPlan } from '../contract/subject-values.ts';
export type SubjectFactsInput = Readonly<{
    subjectId: string;
    item: unknown;
    type: string;
    release: Release;
    releaseDigest: string;
}>;
export type SubjectWriteFactsInput<Tx> = SubjectFactsInput & Readonly<{
    tx: Tx;
    route: number;
    transactionId: string;
}>;
export type SubjectApplication<Tx> = Readonly<{
    plan(input: SubjectFactsInput): SubjectFactPlan;
    project(plan: SubjectFactPlan, rows: readonly ItemFactRow[], metadata: {
        revision: number;
        release: string;
        context?: string;
        relationCounts?: Record<string, number>;
    }): Item;
    writePlannedFacts(input: SubjectWriteFactsInput<Tx>, plan: SubjectFactPlan): Promise<void>;
    initializeIdentity(tx: Tx, original: string): Promise<void>;
}>;
export declare function createSubjectApplication<Tx>(ports: {
    items: ItemApplication;
    facts: SubjectFactStorePort<Tx>;
}): SubjectApplication<Tx>;
