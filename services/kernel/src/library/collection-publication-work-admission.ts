/** SERVER ONLY. Original Library whole-query publication seam, distinct from Members and Kind. */
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import { authoritativeTimeValue, commandTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type {
  CollectionPublicationCreation,
  CollectionPublicationInputRef,
  CollectionPublicationPhase,
  CollectionPublicationRuleRef,
  CollectionPublicationTargetRef,
} from './collection-publication-episode-contract.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { NativeSourceCustody, NativeSourceIdentity } from './native-source-custody.ts';

/** Exact native lookup fields only. Possession grants neither admission nor final command authority. */
export type CollectionPublicationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  publicationId: string;
}>;

/** Actual expanded, pinned whole-query meaning read from native state, never request JSON.
 * This transient result is not a second retained AST on an episode or work payload.
 */
export type CollectionPublicationDefinition = Readonly<{
  filter: FilterDocument;
  sort: 'id';
  release: Readonly<{ digest: string; value: FilterRelease }>;
}>;

/** Data on the SAME live Core client after independent native admission, not a completion receipt.
 * input and target MUST name the SAME actual Collection explicitly; input remains private working
 * Source even while target serves selected A. output names pending native B, never a borrowed A.
 * Compare the WHOLE result again after foreign staging and before settling progress.
 */
export type CollectionPublicationWorkDefinition = Readonly<{
  locator: CollectionPublicationLocator;
  definition: CollectionPublicationDefinition;
  input: CollectionPublicationInputRef;
  target: CollectionPublicationTargetRef;
  rule: CollectionPublicationRuleRef;
  creation: CollectionPublicationCreation;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
  identityObservation: IdentityScopeObservation;
  repairReceipt: IdentityNativeReceipt;
  custody: NativeSourceCustody;
  releaseDigest: string;
  audience: string;
}> &
  Extract<CollectionPublicationPhase, { phase: 'staging' | 'awaiting_activation' }>;

/** Necessary executor/namespace conditions only. This does not admit a publication episode.
 * Check the original object before touching its query method or interpreting any caller evidence.
 */
function livePublicationNamespace(tx: OperationalTransaction, locator: CollectionPublicationLocator): boolean {
  if (!hasLiveOperationalTransaction(tx)) return false;
  const resources = currentOperationalResources(tx);
  const ownerRoute = routeOf(locator.ownerAccountId);
  if (
    resources.mode !== 'work-step' ||
    routeOf(locator.collectionId) !== locator.route ||
    ownerRoute === null ||
    resources.partition !== partitionOf(locator.route) ||
    resources.partition !== partitionOf(ownerRoute) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== locator.ownerAccountId ||
    typeof locator.publicationId !== 'string' ||
    locator.publicationId.length === 0
  )
    return false;
  const time = commandTime(tx);
  if (!time) return false;
  authoritativeTimeValue(time);
  return true;
}

/** The peer's original operation/source/creation-receipt reader is not delivered in this tree.
 * CollectionPublicationInitiatorReader is only a DurableInitiatorReader type alias; it has no
 * native implementation or episode reader to call. Never substitute current Collection/output
 * rows, a locator or the caller's creation JSON for that independently committed provenance.
 */
function missingPublicationProducer(): never {
  throw new ProblemError('dependency_unavailable', {
    detail: 'Native Collection publication episode and original operation/source/creation receipt readers are unavailable.',
  });
}

/** Admission permits bounded own-namespace mechanical staging only; never disclosure or activation.
 * Executor checks precede the still-missing original native episode/creation reader. Its delivery
 * must also bind the installed pool, current phase/rule/source/identity/custody and output fences.
 */
export async function admitCollectionPublicationStep(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
): Promise<boolean> {
  if (!livePublicationNamespace(tx, locator)) return false;
  return missingPublicationProducer();
}

/** Getter data alone is never admission or completion. Recheck the SAME native client on each use.
 * Missing original provenance is unavailable, never ready-empty. Source initialization cannot
 * start from a bare locator while its owning episode reader is absent.
 */
export async function readCollectionPublicationWorkDefinition(
  tx: OperationalTransaction,
  locator: CollectionPublicationLocator,
): Promise<CollectionPublicationWorkDefinition | null> {
  if (!livePublicationNamespace(tx, locator)) return null;
  return missingPublicationProducer();
}
