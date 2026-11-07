import { isDeepStrictEqual } from 'node:util';
import type { PublicSourceRepair } from '../semantic/index.ts';
import { readNativePublicFilterAccountRepair } from '../semantic/index.ts';
import type { PublicFilterCost } from '../semantic/index.ts';
import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';
import type {
  CustodyFailure,
  NativeSourceRepairLocator,
  NativeSourceRepairStepRead,
  PublicFilterRepairSourceBinding,
  RetainedRepairPage,
  RetainedSourceRepair,
} from './public-filter-custody-contract.ts';

/** Failed owner verification remains a typed native unavailability at both consuming boundaries. */
export class PublicFilterRepairSourceError extends Error {
  constructor(readonly reason: CustodyFailure['reason']) {
    super(reason);
  }
}

/** Data fields only. A missing legacy locator cannot be upgraded from its in-process brand. */
function sourceReceipt(value: unknown): NativeSourceRepairLocator {
  if (!value || typeof value !== 'object') throw new PublicFilterRepairSourceError('owner_unavailable');
  const fields = ['bootstrap', 'execution', 'step', 'locatorDigest'] as const;
  for (const field of fields)
    if (typeof Reflect.get(value, field) !== 'string' || !Reflect.get(value, field))
      throw new PublicFilterRepairSourceError('owner_unavailable');
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)])) as NativeSourceRepairLocator;
}
function sourceRepair(repair: PublicSourceRepair | RetainedSourceRepair): RetainedSourceRepair {
  return {
    kind: repair.kind,
    locator: repair.locator,
    source: repair.source,
    projection: repair.projection,
    receipt: sourceReceipt(repair.receipt),
  };
}
function repairBody(repair: RetainedSourceRepair) {
  // Source's original projection digest excludes execution accounting. Replaying that same
  // retained page can cost different work; the owner's returned verification cost is charged below.
  const { cost: _cost, ...projection } = repair.projection;
  return { ...repair, projection };
}

/** Owner calls only: the caller must have released every local/native checkout first.
 * `charge` admits each call before I/O and charges all returned owner work before proceeding.
 * A verified empty final step is real owner closure; an empty repairs array alone proves nothing.
 */
export async function verifyPublicFilterRepairSourcePage(
  binding: PublicFilterRepairSourceBinding,
  request: NativeSourceRepairStepRead,
  expected: Readonly<{
    repairs: readonly (PublicSourceRepair | RetainedSourceRepair)[];
    frontier: string | null;
    complete: boolean;
    sourceStep?: string;
    account?: RetainedRepairPage['account'];
  }>,
  context: PublicFilterConsumerContext,
  charge: (cost?: PublicFilterCost) => void,
): Promise<RetainedRepairPage> {
  if (typeof binding.readRepairStep !== 'function' || typeof binding.readRepairReceipt !== 'function')
    throw new PublicFilterRepairSourceError('owner_unavailable');
  const owner = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch {
      throw new PublicFilterRepairSourceError(Date.now() >= context.deadline ? 'deadline' : 'owner_unavailable');
    }
  };
  charge();
  const step = await owner(() => binding.readRepairStep!(request, context));
  charge(step.cost);
  if (step.status !== 'verified') throw new PublicFilterRepairSourceError(step.reason);
  if (
    !step.step ||
    step.predecessor !== request.predecessor ||
    step.complete !== expected.complete ||
    step.frontier !== expected.frontier ||
    (step.complete ? step.frontier !== null : step.frontier !== step.step) ||
    (expected.sourceStep !== undefined && step.step !== expected.sourceStep) ||
    !Array.isArray(step.receipts) ||
    step.receipts.length > 256 ||
    expected.repairs.length > 256
  )
    throw new PublicFilterRepairSourceError('binding_mismatch');
  const repairs = expected.repairs.map(sourceRepair);
  const receipts = step.receipts.map(sourceReceipt);
  if (
    !isDeepStrictEqual(
      receipts,
      repairs.map((repair) => repair.receipt),
    )
  )
    throw new PublicFilterRepairSourceError('binding_mismatch');
  for (const [item, receipt] of receipts.entries()) {
    if (
      receipt.bootstrap !== request.bootstrap ||
      receipt.execution !== request.execution ||
      receipt.step !== step.step
    )
      throw new PublicFilterRepairSourceError('binding_mismatch');
    charge();
    const verified = await owner(() =>
      binding.readRepairReceipt!({ receipt, queried: request.queried, execution: request.execution }, context),
    );
    charge(verified.cost);
    if (verified.status !== 'verified') throw new PublicFilterRepairSourceError(verified.reason);
    if (!isDeepStrictEqual(repairBody(sourceRepair(verified.repair)), repairBody(repairs[item]!)))
      throw new PublicFilterRepairSourceError('binding_mismatch');
  }
  charge();
  const nativeAccount = await owner(() => readNativePublicFilterAccountRepair(binding, request, context));
  if (nativeAccount) charge(nativeAccount.cost);
  if (expected.account !== undefined && !isDeepStrictEqual(expected.account, nativeAccount?.account))
    throw new PublicFilterRepairSourceError('binding_mismatch');
  if (nativeAccount?.account && (repairs.length || step.complete))
    throw new PublicFilterRepairSourceError('binding_mismatch');
  return {
    sourceStep: step.step,
    predecessor: step.predecessor,
    frontier: step.frontier,
    complete: step.complete,
    repairs,
    ...(nativeAccount?.account ? { account: nativeAccount.account } : {}),
  };
}
