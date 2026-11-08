import type { Pool } from 'pg';
import type { Access, Actor, AccessClient } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import { snapshot } from '../reads.ts';
import type { AnchoredPosition } from '../model.ts';
import type { RealmDisclosurePorts, RealmObservation } from '../contract/index.ts';
export type RealmSubjectDisclosureDependencies = Readonly<{
    pool: Pool;
    access: Access;
}>;
export type RealmSubjectDisclosureContext = Readonly<{
    actor: Actor;
    deadline: number;
    work: AccessWorkAccounting;
}>;
export type RealmSubjectParentObservation = RealmObservation<AnchoredPosition>;
declare const hash: (value: unknown) => string;
declare function nativePoint<I extends Record<string, unknown>, R extends Record<string, unknown>>(client: AccessClient, operation: string, statement: {
    sql: string;
    params: readonly string[];
    '~reylo': {
        input: I;
        element: R;
    };
}, input: I, keys?: number): Promise<R | null>;
export declare const nativeRealmEvidenceHost: {
    hash: typeof hash;
    snapshot: typeof snapshot;
    point: typeof nativePoint;
    time(client: AccessClient): Promise<string>;
};
export type NativeRealmDisclosurePorts = RealmDisclosurePorts<RealmSubjectDisclosureDependencies, RealmSubjectDisclosureContext, AnchoredPosition>;
export declare function createNativeRealmDisclosurePorts(evidence: Pick<NativeRealmDisclosurePorts, 'parent' | 'subject'>, now: () => number): NativeRealmDisclosurePorts;
export declare function realmSearchFailure(error: unknown): 'unavailable' | 'concealed' | undefined;
export {};
