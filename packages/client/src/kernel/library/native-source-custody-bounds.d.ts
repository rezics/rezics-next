import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';
type Query = Readonly<{
    sql: string;
    params: readonly string[];
}>;
type StatementId = 'account' | 'advance' | 'ensure' | 'fences' | 'finish' | 'held' | 'hold' | 'identityCapture' | 'identityPartition' | 'output' | 'proof' | 'rawAssignment' | 'rawChange' | 'rawCopy' | 'rawEntry' | 'rawEntryDeleted' | 'rawExplicitOutput' | 'rawLabel' | 'rawMember' | 'rawOutput' | 'rawSession' | 'rawUnit' | 'retireActive' | 'retireCaptureRow' | 'retireChildren' | 'retireHolds' | 'retireProofRow' | 'retireReceipt' | 'retireSource' | 'identityRetention' | 'nextCapture' | 'read' | 'release' | 'retained' | 'source' | 'start' | 'terminalScope';
type CustodyOperation = 'capturePage' | 'finishCapture' | 'readAndHold' | 'revalidateHold' | 'releaseHold' | 'retireCapture';
/** Explicit Query names so the producer declaration does not leak pg protocol types. */
type NativeSourceCustodyQueries = Readonly<{
    partition: Query;
    source: Query;
    account: Query;
    output: Query;
    ensure: Query;
    fences: Query;
    read: Query;
    start: Query;
    advance: Query;
    identityCapture: Query;
    proof: Query;
    finish: Query;
    hold: Query;
    held: Query;
    retained: Query;
    release: Query;
    terminalScope: Query;
    raw: Readonly<{
        member: Query;
        entry: Query;
        entry_deleted: Query;
        label: Query;
        assignment: Query;
        session: Query;
        unit: Query;
        change: Query;
        copy: Query;
        output: Query;
    }>;
    rawExplicitOutput: Query;
    retirement: Readonly<{
        partition: Query;
        source: Query;
        receipt: Query;
        active: Query;
        holds: Query;
        children: Query;
        proof: Query;
        capture: Query;
        identityRetention: Query;
        nextCapture: Query;
    }>;
}>;
/** The canonical SQL objects used by the native adapter and the executable plan. */
export declare function nativeSourceCustodyQueries(): NativeSourceCustodyQueries;
type StatementCounts = Readonly<Partial<Record<StatementId, number>>>;
/** Translate the nine-axis public bound to the legacy native receipt axes explicitly. */
export declare function nativeSourceCustodyWorkDimensions(bound: Bound): WorkDimensions;
/** Closed operation-to-statement bindings and finite maxima for the actual custody adapter. */
export declare function NATIVE_SOURCE_CUSTODY_OPERATION_PLAN(): Readonly<{
    version: 1;
    owner: 'Library';
    operations: {
        capturePage: {
            declaration: Readonly<{
                bindings: readonly string[];
                fixed: Readonly<Partial<Record<StatementId, number>>>;
                optional: Readonly<Partial<Record<StatementId, number>>>;
                choices: Readonly<Record<string, Readonly<{
                    maximum: number;
                    statements: StatementCounts;
                }>>>;
                controls: Readonly<Partial<Record<"BEGIN" | "COMMIT" | "ROLLBACK", number>>>;
                checkout: number;
                frontier?: Readonly<{
                    minLimit: number;
                    maxLimit: number;
                    sessionLimit: number;
                }>;
            }>;
            ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
            cost: Readonly<{
                requestBytes: number;
                projectionBytes: number;
            }>;
        };
        finishCapture: {
            declaration: Readonly<{
                bindings: readonly string[];
                fixed: Readonly<Partial<Record<StatementId, number>>>;
                optional: Readonly<Partial<Record<StatementId, number>>>;
                choices: Readonly<Record<string, Readonly<{
                    maximum: number;
                    statements: StatementCounts;
                }>>>;
                controls: Readonly<Partial<Record<"BEGIN" | "COMMIT" | "ROLLBACK", number>>>;
                checkout: number;
                frontier?: Readonly<{
                    minLimit: number;
                    maxLimit: number;
                    sessionLimit: number;
                }>;
            }>;
            ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
            cost: Readonly<{
                requestBytes: number;
                projectionBytes: number;
            }>;
        };
        readAndHold: {
            declaration: Readonly<{
                bindings: readonly string[];
                fixed: Readonly<Partial<Record<StatementId, number>>>;
                optional: Readonly<Partial<Record<StatementId, number>>>;
                choices: Readonly<Record<string, Readonly<{
                    maximum: number;
                    statements: StatementCounts;
                }>>>;
                controls: Readonly<Partial<Record<"BEGIN" | "COMMIT" | "ROLLBACK", number>>>;
                checkout: number;
                frontier?: Readonly<{
                    minLimit: number;
                    maxLimit: number;
                    sessionLimit: number;
                }>;
            }>;
            ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
            cost: Readonly<{
                requestBytes: number;
                projectionBytes: number;
            }>;
        };
        revalidateHold: {
            declaration: Readonly<{
                bindings: readonly string[];
                fixed: Readonly<Partial<Record<StatementId, number>>>;
                optional: Readonly<Partial<Record<StatementId, number>>>;
                choices: Readonly<Record<string, Readonly<{
                    maximum: number;
                    statements: StatementCounts;
                }>>>;
                controls: Readonly<Partial<Record<"BEGIN" | "COMMIT" | "ROLLBACK", number>>>;
                checkout: number;
                frontier?: Readonly<{
                    minLimit: number;
                    maxLimit: number;
                    sessionLimit: number;
                }>;
            }>;
            ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
            cost: Readonly<{
                requestBytes: number;
                projectionBytes: number;
            }>;
        };
        releaseHold: {
            declaration: Readonly<{
                bindings: readonly string[];
                fixed: Readonly<Partial<Record<StatementId, number>>>;
                optional: Readonly<Partial<Record<StatementId, number>>>;
                choices: Readonly<Record<string, Readonly<{
                    maximum: number;
                    statements: StatementCounts;
                }>>>;
                controls: Readonly<Partial<Record<"BEGIN" | "COMMIT" | "ROLLBACK", number>>>;
                checkout: number;
                frontier?: Readonly<{
                    minLimit: number;
                    maxLimit: number;
                    sessionLimit: number;
                }>;
            }>;
            ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
            cost: Readonly<{
                requestBytes: number;
                projectionBytes: number;
            }>;
        };
        retireCapture: {
            declaration: Readonly<{
                bindings: readonly string[];
                fixed: Readonly<Partial<Record<StatementId, number>>>;
                optional: Readonly<Partial<Record<StatementId, number>>>;
                choices: Readonly<Record<string, Readonly<{
                    maximum: number;
                    statements: StatementCounts;
                }>>>;
                controls: Readonly<Partial<Record<"BEGIN" | "COMMIT" | "ROLLBACK", number>>>;
                checkout: number;
                frontier?: Readonly<{
                    minLimit: number;
                    maxLimit: number;
                    sessionLimit: number;
                }>;
            }>;
            ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
            cost: Readonly<{
                requestBytes: number;
                projectionBytes: number;
            }>;
        };
    };
    captureStepCeiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    retirementPageCeiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    statementAxes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
    compatibilityReceiptAxes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes"];
    projections: {
        captureRecordBytes: number;
        rawDependencyBytes: number;
        receiptBytes: number;
        holdBytes: number;
        retainedHoldBytes: number;
        terminalOwnerBytes: number;
        retirementSourceBytes: number;
        retirementHoldBytes: number;
        retirementPlanKeyBytes: number;
    };
    nonSql: Readonly<{
        authorization: "Existing native command and Source/Accounts admission remain authoritative.";
        currentness: "Current command resources, exact owner and immutable deadline are revalidated before dispatch.";
        timeout: "Checkout and query timeout use the current deadline; they add no SQL or result projection.";
        engineRequests: "Zero: every declared statement dispatches native SQL.";
    }>;
}>;
export type NativeSourceCustodyOperation = CustodyOperation;
export declare function NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
/** Rejects a recognized statement when it is not bound to this native operation. */
export declare function nativeSourceCustodyOperationAllows(operation: CustodyOperation, query: Query): boolean;
export type NativeSourceCustodyOperationUse = Readonly<{
    statement(query: Query): boolean;
    checkout(): boolean;
}>;
/** Runtime finite multiplicities from the operation declaration used to compose its ceiling. */
export declare function createNativeSourceCustodyOperationUse(operation: CustodyOperation): NativeSourceCustodyOperationUse;
export declare function nativeSourceCustodyOperationBound(operation: CustodyOperation): Bound;
/** The Source-selected effect step invokes one raw page or its terminal finish path. */
export declare function NATIVE_SOURCE_CUSTODY_CAPTURE_STEP_BOUND(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
/** Exact runtime query-object pricing. Unknown SQL has no compatibility estimate. */
export declare function nativeSourceCustodyExecutionBound(query: Query, values: readonly unknown[]): Bound | undefined;
/** Nine-axis declaration for original-work composition and SQL-backed dispatch. */
export declare function nativeSourceCustodyStatementBound(sql: string, values: readonly unknown[]): Bound | undefined;
/** Lookup-only eight-axis receipt adapter for callers not yet using operation objects. */
export declare function nativeSourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export {};
