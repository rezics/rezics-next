import type { Pool } from 'pg';
import type { NativeScopeReader } from '../../semantic/adapters/index.ts';
import type { ScopeWork } from '../../search/adapters/index.ts';
import type { RealmSearchPorts, RealmSubjectIdentityMapping } from '../contract/index.ts';
import { type ContentBoardDependencies } from '../boards.ts';
import type { ThreadView } from '../reads.ts';
import { type CommunityComments } from '../community-projection/index.ts';
import { type RealmSubjectSource } from '../realm-subject-source.ts';
import { type NativeRealmDisclosurePorts, type RealmSubjectDisclosureContext, type RealmSubjectDisclosureDependencies } from './realm-disclosure.ts';
type SearchPorts = RealmSearchPorts<Pool, NativeScopeReader, ScopeWork, RealmSubjectDisclosureDependencies, RealmSubjectDisclosureContext, RealmSubjectSource>;
export type NativeRealmProducers = Pick<NativeRealmDisclosurePorts, 'parent' | 'subject'> & {
    readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<readonly RealmSubjectIdentityMapping[]>;
    withWork<T>(reader: Extract<NativeScopeReader, {
        actor: unknown;
    }>, work: ScopeWork, maximum: Parameters<SearchPorts['withWork']>[2], run: (context: RealmSubjectDisclosureContext) => Promise<T>): Promise<T>;
};
/** Content's Realm boundary preserves Semantic's identity meaning in a serializable worker contract. */
export declare function readRealmSubjectIdentityMappings(pool: Pool, originals: readonly string[]): Promise<readonly RealmSubjectIdentityMapping[]>;
/** Composition supplies foreign producers; this adapter selects only Content-native plans. */
export declare function createNativeContentRealmApplication(producers: NativeRealmProducers, now: () => number): Readonly<{
    disclosure: {
        prepare: (dependencies: Readonly<{
            pool: Pool;
            access: import("../../request/access.ts").Access;
        }>, input: Readonly<{
            realmId: string;
            candidates: readonly import("../realm-subject-disclosure.ts").RealmSubjectCandidate[];
        }>, supplied: Readonly<{
            actor: import("../reads.ts").Actor;
            deadline: number;
            work: import("../../access/work.ts").AccessWorkAccounting;
        }>) => Promise<Readonly<{
            finish(): Promise<readonly import("../contract/realm.ts").RealmSubjectEvidence<Readonly<{
                partition: import("../../partition/partition.ts").Partition;
                epoch: number;
                position: bigint;
            }>>[]>;
        }>>;
        parent: (dependencies: Readonly<{
            pool: Pool;
            access: import("../../request/access.ts").Access;
        }>, realm: string, context: Readonly<{
            actor: import("../reads.ts").Actor;
            deadline: number;
            work: import("../../access/work.ts").AccessWorkAccounting;
        }>) => Promise<Readonly<{
            signature: string;
            anchors: readonly Readonly<{
                partition: import("../../partition/partition.ts").Partition;
                epoch: number;
                position: bigint;
            }>[];
        }> | null>;
        subject: (dependencies: Readonly<{
            pool: Pool;
            access: import("../../request/access.ts").Access;
        }>, subject: string, context: Readonly<{
            actor: import("../reads.ts").Actor;
            deadline: number;
            work: import("../../access/work.ts").AccessWorkAccounting;
        }>) => Promise<Readonly<{
            signature: string;
            anchors: readonly Readonly<{
                partition: import("../../partition/partition.ts").Partition;
                epoch: number;
                position: bigint;
            }>[];
        }> | null>;
        same: (before: Readonly<{
            signature: string;
            anchors: readonly Readonly<{
                partition: import("../../partition/partition.ts").Partition;
                epoch: number;
                position: bigint;
            }>[];
        }>, after: Readonly<{
            signature: string;
            anchors: readonly Readonly<{
                partition: import("../../partition/partition.ts").Partition;
                epoch: number;
                position: bigint;
            }>[];
        }>) => boolean;
    };
    search: {
        source: (input: {
            pool: Pool;
            reader: NativeScopeReader;
        }) => RealmSubjectSource | undefined;
    };
    community: {
        observe: (deps: ContentBoardDependencies, boards: readonly Readonly<{
            id: string;
            realmId: string | null;
            securityRevision: string;
            availability: string;
        }>[], context: Readonly<{
            actor: import("../reads.ts").Actor;
            deadline: number;
        }>) => Promise<{
            recent: Map<string, Readonly<{
                state: 'current';
                complete: boolean;
                threads: readonly Readonly<{
                    thread: ThreadView;
                    target: Readonly<{
                        kind: 'thread';
                        id: string;
                        boardId: string;
                    }>;
                    comments: {
                        state: 'unavailable';
                    } | CommunityComments;
                }>[];
            }>>;
            current(): Promise<boolean>;
        }>;
    };
}>;
export type NativeContentRealmApplication = ReturnType<typeof createNativeContentRealmApplication>;
export {};
