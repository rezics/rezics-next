import { memoizedValue } from '../memoized.ts';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import { libraryIdentityFootprint } from './identity-native-planner-work.ts';
import { nativeCollectionFootprint } from './collection-source-native.ts';
import {
  NATIVE_SOURCE_CUSTODY_CAPTURE_STEP_BOUND,
  nativeSourceCustodyStatementBound,
  type NativeSourceCustodyOperation,
  nativeSourceCustodyOperationBound,
} from './native-source-custody-bounds.ts';
import { nativePublicOutputFootprint } from './native-public-output-work.ts';
import {
  declareNativeIdentitySourceBasisStatements,
  libraryIdentitySelectedFootprint,
} from './identity-native-bounds.ts';
import { LIBRARY_IDENTITY_SELECTED_STATEMENTS } from './identity-native-planner-projection.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../command/dispatch-lifetime.ts';

/** Producer composition only. A component is neither an allowance nor an original grant. */
export type LibraryIdentityStatementOwner = 'planner' | 'native-collection' | 'native-custody' | 'native-public-output';
const component: unique symbol = Symbol('Library original work component');
export type LibraryIdentityOriginalComponent = Readonly<{
  [component]: true;
  work: WorkDimensions;
  engineRequests: 0;
}>;
const components = new WeakSet<LibraryIdentityOriginalComponent>();
const componentBounds = new WeakMap<LibraryIdentityOriginalComponent, Bound>();

function asBound(work: WorkDimensions): Bound {
  const keys = Reflect.ownKeys(work).filter((key) => key !== 'engineRequests');
  if (keys.length !== 8) throw new TypeError('Invalid Library native declaration');
  if ('engineRequests' in work && (work as WorkDimensions & { engineRequests?: number }).engineRequests !== 0)
    throw new TypeError('Library SQL cannot declare engine requests');
  return declareBound({
    candidateKeys: work.candidateKeys,
    nativeRows: work.nativeRows,
    identityMetadataRows: work.identityMetadataRows,
    emptySeeks: work.emptySeeks,
    nativePoints: work.nativePoints,
    witnessKeys: work.witnessKeys,
    statements: work.statements,
    bytes: work.bytes,
    engineRequests: 0,
  });
}
function asWork(bound: Bound): WorkDimensions {
  if (bound.engineRequests !== 0) throw new TypeError('Library SQL cannot declare engine requests');
  return Object.freeze({
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
  });
}
function declared(bound: Bound): LibraryIdentityOriginalComponent {
  const value = declareBound({
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
    engineRequests: bound.engineRequests,
  });
  if (value.engineRequests !== 0) throw new TypeError('Library SQL cannot declare engine requests');
  const result = Object.freeze({
    [component]: true as const,
    work: asWork(value),
    engineRequests: 0 as const,
  });
  components.add(result);
  componentBounds.set(result, value);
  return result;
}

/** SQL, original binds and the owner's actual admitted projection are included. A saved
 * job or partition projection without its paid same-snapshot size point stays unknown.
 * Literal recognition is delegated only to the actual body owner, never a caller observer.
 */
export function declareLibraryIdentityStatement(
  owner: LibraryIdentityStatementOwner,
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): LibraryIdentityOriginalComponent | undefined {
  if (owner === 'native-custody') {
    const bound = nativeSourceCustodyStatementBound(sql, values);
    return bound ? declared(bound) : undefined;
  }
  const bound =
    owner === 'planner'
      ? libraryIdentityFootprint(sql, values, work)
      : owner === 'native-collection'
        ? nativeCollectionFootprint(sql, values, work)
        : owner === 'native-public-output'
          ? nativePublicOutputFootprint(sql, values, work)
          : undefined;
  return bound ? declared(asBound(bound)) : undefined;
}

/** Operation-level custody term from the same declarations used by SQL dispatch. */
export function declareLibraryIdentityCustodyOperation(
  operation: NativeSourceCustodyOperation,
): LibraryIdentityOriginalComponent {
  return declared(nativeSourceCustodyOperationBound(operation));
}

