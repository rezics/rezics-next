/** Private native Kind evidence. References are locators, never read authority. */
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { CollectionKindPreparationLocator } from '../library/collection-kind-work-admission.ts';
import type { CanonicalDerivedRow, CanonicalGroupProgress } from '../library/canonical-source-store.ts';
import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { CollectionKindPreparationWorkContext } from '../search/scope-work-context.ts';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { isDeepStrictEqual } from 'node:util';
import { KIND_TYPE_MAX_BYTES, type NativeKindTypeAnchor } from './scope-leaf-selection.ts';

/** One retained owner record in the existing Source home; possession grants nothing. */
export type KindTypeEvidenceReference = Readonly<{
  locator: CollectionKindPreparationLocator;
  evidenceId: string;
}>;

/** One original/group frontier; no subject vector, permission cache or second cursor. */
export type KindTypeEvidenceProgress = Readonly<{
  settledSubjectId: string | null;
  group: CanonicalGroupProgress | null;
}>;

export type KindTypeContribution = Readonly<{
  reference: CanonicalDerivedRow;
  typeId: string;
}>;

export type KindTypeEvidenceReadInput = Readonly<{
  /** Library resolves its committed bounded attempt. No caller-supplied subjects. */
  locator: CollectionKindPreparationLocator;
  allowance: WorkAllowance;
  deadline: number;
}>;
export type KindTypeEvidenceVerifyInput = Readonly<{
  work: CollectionKindPreparationWorkContext;
  evidence: KindTypeEvidenceReference;
  allowance: WorkAllowance;
  deadline: number;
}>;
export type KindTypeEvidenceUnavailable = Readonly<{
  status: 'unavailable';
  work: WorkReceipt;
}>;
export type KindTypeEvidenceReadResult =
  | KindTypeEvidenceUnavailable
  | Readonly<{
      status: 'prepared';
      evidence: KindTypeEvidenceReference;
      progress: KindTypeEvidenceProgress;
      work: WorkReceipt;
    }>;
export type KindTypeEvidenceVerifyResult =
  | KindTypeEvidenceUnavailable
  | Readonly<{
      status: 'current';
      contributions: readonly KindTypeContribution[];
      progress: KindTypeEvidenceProgress;
      work: WorkReceipt;
    }>;
export interface NativeKindTypeEvidence {
  /** Outside a Source transaction. Native producers must admit every home with its own live T. */
  read(input: KindTypeEvidenceReadInput): Promise<KindTypeEvidenceReadResult>;
  /** SAME Source only; no checkout, callback or foreign preparation inside this invocation. */
  verify(input: KindTypeEvidenceVerifyInput): Promise<KindTypeEvidenceVerifyResult>;
}

/** These are missing producer contracts, NOT names asserted to be existing exports.
 * Keep them explicit until the original owners publish their literal declarations.
 */
export const KIND_TYPE_MISSING_OWNER_BINDINGS = Object.freeze([
  'Library collection-kind-work-admission.ts: committed bounded attempt lookup, original reference/frontier, audience origin and finite admission work receipt',
  'Accounts request/access.ts and access/permission.ts: purpose-bound native audience origin, original/terminal current formula evidence and Source-local negative/temporal writer closure',
  'Core command/operational.ts: original per-home Kind attempt admission with a genuine live T and the SAME Source reservation, without a held Source transaction',
] as const);

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function validLocator(locator: CollectionKindPreparationLocator): boolean {
  return (
    !!locator &&
    isDeepStrictEqual(Object.keys(locator).sort(), ['collectionId', 'ownerAccountId', 'preparationId', 'route']) &&
    routeOf(locator.collectionId) !== null &&
    routeOf(locator.collectionId) === locator.route &&
    routeOf(locator.ownerAccountId) === locator.route &&
    uuid.test(locator.preparationId)
  );
}

/** Literal-first boundary. Missing original owner admission refuses before ANY IO.
 * Native selection/reduction below supplies no substitute permission or lifecycle.
 */
