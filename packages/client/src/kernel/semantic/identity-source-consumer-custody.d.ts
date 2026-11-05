import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type { IdentityJobRef, IdentityNativeReceipt, IdentityReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { LibraryScopeEffectsPage, LibraryScopeEffectsKey } from '../library/identity-scope-effects.ts';
import type { LibraryExpectedEffectAfter } from '../library/identity-scope-effects.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { AgentIdentityRetirementStage } from '../history/agent-identity-retirement.ts';
import type { AgentIdentitySDKReceivingBinding } from '../history/agent-identity-sdk-fence.ts';
import { type SdkWriterState } from '../work/sdk-retirement-fence.ts';
import type { IdentitySourceConsumerMaintenanceWork } from './identity-source-consumer-maintenance.ts';
export declare const IDENTITY_SOURCE_LOCAL_SQL: Readonly<{
    retained: "SELECT r.erasure_key::text,r.binding_generation::text,r.transaction_id,r.owner_epoch,n.position::text\nFROM semantic.identity_epoch_source_consumer_custody r\nJOIN semantic.erasure_source_commit n ON n.partition_no=r.partition_no AND n.transaction_id=r.transaction_id\n  AND n.epoch=r.owner_epoch AND n.xmin=r.xmin\nJOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'\n  AND p.epoch=r.owner_epoch AND p.position>=n.position\nJOIN semantic.identity_epoch_receipt_binding b ON b.partition_no=r.partition_no\n  AND b.receipt_key=r.receipt_key AND b.generation=r.binding_generation\n  AND b.intent_digest=r.source_digest AND b.state='accepted'\n  AND b.accepted_job=r.job_id AND b.accepted_epoch=r.job_epoch\nJOIN semantic.identity_epoch_receipt_claim c ON c.partition_no=b.partition_no\n  AND c.receipt_key=b.receipt_key AND c.generation=b.generation\n  AND c.scope_digest=r.scope_digest AND c.job_id=r.job_id AND c.job_epoch=r.job_epoch\nJOIN semantic.identity_epoch_receipt_claim_commit k ON k.partition_no=c.partition_no\n  AND k.receipt_key=c.receipt_key AND k.generation=c.generation AND k.transaction_id=r.binding_transaction_id\nWHERE r.partition_no=$1 AND r.receipt_key=$2 AND r.source_digest=$3 AND r.source_epoch=$4\n  AND r.source_position=$5 AND r.source_transaction_id=$6 AND r.job_id=$7 AND r.job_epoch=$8\n  AND r.barrier_account_id=$9 AND r.barrier_account_route=$10 AND r.barrier_version=$11\n  AND r.barrier_at=$12::timestamptz AND r.erased_role=$13\nFOR SHARE OF r,n,p,b,c,k /*file='src%2Fsemantic%2Fidentity-source-consumer-custody-select.sql'*/;";
    progress: "SELECT r.sequence::text,r.state,r.directory_after,r.ticket_key,r.effect_after,r.seal_digest,\n       r.replay_generation::text,r.undo_generation::text,r.restore_generation::text,\n       r.transaction_id,r.owner_epoch,n.position::text,\n       r.receiving_partition,r.receiving_epoch,r.receiving_position::text,r.receiving_transaction_id,\n       (n.transaction_id IS NOT NULL AND p.partition_no IS NOT NULL) AS native_current\nFROM (\n SELECT *, xmin AS source_xmin FROM semantic.identity_epoch_source_consumer_terminal\n WHERE partition_no=$1 AND custody_key=$2 ORDER BY sequence DESC LIMIT 1\n) r\nLEFT JOIN semantic.erasure_source_commit n ON n.partition_no=r.partition_no AND n.transaction_id=r.transaction_id\n AND n.epoch=r.owner_epoch AND n.xmin=r.source_xmin\nLEFT JOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'\n AND p.moved_to IS NULL AND p.epoch=r.owner_epoch AND p.position>=n.position /*file='src%2Fsemantic%2Fidentity-source-consumer-custody-progress.sql'*/;";
    accepted: "SELECT c.generation::text,c.scope_digest,c.job_home,\n  k.transaction_id AS binding_transaction_id\nFROM semantic.identity_epoch_receipt_binding b\nJOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key,generation)\nJOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)\nJOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no\n  AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin\nJOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active'\n  AND p.epoch=n.epoch AND p.position>=n.position\nWHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.state='accepted'\n  AND b.intent_digest=$3 AND c.intent_digest=$3 AND c.job_id=$4 AND c.job_epoch=$5\n  AND b.accepted_job=c.job_id AND b.accepted_epoch=c.job_epoch AND c.receipt=$6::jsonb\n  AND octet_length(c.scope_digest)<=128 AND c.job_home BETWEEN 0 AND 4095\nFOR UPDATE OF b FOR SHARE OF c,k,n,p";
    published: "SELECT j.scope_digest\nFROM semantic.identity_epoch_job j\nJOIN semantic.identity_epoch_native_commit n ON n.partition_no=j.partition_no\n  AND n.transaction_id=j.recorded_transaction_id AND n.purpose='admission'\nJOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'\n  AND p.epoch=n.epoch AND p.position>=n.position\nJOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no\nWHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='published'\n  AND octet_length(j.scope_digest)<=128\n  AND c.published_epoch>=j.epoch AND c.pending_job IS DISTINCT FROM j.job_id\nFOR SHARE OF j,n,p,c";
}>;
/** Complete fixed local READ declarations, independent of all foreign children.
 * Bytes include the actual SQL text, bounded serialized binds and full schema
 * projection. A hit/absence reserves the same leading-key probes and one EOF.
 */
export declare const IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS: Readonly<Readonly<Record<"accepted" | "progress" | "published" | "retained", Readonly<{
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
/** Disjoint local INSERT bodies. These are not successful whole commands: default
 * sequence allocation, FK checks, erasure capture and terminal binding triggers
 * must be composed as named children before dispatch. In particular their native
 * work cannot inherit Core's single-no-effect envelope.
 * Parameter maxima include JSON escaping (six bytes per bounded text byte).
 */
export declare const IDENTITY_SOURCE_LOCAL_MUTATION_COMPONENTS: Readonly<{
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
/** Closed body composition, independently useful to the declaration owners. The
 * same SQL component can appear at multiple reached sites; no receipt cache or
 * alternative branch makes repeated work free. Each list names its exact child
 * rather than accepting a caller-supplied total.
 */
export declare const IDENTITY_SOURCE_LOCAL_CALLS: Readonly<{
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
export declare function identitySourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
/** These are precise dependent executor gaps, not prices. Preserve the event and
 * callback semantics rather than relabeling them single-no-effect. */
export declare const IDENTITY_SOURCE_WIDER_COMMAND_REQUIREMENTS: Readonly<{
    prepare: "custody insert + recordSemanticSourceCommit + producer roles + SEMANTIC_ERASURE_PROGRESS";
    checkpoint: "terminal append + recordSemanticSourceCommit + producer roles + SEMANTIC_ERASURE_PROGRESS";
    exhaustedReceiving: "single-source-fence: retainIdentityScopeConsumerFence + native commit SQL + SEMANTIC_ERASURE_PROGRESS";
    finish: "terminal append + binding cut + Account technical receiver + SEMANTIC_ERASURE_PROGRESS";
}>;
/** Exact additive receiving ABI. The ordinary Library entry constructs its own
 * ledger and is therefore ineligible for this authentic original. An absent
 * WithWork producer refuses this operation; it never falls back to that entry.
 */
export declare function readIdentitySourcePrepaidLibraryPage(pool: Pool, context: IdentitySourceConsumerContext, input: LibraryScopeEffectsKey & Readonly<{
    after: LibraryExpectedEffectAfter | null;
    limit: number;
    allowance: WorkAllowance;
    deadline: number;
}>): Promise<LibraryScopeEffectsPage>;
export type IdentitySourceConsumerReference = Readonly<{
    receipt: Exclude<IdentityReceipt, {
        kind: 'subject.merge';
    }>;
    job: IdentityJobRef;
    source: IdentityNativeReceipt;
    sourceDigest: string;
    barrier: HistoryBarrier;
    /** subject is the original source key's account, distinct from requester/decider. */
    erasedRole: 'subject' | 'requester' | 'decider';
}>;
declare const identitySourceConsumerCustody: unique symbol;
export type IdentitySourceConsumerCustody = Readonly<{
    [identitySourceConsumerCustody]: true;
}>;
/** Required additive owner exchange, not a caller proof or an installed adapter. Native
 * implementations must resolve these generations from the original accepted input. */
export type IdentitySourceConsumerGeneration = Readonly<{
    replayGeneration: string;
    undoGeneration: string;
    restoreGeneration: string;
}>;
export type IdentitySourceConsumerWork = IdentitySourceConsumerGeneration & Readonly<{
    allowance: NativeStepWork;
}>;
export type IdentitySourceConsumerContext = Readonly<{
    deadline: number;
    identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
}>;
export type IdentitySourceConsumerDisposition = 'discharged' | 'transferred';
export type IdentitySourceScopeConsumerWork = Readonly<{
    allowance: WorkAllowance;
    /** Native owners provide proved SQL bounds. Unknown SQL must be refused before dispatch. */
    footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
}>;
/** Prepare retained native custody, then advance one exhaustive consumer-cut step. Missing
 * native fences or technical receiving authority leave the original bytes retained. */
export declare function readIdentitySourceConsumerCustody(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerCustody | null>;
/** Original 4/4/6/8192 reservation plus 96/96/16/131072 for the complete
 * nested Source verifier. Reserve here, rather than only in the History wrapper:
 * initial staging, post-commit reconstruction and independent History checks also
 * invoke this verifier. Subject Account settlement reserves separately in its owner. */
export declare const IDENTITY_SOURCE_CONSUMER_VERIFY_COST: NativeStepWork;
/** Same genuine live original-home command, fixed indexed points, no foreign checkout. */
export declare function verifyIdentitySourceConsumerCustody(tx: CommandTransaction, reference: IdentitySourceConsumerReference, proof: IdentitySourceConsumerCustody): Promise<boolean>;
type HistoryNativeLocator = Omit<IdentityNativeReceipt, 'position'> & Readonly<{
    position: string;
}>;
export type IdentitySourceHistoryReference = Omit<IdentitySourceConsumerReference, 'source' | 'job'> & Readonly<{
    source: HistoryNativeLocator;
    job: Readonly<{
        jobId: string;
        epoch: string;
    }>;
}>;
/** Persistable address of original Source authority, never a portable certificate.
 * The native consumer must resolve this SAME original row through the Source function
 * on every guarded transition, including the later receiving commit. */
export type IdentitySourceHistoryAuthority = Readonly<{
    kind: 'identity-source-history-guard/v1';
    custody: string;
    sequence: string;
    reference: IdentitySourceHistoryReference;
    generation: IdentitySourceConsumerGeneration;
    disposition: IdentitySourceConsumerDisposition;
    terminal: HistoryNativeLocator;
    receiving: HistoryNativeLocator | null;
}>;
/** Outer SELECT, fifteen exact native keyed inputs, and the returned native tuple.
 * There are two SQL statements: the outer SELECT and the function's joined SELECT.
 * PL/pgSQL comparisons/RETURN dispatch no SQL and this read fires no row triggers. */
export declare const IDENTITY_SOURCE_HISTORY_GUARD_COST: NativeStepWork;
export declare const IDENTITY_SOURCE_HISTORY_RECHECK_COST: NativeStepWork;
export declare const IDENTITY_SOURCE_HISTORY_RECEIVER_COST: NativeStepWork;
export type IdentitySourceHistoryHandoff = Readonly<{
    phase: 'readiness' | 'closure';
    sourceAuthority: IdentitySourceHistoryAuthority;
    binding: AgentIdentitySDKReceivingBinding;
    writer: SdkWriterState;
}>;
export type IdentitySourceHistoryHandoffResult = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'guarded';
    handoff: IdentitySourceHistoryHandoff;
}>;
/** Resolve durable ORIGINAL Source state, not a copied terminal receipt. This same
 * function is the supported native Source half of History's installed row guard:
 * semantic.lock_identity_source_history_handoff(reference, expectedAuthority).
 * It locks original custody, current binding/generations and native enrollment until
 * COMMIT. It does not supply Account verification, SDK closure or History readiness. */
export declare function lockIdentitySourceHistoryAuthority(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected?: IdentitySourceHistoryAuthority | null): Promise<IdentitySourceHistoryAuthority | null>;
/** Exact local Source function declaration. The body has fifteen fixed native
 * inputs (including the installed trigger catalogue point), one outer result and
 * one JSON result. No candidate enumeration, basis-metadata sweep, witness expansion
 * or engine request occurs. Failed exact-key lookup reserves one empty seek.
 * SQL/parameter bytes include the 2048/4096 inputs and the closed native output
 * projection above. The independent legacy allowance is not the prepaid price. */
export declare const IDENTITY_SOURCE_HISTORY_GUARD_DECLARATION: Readonly<{
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
/** Default owner composition on the genuine original Source command. Both phases
 * re-run native History/Source/Account verification and exact receiving admission,
 * then lock the actual SDK state on this SAME command. No foreign SQL, callbacks,
 * fresh frame, SDK retirement or History state mutation is substituted here.
 *
 * History owns persisting distinct guarded readiness/closure transitions. Its native
 * row guard must consume the Source function with the stored exact authority AND
 * its own current association, barrier, receiver and SDK prerequisites. Returning
 * this locator cannot authorize a later write by itself. */
export declare function lockIdentitySourceHistoryHandoff(tx: CommandTransaction, stage: AgentIdentityRetirementStage, binding: AgentIdentitySDKReceivingBinding, expectedWriter: SdkWriterState, phase: 'readiness' | 'closure', sdk: DBOSClient): Promise<IdentitySourceHistoryHandoffResult>;
export {};