/** The Source-selected page can dispatch one capture page or its terminal finish step. */
export function LIBRARY_IDENTITY_CUSTODY_CAPTURE_STEP() {
  return memoizedValue(LIBRARY_IDENTITY_CUSTODY_CAPTURE_STEP, () =>
    declared(NATIVE_SOURCE_CUSTODY_CAPTURE_STEP_BOUND()),
  );
}

/** Pool checkout itself has no SQL, result projection, candidate or witness. */
export function LIBRARY_IDENTITY_CHECKOUT_WORK() {
  return memoizedValue(LIBRARY_IDENTITY_CHECKOUT_WORK, () =>
    declared(
      declareBound({
        candidateKeys: 0,
        nativeRows: 0,
        identityMetadataRows: 0,
        emptySeeks: 0,
        nativePoints: 1,
        witnessKeys: 0,
        statements: 0,
        bytes: 0,
        engineRequests: 0,
      }),
    ),
  );
}

/** Inclusive component algebra. A caller cannot splice an arbitrary vector into it.
 * Repeats (including rejected SQL and failed COMMIT followed by ROLLBACK) are separate
 * operands; only controls that were never dispatched may be omitted from actual work.
 * This assembles components, not an all-reached invocation declaration.
 */
export function assembleLibraryIdentityOriginalComponents(
  terms: readonly Readonly<{ component: LibraryIdentityOriginalComponent; multiplicity: number }>[],
): LibraryIdentityOriginalComponent {
  const parts = terms.map((term) => {
    if (!components.has(term.component)) throw new TypeError('Foreign Library native declaration');
    if (!Number.isSafeInteger(term.multiplicity) || term.multiplicity < 0)
      throw new TypeError('Unbounded Library invocation multiplicity');
    return repeatBound(componentBounds.get(term.component)!, term.multiplicity);
  });
  return declared(sumBounds(...parts));
}

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
export const LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES = Object.freeze({
  discovery: 0,
  plannerSteps: 0,
  effectPages: 1,
  currentVerifications: 1,
  exhaustedPageRechecks: 1,
  finalFences: 0,
} as const satisfies LibraryIdentityOriginalMultiplicities);

export type LibraryIdentitySelectedMissingOperand =
  | Readonly<{
      owner: 'Source';
      operand: 'prepaid-receiver';
      signature: 'withPrepaidIdentitySourceConsumerMaintenance(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext, body: (context: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>';
    }>
  | Readonly<{
      owner: 'Source';
      operand: 'irreversible-selected-schedule';
      signature: 'LibraryIdentityOriginalMultiplicities { discovery: 0; plannerSteps: 0; effectPages: 1; currentVerifications: 1; exhaustedPageRechecks: 1; finalFences: 0 }, enforced before IO for parent.original/job/native position/Pool/exact Library ledger/deadline, without refill';
    }>
  | Readonly<{
      owner: 'Accounts';
      operand: 'authentic-command-dispatch-owner';
      signature: 'CommandDispatchOwner { original: object; validate(): void; reserve(allowance: CommandDispatchAllowance): void | Promise<void> }, bound by the private selected-original owner to withCommandDispatchLifetime<T>(pool: Pool, deadline: number, owner: CommandDispatchOwner, body: () => Promise<T>): Promise<T>';
    }>;

export const LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS: readonly LibraryIdentitySelectedMissingOperand[] =
  Object.freeze([]);

/** Executable owner assembly of ALL Library SQL reached by the selected one-shot policy.
 * No caller quote, configured balance, observed row count, future planner work or foreign term enters it.
 * Bounds come from the native projections and before-dispatch original-bind checks. All branches of
 * the explicit-output current basis are covered, even when an earlier current check returns pending.
 * Core controls are separately returned by reference to their actual owner declaration, never added
 * to the Library SQL term. Source's private scheduler and Library's one-use claim consumption
 * enforce these maxima. Pending native plans require a later independently admitted original.
 */
