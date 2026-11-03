import type { WorkDimensions } from './collection-source.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
/** Producer composition only. A component is neither an allowance nor an original grant. */
export type LibraryIdentityStatementOwner = 'planner' | 'native-collection' | 'native-custody';
declare const component: unique symbol;
export type LibraryIdentityOriginalComponent = Readonly<{
    [component]: true;
    work: WorkDimensions;
    engineRequests: 0;
}>;
/** SQL, original binds and the owner's actual admitted projection are included. A saved
 * job or partition projection without its paid same-snapshot size point stays unknown.
 * Literal recognition is delegated only to the actual body owner, never a caller observer.
 */
export declare function declareLibraryIdentityStatement(owner: LibraryIdentityStatementOwner, sql: string, values: readonly unknown[], work?: NativeCollectionWork): LibraryIdentityOriginalComponent | undefined;
/** Pool checkout itself has no SQL, result projection, candidate or witness. */
export declare const LIBRARY_IDENTITY_CHECKOUT_WORK: Readonly<{
    [component]: true;
    work: WorkDimensions;
    engineRequests: 0;
}>;
/** Inclusive component algebra. A caller cannot splice an arbitrary vector into it.
 * Repeats (including rejected SQL and failed COMMIT followed by ROLLBACK) are separate
 * operands; only controls that were never dispatched may be omitted from actual work.
 * This assembles components, not an all-reached invocation declaration.
 */
export declare function assembleLibraryIdentityOriginalComponents(terms: readonly Readonly<{
    component: LibraryIdentityOriginalComponent;
    multiplicity: number;
}>[]): LibraryIdentityOriginalComponent;
/** Source owns invocation scheduling. These are distinct calls even when they run the
 * same literal verifier: page, repeated current, exhausted-page recheck and final fence.
 * Limits are the native admitted 1..100, not total population or future workflow runs.
 * A Source implementation must enforce its maxima before it can supply this operand.
 */
export type LibraryIdentityOriginalMultiplicities = Readonly<{
    discovery: number;
    plannerSteps: number;
    effectPages: number;
    currentVerifications: number;
    exhaustedPageRechecks: number;
    finalFences: number;
}>;
/** Source's installed irreversible private claim enforces this policy before IO.
 * The effect page already checks currentness once. Exhaustion (including zero) checks it again
 * after the separately scheduled current verification, for THREE native current paths in total.
 */
export declare const LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES: Readonly<{
    readonly discovery: 0;
    readonly plannerSteps: 0;
    readonly effectPages: 1;
    readonly currentVerifications: 1;
    readonly exhaustedPageRechecks: 1;
    readonly finalFences: 0;
}>;
export type LibraryIdentitySelectedMissingOperand = Readonly<{
    owner: 'Source';
    operand: 'prepaid-receiver';
    signature: 'withPrepaidIdentitySourceConsumerMaintenance(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext, body: (context: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>';
}> | Readonly<{
    owner: 'Source';
    operand: 'irreversible-selected-schedule';
    signature: 'LibraryIdentityOriginalMultiplicities { discovery: 0; plannerSteps: 0; effectPages: 1; currentVerifications: 1; exhaustedPageRechecks: 1; finalFences: 0 }, enforced before IO for parent.original/job/native position/Pool/exact Library ledger/deadline, without refill';
}> | Readonly<{
    owner: 'Accounts';
    operand: 'authentic-command-dispatch-owner';
    signature: 'CommandDispatchOwner { original: object; validate(): void; reserve(allowance: CommandDispatchAllowance): void | Promise<void> }, bound by the private selected-original owner to withCommandDispatchLifetime<T>(pool: Pool, deadline: number, owner: CommandDispatchOwner, body: () => Promise<T>): Promise<T>';
}>;
export declare const LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS: readonly LibraryIdentitySelectedMissingOperand[];
/** Executable owner assembly of ALL Library SQL reached by the selected one-shot policy.
 * No caller quote, configured balance, observed row count, future planner work or foreign term enters it.
 * Bounds come from the native projections and before-dispatch original-bind checks. All branches of
 * the explicit-output current basis are covered, even when an earlier current check returns pending.
 * Core controls are separately returned by reference to their actual owner declaration, never added
 * to the Library SQL term. Source's private scheduler and Library's one-use claim consumption
 * enforce these maxima. Pending native plans require a later independently admitted original.
 */
export declare function assembleLibraryIdentitySelectedBodies(): Readonly<{
    multiplicities: Readonly<{
        readonly discovery: 0;
        readonly plannerSteps: 0;
        readonly effectPages: 1;
        readonly currentVerifications: 1;
        readonly exhaustedPageRechecks: 1;
        readonly finalFences: 0;
    }>;
    page: Readonly<{
        [component]: true;
        work: WorkDimensions;
        engineRequests: 0;
    }>;
    currentVerification: Readonly<{
        [component]: true;
        work: WorkDimensions;
        engineRequests: 0;
    }>;
    exhaustedPageRecheck: Readonly<{
        [component]: true;
        work: WorkDimensions;
        engineRequests: 0;
    }>;
    total: Readonly<{
        [component]: true;
        work: WorkDimensions;
        engineRequests: 0;
    }>;
    coreDispatch: Readonly<{
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
    missing: readonly LibraryIdentitySelectedMissingOperand[];
}>;
/** Installed Library term ONLY. Accounts still requires the disjoint complete
 * Source/History term before it can allocate either child. This exact own data
 * shape contains no component brand, caller price, allowance or parent authority.
 */
export declare const IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION: Readonly<{
    work: WorkDimensions;
    engineRequests: 0;
}>;
export type LibraryIdentityOriginalMissingOperand = Readonly<{
    owner: 'Source';
    operand: 'prepaid-receiver';
    signature: 'withPrepaidIdentitySourceConsumerMaintenance(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext, body: (context: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>';
}> | Readonly<{
    owner: 'Source';
    operand: 'library-invocation-multiplicities';
    signature: 'LibraryIdentityOriginalMultiplicities';
}> | Readonly<{
    owner: 'Core';
    operand: 'native-command-partition-projection';
    signature: 'runCommand partition read: bounded node/moved_to projection or same-command same-snapshot size admission';
}> | Readonly<{
    owner: 'Library';
    operand: 'original-projection-bound';
    signature: 'saved IdentityJob intent and native partition projection maximum before original admission';
}>;
/** Unrestricted discovery/planner receiving diagnostics retained for ordinary callers.
 * The selected policy excludes these calls; use SELECTED_MISSING_OPERANDS for that policy.
 * Core's ordinary event-bearing command can still reach its full partition error projection.
 * Ordinary readJob/pageChanges remain unchanged and have no whole-intent ceiling.
 * The installed declaration above covers ONLY the guarded selected schedule.
 */
export declare const LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS: readonly LibraryIdentityOriginalMissingOperand[];
export {};