export function createNativeKindTypeEvidence(config: Readonly<{ pool: Pool; access: Access }>): NativeKindTypeEvidence {
  return {
    async read(input) {
      const work = new NativeCollectionWork(input.allowance, input.deadline);
      if (!validLocator(input.locator) || Date.now() >= input.deadline)
        return { status: 'unavailable', work: work.receipt() };
      // The Library getter currently has no bounded attempt/origin or native work receipt.
      // Calling it, ordinary summaries, or Access here would dispatch unadmitted work.
      return { status: 'unavailable', work: work.receipt() };
    },
    async verify(input) {
      const work = new NativeCollectionWork(input.allowance, input.deadline);
      const context = input.work;
      if (
        context?.kind !== 'collection-kind-preparation' ||
        !validLocator(context.locator) ||
        !hasLiveOperationalTransaction(context.tx) ||
        !uuid.test(input.evidence.evidenceId) ||
        !validLocator(input.evidence.locator)
      )
        return { status: 'unavailable', work: work.receipt() };
      const resources = currentOperationalResources(context.tx);
      const time = commandTime(context.tx);
      if (
        !time ||
        resources.pool !== config.pool ||
        resources.mode !== 'work-step' ||
        resources.partition !== partitionOf(context.locator.route) ||
        resources.accounts.length !== 1 ||
        resources.accounts[0] !== context.locator.ownerAccountId ||
        input.deadline > resources.deadline ||
        Date.now() >= input.deadline ||
        !isDeepStrictEqual(context.locator, input.evidence.locator)
      )
        return { status: 'unavailable', work: work.receipt() };
      authoritativeTimeValue(time);
      // Core liveness is necessary, but cannot replace Library admission or the
      // Accounts native writer/negative/time closure. No foreign reread is legal here.
      return { status: 'unavailable', work: work.receipt() };
    },
  };
}

/** Internal structural dependencies. An excluded original is retained even when
 * it contributes nothing. These values deliberately cannot be passed to verify
 * as evidence: native records, original admissions and Accounts are still owed.
 */
export type KindTypeDependencyProjection = Readonly<{
  reference: CanonicalDerivedRow;
  original: NativeKindTypeAnchor;
  terminal: NativeKindTypeAnchor | null;
}>;
export type KindTypeSelection =
  | Readonly<{ state: 'unavailable'; dependencies: KindTypeDependencyProjection }>
  | Readonly<{ state: 'excluded'; dependencies: KindTypeDependencyProjection }>
  | Readonly<{
      state: 'candidate';
      typeId: string;
      dependencies: KindTypeDependencyProjection;
    }>;

function completeProvenance(anchor: NativeKindTypeAnchor): boolean {
  if (!anchor.writer_enrolled) return false;
  if (!anchor.present) return true;
  return (
    anchor.revision !== null &&
    anchor.revision_transaction !== null &&
    anchor.revision_epoch !== null &&
    anchor.revision_position !== null &&
    anchor.current_release !== null &&
    (anchor.redirect === null ||
      (anchor.redirect_sequence !== null &&
        anchor.redirect_transaction !== null &&
        anchor.redirect_epoch !== null &&
        anchor.redirect_position !== null))
  );
}

/** Select only the native field dependency. This is NOT an audience decision or
 * vote, and the public producer never accepts a caller's projection as proof.
 * Library's existing terminal uniqueness/count CAS consumes admitted support,
 * so every duplicate raw reference remains a dependency without a seen vector.
 */
export function selectNativeKindTypeDependency(dependencies: KindTypeDependencyProjection): KindTypeSelection {
  const { reference, original, terminal } = dependencies;
  const result = (state: 'excluded' | 'unavailable'): KindTypeSelection => ({ state, dependencies });
  if (original.subject_id !== reference.key.storedSubjectId) return result('unavailable');
  if (!completeProvenance(original)) return result('unavailable');
  if (!original.present || original.visibility !== 'visible') return result('excluded');
  if ((original.redirect ?? original.subject_id) !== reference.canonicalSubjectId) return result('unavailable');
  if (!terminal || terminal.subject_id !== reference.canonicalSubjectId || !completeProvenance(terminal))
    return result('unavailable');
  if (!terminal.present || terminal.visibility !== 'visible') return result('excluded');
  if (terminal.redirect !== null || terminal.type_oversized || terminal.type === null) return result('unavailable');
  if (Buffer.byteLength(terminal.type) > KIND_TYPE_MAX_BYTES) return result('unavailable');
  // The native Kind contribution/progress envelope is still 4096 bytes. A Type
  // that fits its guarded field read can nevertheless exceed the whole envelope.
  if (Buffer.byteLength(JSON.stringify({ reference, typeId: terminal.type })) > KIND_TYPE_MAX_BYTES)
    return result('unavailable');
  return { state: 'candidate', typeId: terminal.type, dependencies };
}

