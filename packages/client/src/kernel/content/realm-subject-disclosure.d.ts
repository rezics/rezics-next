import type { AnchoredPosition } from './model.ts';
import type { RealmObservation, RealmSubjectEvidence as Evidence, RealmPreparedDisclosure } from './contract/index.ts';
import { contentRealmApplication } from './adapters/realm-binding.ts';
import type { RealmSubjectDisclosureDependencies, RealmSubjectDisclosureContext } from './adapters/realm-disclosure.ts';
export type { RealmSubjectDisclosureDependencies, RealmSubjectDisclosureContext } from './adapters/realm-disclosure.ts';
export { REALM_SUBJECT_DISCLOSURE_BATCH, REALM_SUBJECT_DISCLOSURE_FRESH_MS } from './contract/index.ts';
export type { RealmSubjectCandidate, RealmSubjectDisclosureInput } from './contract/index.ts';
export type RealmSubjectEvidence = Evidence<AnchoredPosition>;
export type RealmSubjectDisclosure = RealmPreparedDisclosure<AnchoredPosition>;
export type RealmSubjectFreshness = Extract<RealmSubjectEvidence, {
    state: 'positive';
}>['freshness'];
export type RealmSubjectParentObservation = RealmObservation<AnchoredPosition>;
export declare function prepareRealmSubjectDisclosure(...args: Parameters<ReturnType<typeof contentRealmApplication>['disclosure']['prepare']>): Promise<Readonly<{
    finish(): Promise<readonly Evidence<Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>>[]>;
}>>;
export declare function observeRealmSubjectParent(dependencies: RealmSubjectDisclosureDependencies, realm: string, context: RealmSubjectDisclosureContext): Promise<Readonly<{
    signature: string;
    anchors: readonly Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}> | null>;
export declare function observeRealmSubjectSubject(dependencies: RealmSubjectDisclosureDependencies, subject: string, context: RealmSubjectDisclosureContext): Promise<Readonly<{
    signature: string;
    anchors: readonly Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}> | null>;
export declare function sameCurrentRealmSubjectParent(before: RealmSubjectParentObservation, after: RealmSubjectParentObservation): boolean;
