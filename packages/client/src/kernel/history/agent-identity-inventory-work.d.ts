import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { HistoryReceivingContext } from './receiving.ts';
import type { IdentitySourceConsumerMaintenanceContext } from '../semantic/identity-source-consumer-maintenance.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
export declare function unpricedIdentityHistoryWork(term: string, amount: NativeStepWork): NativeStepWork;
/** Accounts SQL does not enumerate Library candidates, run Semantic's identity
 * metadata sweeps, or expand Library witnesses. Those three axes are proven zero
 * for these local bodies. Empty index seeks are declared separately at each site;
 * neither a five-field bound nor result.rowCount proves that axis. */
export declare function accountHistoryWork(rows: number, points: number, statements: number, bytes: number, emptySeeks: number): NativeStepWork;
/** This returns a price, never authority. Copied/foreign five-field amounts have
 * no declaration, even when all their visible numbers happen to match. */
export declare function accountHistoryWorkDeclaration(amount: NativeStepWork): WorkDimensions | undefined;
export declare class IdentityHistoryWorkUnavailable extends Error {
    constructor();
}
export declare const nativeWork: (rows: number, points: number, statements: number, bytes: number) => NativeStepWork;
/** Existing Source balance only. Failure and rollback never refund a reservation.
 * Outside that frame the installed History/Work owner remains responsible for its own
 * allocation. An explicit Source token or an active Source frame may never silently skip. */
export declare function reserveIdentityHistoryWork(pool: Pool, amount: NativeStepWork, invocation?: Pick<HistoryReceivingContext, 'deadline' | 'identityConsumerWork'> | IdentitySourceConsumerMaintenanceContext): Promise<void>;
export declare const IDENTITY_HISTORY_COMMAND_CONTROL: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare const IDENTITY_HISTORY_COMMAND_LIFETIME_UNAVAILABLE = "identity-history-native-command-dispatch-lifetime-unavailable";
/** Literal local call bodies. A range seek is ONE empty seek even when its LIMIT+1
 * result bound is 65. Joined point relations each contribute a seek. Controls and
 * scalar native returns have no index seek. These are prices, never grants. */
export declare const IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK: Readonly<{
    command: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    snapshot: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    physicalInspection: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    mapping: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    receivingBinding: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    readiness: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    sdkReceiving: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeWorkRead: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeWrite: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativePairWrite: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeAuthoritySeal: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeLocatorWrite: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeGuardProbe: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    durableReceiving: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    releasedDurableReceiving: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    receivingInsert: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    roleScope: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    selectedJob: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    selectedBarrier: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    selectedProgress: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    sdkWriterObservation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    sdkFenceObservation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    sdkWriterLock: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeInventory: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    recoveryInventory: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    recoveryAssociation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    recoveryReceiving: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    seal: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeGuardLocal: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    nativeAbsence: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    recordedAuthority: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    previousReadiness: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    durableReadiness: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    sourceMappingSnapshot: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    retirementSnapshot: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    inventoryReceivingCopy: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    sdkObligation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    familyTouch: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    workInvalidation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    workWake: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    locatorInvalidation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    receivingInvalidation: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
}>;
/** The Accounts subdeclaration is deliberately separate from Semantic's complete
 * original declaration. Its missing operands cannot be added as zero or as null
 * totals. Per-call terms below compose cumulatively in the ONE original ledger. */
export declare const IDENTITY_HISTORY_ACCOUNTS_DECLARATION: Readonly<{
    version: 1;
    interface: "withPrepaidAgentIdentityHistoryUnit";
    sourceReceiver: "withPrepaidIdentitySourceConsumerMaintenance";
    axes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "nativePoints", "witnessKeys", "statements", "bytes", "emptySeeks"];
    engineRequests: 0;
    selectedCommand: Readonly<{
        profile: 'single-no-effect';
        effect: Readonly<{
            work: WorkDimensions;
            engineRequests: 0;
        }>;
        cleanup: Readonly<{
            work: WorkDimensions;
            engineRequests: 0;
        }>;
        total: Readonly<{
            work: WorkDimensions;
            engineRequests: 0;
        }>;
        components: Readonly<{
            checkout: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            begin: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            lockTimeout: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            statementTimeout: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            time: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            finalStatementTimeout: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            noEffectFence: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            finalize: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            commit: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
            cleanupRollback: Readonly<{
                work: WorkDimensions;
                engineRequests: 0;
            }>;
        }>;
    }>;
    selectedCommandCalls: Readonly<{
        retirement: 8;
        physicalMinimization: 3;
        physicalFenceReceiving: 4;
        selectedContinuation: 1;
    }>;
    local: Readonly<{
        [k: string]: WorkDimensions;
    }>;
    sdk: Readonly<{
        [k: string]: WorkDimensions;
    }>;
    multiplicities: Readonly<{
        mapping: "one initial lookup; every receiving binding repeats its own mapping";
        receivingBinding: "one initial; one per retirement receiver; two per released fence observation";
        readiness: "one per registered identity owner readiness call";
        nativeInventory: "one initial and one per final current-cut recheck; at most three copies, 64 roles each plus sentinel";
        recoveryInventory: "one per initial/repeated recovery cut; exactly two copies, 64 roles each plus sentinel";
        sdkWriterObservation: "two retirement observations; one before physical deletion";
        sdkRetire: "at most one single attempt; rollback+begin+settings+lock+retire+commit";
        sdkDelete: "at most one single attempt; rollback+begin+settings+lock+four deletes+commit";
        physical: "two inspections; eight LIMIT+1 probes per inspection; limits 1,1,1,64,8,64,0,0";
        commands: "one selectedCommand.total per reached selected noEffect command, atomically including disjoint cleanup before checkout; independent commands use local.command instead";
        progress: "one held selected job/barrier and cursor update, followed by original producer progress control";
    }>;
    missingTerms: readonly string[];
}>;
/** Preserve the executor's exact transaction object and its private resource
 * association. Only its query closure changes; no cast creates native authority.
 * Rollback is cleanup from the already prepaid, separate control slot. */
export declare function guardIdentityHistoryTransaction(pool: Pool, context: HistoryReceivingContext, tx: CommandTransaction): Promise<() => void>;
/** Released read checkout. A query-only facade has no CommandTransaction resources;
 * it cannot be used to make a foreign read into a same-home native command. */
export declare function identityHistoryConnection<T>(pool: Pool, context: HistoryReceivingContext, body: (tx: Pick<PoolClient, 'query'>) => Promise<T>): Promise<T>;
/** One native attempt. Source and SDK locks belong to the real command transaction.
 * Domain writes here are internal History control state, never a public command receipt. */
export declare function identityHistoryCommand<T>(pool: Pool, context: HistoryReceivingContext, body: (tx: CommandTransaction) => Promise<T>, partition?: number): Promise<T>;
export declare const HISTORY_FAMILY_TOUCH: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare const HISTORY_WORK_INVALIDATION: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare const HISTORY_WORK_WAKE: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare const HISTORY_LOCATOR_INVALIDATION: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare const HISTORY_RECEIVING_INVALIDATION: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare function addNativeWork(...parts: readonly NativeStepWork[]): NativeStepWork;
