import type { Source } from '@rezics/definitions/bulk';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CommandEvent, type CommandTransaction } from '../command/command.ts';
import { type Access } from '../request/access.ts';
export type SubjectKey = {
    route: number;
    id: string;
};
export type ComponentKind = 'label' | 'fact' | 'cover' | 'relation';
export type ComponentKey = {
    kind: ComponentKind;
    key: string;
};
export type Witness = {
    kind: 'fact' | 'cover' | 'relation';
    key: string;
};
export type PublicState = {
    shown: boolean;
    digest: string | null;
};
export type OwnerKey = {
    kind: 'subject' | 'source-fence';
    route: number;
    key: string;
};
export type ComponentTransition = {
    component: ComponentKey;
    before: PublicState;
    after: PublicState;
    dependencies: OwnerKey[];
};
export type EvidenceTime = {
    effectiveAt: string | null;
    evidence: 'known' | 'missing';
};
export type RepairPhase = 'bootstrap' | 'descriptive' | 'relations' | 'evidence' | 'replay' | 'done';
export type RepairCheckpoint = {
    version: string;
    generation: string;
    phase: RepairPhase;
    sourceKey: string[];
    highWater: string;
    replayPosition: string;
};
export type PublicationSnapshot = {
    generation: string;
    readiness: 'cold' | 'repairing' | 'ready';
    publicEffectiveAt: string | null;
    evidence: 'known' | 'missing';
    completedPosition: string;
    witnesses: Witness[];
};
export type PublicationEntry = {
    id: string;
    labels: {
        language: string;
        value: string;
    }[];
    lastModified?: string;
    originalLanguage?: string;
};
export type PublicationStore = {
    read(subject: SubjectKey): Promise<PublicationSnapshot | null>;
    readCurrent(subject: SubjectKey): Promise<PublicationEntry | null>;
};
type Configuration = {
    pool: Pool;
    access: Access;
    clock: KernelClock;
    routeKey: Uint8Array;
};
export declare function publicState(value: unknown): PublicState;
/** Native creation proves an empty baseline without inventing a public time. */
export declare function initializeSubjectPagePublication(tx: CommandTransaction, subject: SubjectKey): Promise<void>;
/** Persist only actual affected identities; this never discovers a subject's degree. */
export declare function recordSubjectPageTransition(tx: CommandTransaction, input: {
    subject: SubjectKey;
    changeId: string;
    components: ComponentTransition[];
    outbox: CommandEvent[];
    invalidateGate?: boolean;
}): Promise<void>;
export declare function enqueueSubjectPageRepair(tx: CommandTransaction, input: {
    subject: SubjectKey;
    cause: 'explicit' | 'missing-proof' | 'owner' | 'continuation';
    delivery?: {
        owner: OwnerKey;
        changeId: string;
        eventId: string;
        time: EvidenceTime;
    };
}): Promise<void>;
export declare function commitSubjectPageRepairPage(tx: CommandTransaction, input: {
    subject: SubjectKey;
    expectedVersion: string;
    checkpoint: RepairCheckpoint;
    components: (ComponentTransition & EvidenceTime)[];
    outbox: CommandEvent[];
    replayedChangeIds: string[];
    complete: boolean;
}): Promise<boolean>;
export declare function applySubjectPageOwnerChange(tx: CommandTransaction, input: {
    owner: OwnerKey;
    changeId: string;
    time: EvidenceTime;
}): Promise<void>;
export declare function applySubjectPageDependencyDelta(tx: CommandTransaction, input: {
    owner: OwnerKey;
    subject: SubjectKey;
    component: ComponentKey;
    sourceVersion: string;
    eventId: string;
    present: boolean;
    time: EvidenceTime;
    outbox: CommandEvent[];
}): Promise<void>;
export declare function commitSubjectPageFanoutPage(tx: CommandTransaction, input: {
    owner: OwnerKey;
    changeId: string;
    expectedVersion: string;
    after: string[];
    subjects: SubjectKey[];
    outbox: CommandEvent[];
    complete: boolean;
}): Promise<boolean>;
export declare function commitSubjectPageBootstrapPage(tx: CommandTransaction, input: {
    partition: number;
    expectedVersion: string;
    after: [number, string] | null;
    subjects: SubjectKey[];
    complete: boolean;
}): Promise<boolean>;
export type PublicationWork = {
    kind: 'subject';
    subject: SubjectKey;
    checkpoint: RepairCheckpoint;
} | {
    kind: 'bootstrap';
    partition: number;
    version: string;
    after: [number, string] | null;
} | {
    kind: 'fanout';
    owner: OwnerKey;
    changeId: string;
    version: string;
    after: string[];
    time: EvidenceTime;
};
export declare function claimSubjectPagePublicationWork(tx: CommandTransaction, input: {
    partition: number;
    worker: string;
    leaseUntil: string;
}): Promise<PublicationWork | null>;
export declare function readSubjectPageReplayWindow(client: CommandTransaction, input: {
    subject: SubjectKey;
    after: string;
    limit: number;
    sentinel: boolean;
}): Promise<{
    changes: {
        position: string;
        changeId: string;
        component: {
            kind: ComponentKind;
            key: string;
        } | null;
        before: PublicState;
        after: PublicState;
        time: EvidenceTime;
    }[];
    hasMore: boolean;
}>;
export declare function readSubjectPageFanoutWindow(client: CommandTransaction, input: {
    owner: OwnerKey;
    after: string[];
    limit: number;
    sentinel: boolean;
}): Promise<{
    edges: {
        sourceKey: string[];
        subject: {
            route: number;
            id: string;
        };
        component: {
            kind: ComponentKind;
            key: string;
        };
    }[];
    hasMore: boolean;
}>;
export declare function createSubjectPagePublicationStore({ pool, access, clock, routeKey }: Configuration): PublicationStore;
/** Retain the canonical source-fence owner when imported identity is first installed. */
export declare function retainSubjectPageSource(tx: CommandTransaction, input: {
    subject: SubjectKey;
    candidates: string[];
    source: Source;
    routeKey: Uint8Array;
}): Promise<void>;
export declare function readSubjectPageSourceOwner(tx: CommandTransaction, subject: SubjectKey, candidate: string): Promise<OwnerKey | null>;
export type PublicationOrigin = {
    changeId: string;
    time: EvidenceTime;
};
export declare function retainSubjectPageContinuation(tx: CommandTransaction, input: {
    subject: SubjectKey;
    kind: string;
    changeId: string;
}): Promise<void>;
export declare function readSubjectPageContinuation(client: CommandTransaction, input: {
    subject: SubjectKey;
    kind: string;
}): Promise<PublicationOrigin | null>;
/** Fixed partition metadata is separate from application source/dependency windows. */
export declare function subjectPagePublicationHomes(pool: Pool): Promise<number[]>;
export declare function readSubjectPageGenerationWitnesses(tx: CommandTransaction, subject: SubjectKey, generation: string): Promise<Witness[]>;
export declare function readSubjectPageOwnerTime(tx: CommandTransaction, owner: OwnerKey): Promise<EvidenceTime>;
export declare function readSubjectPageDeliveryTime(tx: CommandTransaction, subject: SubjectKey): Promise<EvidenceTime>;
export {};
