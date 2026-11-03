import type { Pool } from 'pg';
import type { WorkClient } from '../work/client.ts';
import type { HistoryRegistry } from '../history/registry.ts';
import type { KernelClock } from '../clock.ts';
import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions, WorkAllowance } from '../library/collection-source.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import { type HistoryOriginalDependencies, type IdentityOriginalSourceContext } from '../access/identity-original-admission.ts';
import { type IdentitySourceLibraryOperation, type IdentitySourceScheduledOperation } from './identity-source-maintenance-config.ts';
declare const identitySourceConsumerMaintenance: unique symbol;
export type IdentitySourceConsumerMaintenanceWork = Readonly<{
    [identitySourceConsumerMaintenance]: true;
}>;
export type IdentitySourceConsumerMaintenanceContext = Readonly<{
    deadline: number;
    identityConsumerWork: IdentitySourceConsumerMaintenanceWork;
}>;
/** Server-only liveness check. The frame says nothing about Source or permission truth. */
export declare function isLiveIdentitySourceConsumerMaintenance(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, deadline?: number): boolean;
/** Charge a proved native operation before dispatch. Dispatched work is never refunded. */
export declare function reserveIdentitySourceConsumerNativeWork(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, amount: NativeStepWork, declaration?: WorkDimensions): boolean;
/** Planning snapshot of this invocation's existing native balance, never new funding. */
export declare function identitySourceConsumerNativeWork(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, deadline: number): NativeStepWork | null;
/** Return the frame's existing Library ledger after validating pool, invocation and lifetime. */
export declare function identitySourceConsumerLibraryWork(pool: Pool, work: IdentitySourceConsumerMaintenanceWork | undefined, deadline: number): NativeCollectionWork | null;
/** Bind the owner's one planned remainder to the existing live ledger for the
 * entire page/receiving/fence continuation. Nested work spends that same balance.
 */
export declare function withIdentitySourceConsumerLibraryRemainder<T>(pool: Pool, work: IdentitySourceConsumerMaintenanceWork, deadline: number, allowance: WorkAllowance, body: (budget: NativeCollectionWork) => Promise<T>): Promise<T | null>;
/** A durable scope fence must run inside the original page's cumulative plan. */
export declare function currentIdentitySourceConsumerLibraryRemainder(pool: Pool, deadline: number): NativeCollectionWork | null;
/** Current frame for a same-command Source verification whose public signature cannot change. */
export declare function currentIdentitySourceConsumerMaintenance(pool: Pool, deadline: number): IdentitySourceConsumerMaintenanceWork | null;
/** The current async invocation's original Source allocation and deadline for nested History work.
 * Presence is provenance only: callers must still validate the token against the actual Pool,
 * current async frame, and deadline before dispatch. A settled or foreign invocation remains
 * observable so it cannot be mistaken for a genuinely absent Source frame. */
export declare function activeIdentitySourceConsumerMaintenance(_pool: Pool): IdentitySourceConsumerMaintenanceContext | null;
export declare const IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE = "identity-history-original-source-transfer-unavailable";
export declare class IdentitySourceOriginalUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
/** Receive INSIDE withIdentityOriginalSourceTransfer. Accounts alone owns the durable
 * debit and settlement. This entry neither consumes nor enters that transfer again. */