export function assembleLibraryIdentitySelectedBodies() {
  const statement = (name: keyof ReturnType<typeof LIBRARY_IDENTITY_SELECTED_STATEMENTS>) => {
    const { sql, values } = LIBRARY_IDENTITY_SELECTED_STATEMENTS()[name];
    const footprint = libraryIdentitySelectedFootprint(sql, values);
    const value = footprint && declared(asBound(footprint));
    if (!value) throw new TypeError(`Unknown Library selected ${name} declaration`);
    return value;
  };
  const basis = assembleLibraryIdentityOriginalComponents(
    declareNativeIdentitySourceBasisStatements().map((value) => ({
      component: declared(asBound(value.work)),
      multiplicity: 1,
    })),
  );
  const current = assembleLibraryIdentityOriginalComponents([
    { component: statement('current'), multiplicity: 1 },
    { component: statement('job'), multiplicity: 1 },
    { component: basis, multiplicity: 1 },
  ]);
  const verification = assembleLibraryIdentityOriginalComponents([
    { component: statement('plan'), multiplicity: 1 },
    { component: statement('seal'), multiplicity: 1 },
    { component: current, multiplicity: 1 },
  ]);
  const page = assembleLibraryIdentityOriginalComponents([
    { component: verification, multiplicity: 1 },
    { component: statement('page'), multiplicity: 1 },
    { component: LIBRARY_IDENTITY_CUSTODY_CAPTURE_STEP(), multiplicity: 1 },
  ]);
  const total = assembleLibraryIdentityOriginalComponents([
    { component: page, multiplicity: LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES.effectPages },
    { component: verification, multiplicity: LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES.currentVerifications },
    { component: verification, multiplicity: LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES.exhaustedPageRechecks },
  ]);
  return Object.freeze({
    multiplicities: LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES,
    page,
    currentVerification: verification,
    exhaustedPageRecheck: verification,
    total,
    coreDispatch: COMMAND_DISPATCH_ALLOWANCE,
    missing: LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS,
  });
}

/** Installed Library term ONLY. Accounts still requires the disjoint complete
 * Source/History term before it can allocate either child. This exact own data
 * shape contains no component brand, caller price, allowance or parent authority.
 */
export function IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION() {
  return memoizedValue(IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION, () =>
    Object.freeze({
      work: assembleLibraryIdentitySelectedBodies().total.work,
      engineRequests: 0 as const,
    }),
  );
}

export type LibraryIdentityOriginalMissingOperand =
  | Readonly<{
      owner: 'Source';
      operand: 'prepaid-receiver';
      signature: 'withPrepaidIdentitySourceConsumerMaintenance(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext, body: (context: IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>';
    }>
  | Readonly<{
      owner: 'Source';
      operand: 'library-invocation-multiplicities';
      signature: 'LibraryIdentityOriginalMultiplicities';
    }>
  | Readonly<{
      owner: 'Core';
      operand: 'native-command-partition-projection';
      signature: 'runCommand partition read: bounded node/moved_to projection or same-command same-snapshot size admission';
    }>
  | Readonly<{
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
export const LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS: readonly LibraryIdentityOriginalMissingOperand[] =
  Object.freeze([
    Object.freeze({
      owner: 'Source',
      operand: 'library-invocation-multiplicities',
      signature: 'LibraryIdentityOriginalMultiplicities',
    }),
    Object.freeze({
      owner: 'Core',
      operand: 'native-command-partition-projection',
      signature:
        'runCommand partition read: bounded node/moved_to projection or same-command same-snapshot size admission',
    }),
    Object.freeze({
      owner: 'Library',
      operand: 'original-projection-bound',
      signature: 'saved IdentityJob intent and native partition projection maximum before original admission',
    }),
  ]);