export declare function withPrepaidIdentitySourceConsumerMaintenance<T>(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext, body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>;
/** Legacy selected-History entry has no private child context. It cannot admit one. */
export declare function withIdentitySourceHistoryOriginalMaintenance<T>(deps: HistoryOriginalDependencies, jobId: string, _body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>;
/** Source owns one configured frame for the entire actual default-maintenance callback. */
export declare function withIdentitySourceConsumerMaintenance<T>(deps: Readonly<{
    pool: Pool;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
    client?: WorkClient;
    registry?: HistoryRegistry;
    selectedHistoryJob?: string;
}>, context: Readonly<{
    deadline: number;
}>, body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>;
/** Presence is ancestry, never independent funding, including after the callback ends. */
export declare function isPrepaidIdentitySourceConsumerMaintenance(pool: Pool): boolean;
/** Irreversible private scheduling claim. Accounts has already committed
 * child_entered on this original before issuing the grant. That durable bit and
 * its spent original prevent a restart/new callback from minting this frame again;
 * this bit closes sequential/concurrent attempts INSIDE that one callback too.
 * No new durable Source ledger or caller identifier participates in the claim.
 */
export declare function claimIdentitySourceCustodyAdvancement(pool: Pool, work: IdentitySourceConsumerMaintenanceWork, deadline: number, barrier: Readonly<{
    accountId: string;
    accountRoute: number;
    version: number;
    at: string;
}>): boolean;
/** Immutable accounting observation, never a scheduling claim or grant. */
export declare function identitySourceConsumerScheduleReceipt(pool: Pool, work: IdentitySourceConsumerMaintenanceWork, deadline: number): Readonly<{
    claimed: boolean;
    calls: Readonly<Record<string, number>>;
}> | null;
export declare function claimIdentitySourceScheduledCall(pool: Pool, operation: IdentitySourceScheduledOperation): void;
export declare function claimIdentitySourceLibraryCall(pool: Pool, operation: IdentitySourceLibraryOperation): void;
/** Adapt the genuine private Source partition to Core's delivered single-no-effect
 * executor. Core reserves effect AND cleanup atomically before checkout. Body SQL
 * remains separately priced at its exact callsite. Never use the historical
 * aggregate control reservation for this same command.
 */
export declare function withIdentitySourceNoEffectCommand<T>(pool: Pool, deadline: number, body: () => Promise<T>): Promise<T>;
/** The delivered event profile is distinct from noEffect. The selected immutable
 * barrier account, validator and atomic Source debit all come from the SAME
 * Accounts grant. Library body SQL remains on its existing Library partition.
 */
export declare function withIdentitySourceFenceCommand<T>(pool: Pool, deadline: number, accountId: string, body: () => Promise<T>): Promise<T>;
/** Actual owner receiving disposition. There is deliberately no successful
 * IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION export while these reached bodies
 * lack compatible eight-axis declarations. Accounts treats absence as unavailable,
 * rather than accepting total:null or a local-only price as whole-child funding. */
export declare function readIdentitySourceOriginalCostDisposition(): Promise<Readonly<{
    state: 'missing';
    whole: Readonly<{
        state: 'missing';
        missing: readonly string[];
    }> | Readonly<{
        state: 'complete';
        work: WorkDimensions;
        engineRequests: 0;
    }>;
    accountsLocalControl: WorkDimensions;
    additionalOriginalTransferControl: WorkDimensions;
    local: Readonly<{
        sourceHistoryGuard: Readonly<{
            engineRequests: 0;
            work: Readonly<{
                candidateKeys: 0;
                nativeRows: 17;
                identityMetadataRows: 0;
                nativePoints: 15;
                witnessKeys: 0;
                statements: 2;
                bytes: number;
                emptySeeks: 1;
            }>;
        }>;
        scopeConsumerFootprint: typeof import("./identity-scoped-observations.ts").scopeConsumerFootprint;
        reads: Readonly<Readonly<Record<"accepted" | "progress" | "published" | "retained", Readonly<{
            engineRequests: 0;
            work: Readonly<{
                candidateKeys: 0;
                nativeRows: number;
                identityMetadataRows: 0;
                nativePoints: number;
                witnessKeys: 0;
                statements: number;
                bytes: number;
                emptySeeks: number;
            }>;
        }>>>>;
        mutations: Readonly<{
            custodyInsert: Readonly<{
                body: Readonly<{
                    engineRequests: 0;
                    work: Readonly<{
                        candidateKeys: 0;
                        nativeRows: number;
                        identityMetadataRows: 0;
                        nativePoints: number;
                        witnessKeys: 0;
                        statements: number;
                        bytes: number;
                        emptySeeks: number;
                    }>;
                }>;
                foreignKeys: readonly string[];
                children: readonly string[];
            }>;
            terminalAppend: Readonly<{
                body: Readonly<{
                    engineRequests: 0;
                    work: Readonly<{
                        candidateKeys: 0;
                        nativeRows: number;
                        identityMetadataRows: 0;
                        nativePoints: number;
                        witnessKeys: 0;
                        statements: number;
                        bytes: number;
                        emptySeeks: number;
                    }>;
                }>;
                foreignKeys: readonly string[];
                children: readonly string[];
            }>;
        }>;
        callsites: Readonly<{
            retainedDiscovery: Readonly<{
                controls: Readonly<{
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
                reads: Readonly<{
                    retained: 1;
                    progress: 1;
                }>;
                foreign: readonly never[];
            }>;
            acceptedBinding: Readonly<{
                controls: Readonly<{
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
                reads: Readonly<{
                    accepted: 1;
                }>;
                foreign: readonly never[];
            }>;
            published: Readonly<{
                controls: Readonly<{
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
                reads: Readonly<{
                    published: 1;
                }>;
                foreign: readonly string[];
            }>;
            terminalVerify: Readonly<{
                controls: Readonly<{
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
                reads: Readonly<{
                    retained: 1;
                    accepted: 1;
                    progress: 1;
                }>;
                foreign: readonly string[];
            }>;
            progress: Readonly<{
                controls: Readonly<{
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
                reads: Readonly<{
                    progress: 1;
                }>;
                foreign: readonly never[];
            }>;
            prepare: Readonly<{
                profile: "event-callback-source-association";
                reads: Readonly<{
                    accepted: 1;
                    retained: 1;
                }>;
                mutation: "custodyInsert";
                foreign: readonly string[];
            }>;
            checkpoint: Readonly<{
                profile: "event-callback-source-association";
                reads: Readonly<{
                    accepted: 1;
                    progress: 1;
                }>;
                mutation: "terminalAppend";
                foreign: readonly string[];
            }>;
            finish: Readonly<{
                profile: "event-callback-source-association";
                reads: Readonly<{
                    accepted: 1;
                    progress: 1;
                }>;
                mutation: "terminalAppend";
                foreign: readonly string[];
            }>;
        }>;
        command: Readonly<{
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
    }>;
    schedule: Readonly<{
        custodyAdvancements: 1;
        directoryPages: 1;
        source: Readonly<{
            retainedDiscovery: 1;
            original: 1;
            acceptedBinding: 1;
            published: 2;
            participantReconcile: 3;
            prepare: 1;
            retainedFallback: 1;
            progress: 1;
            directory: 1;
            directoryRecheck: 1;
            scopeAdmission: 1;
            receivingSelection: 1;
            receivingReconcile: 1;
            receivingCommand: 1;
            checkpoint: 1;
            finish: 1;
            terminalVerify: 1;
            historyAuthority: 1;
            historyHandoff: 1;
        }>;
        library: Readonly<{
            discovery: 0;
            plannerSteps: 0;
            effectPages: 1;
            currentVerifications: 1;
            exhaustedPageRechecks: 1;
            finalFences: 0;
        }>;
    }>;
    widerExecutor: Readonly<{
        prepare: "custody insert + recordSemanticSourceCommit + producer roles + SEMANTIC_ERASURE_PROGRESS";
        checkpoint: "terminal append + recordSemanticSourceCommit + producer roles + SEMANTIC_ERASURE_PROGRESS";
        exhaustedReceiving: "single-source-fence: retainIdentityScopeConsumerFence + native commit SQL + SEMANTIC_ERASURE_PROGRESS";
        finish: "terminal append + binding cut + Account technical receiver + SEMANTIC_ERASURE_PROGRESS";
    }>;
    historyComponents: Readonly<{
        local: Readonly<{
            [k: string]: Readonly<WorkDimensions>;
        }>;
        sdk: Readonly<{
            [k: string]: Readonly<WorkDimensions>;
        }>;
        multiplicities: 'requires executable reached History caller multiplicities';
    }> | null;
    historyCallableInstalled: boolean;
    libraryDeclaration: Readonly<{
        work: WorkDimensions;
        engineRequests: 0;
    }> | null;
    librarySameWorkCallableInstalled: boolean;
    missing: readonly string[];
}>>;
export {};
