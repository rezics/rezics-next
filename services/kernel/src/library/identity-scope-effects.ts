import { ProblemError } from '../http/problem.ts';
import type { Pool } from 'pg';
import { currentCommand, currentCommandResources, noEffect, type CommandTransaction } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from './collection-source-work.ts';
import { identityJobPartition } from '../semantic/identity-epoch-store.ts';
import { isPrepaidIdentitySourceConsumerMaintenance } from '../semantic/identity-source-consumer-maintenance.ts';
import {
  currentLibraryIdentityPlan,
  equalLibraryIdentityValue,
  libraryIdentityCommand,
  readLibraryIdentityPlan,
  validateLibraryIdentityPlanKey,
} from './identity-native-planner.ts';
import type { LibraryIdentityPlan } from './identity-native-planner-types.ts';
import {
  allowance as remainingAllowance,
  bindLibraryIdentityPrepaidWork,
  bindLibraryIdentityDeadline,
  currentLibraryIdentityWork,
  libraryIdentityFootprint,
  withLibraryIdentityWork,
  consumeLibraryIdentitySelectedCall,
} from './identity-native-planner-work.ts';
import sealRead from './identity-scope-effects-seal.sql';
import { libraryIdentityBoundedEffectPageSQL } from './identity-native-planner-projection.ts';
import type { IdentityJobRef, IdentityFrontier, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type {
  IdentityReceivingSelection,
  IdentityReceivingDisposition,
} from '../semantic/identity-receiving-effects-types.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { WorkAllowance, WorkReceipt } from './collection-source.ts';

export type LibraryScopeEffectsKey = Readonly<{
  job: IdentityJobRef;
  sourceIdentity: NativeSourceIdentity;
  scope: string;
}>;
export type LibraryExpectedEffectAfter = Readonly<{
  effectKey: string;
  disposition: IdentityReceivingDisposition;
}>;
declare const scopeEffectsSeal: unique symbol;
export type LibraryScopeEffectSeal = Readonly<{
  [scopeEffectsSeal]: true;
  key: LibraryScopeEffectsKey;
  generation: string;
  version: string;
  frontier: IdentityFrontier;
  receipt: IdentityNativeReceipt;
}>;
export type LibraryScopeEffectsPage =
  | Readonly<{
      status: 'pending';
      rows: readonly IdentityReceivingSelection[];
      after: LibraryExpectedEffectAfter | null;
      work: WorkReceipt;
    }>
  | Readonly<{
      status: 'sealed';
      rows: readonly IdentityReceivingSelection[];
      after: LibraryExpectedEffectAfter | null;
      exhausted: boolean;
      seal: LibraryScopeEffectSeal;
      work: WorkReceipt;
    }>
  | Readonly<{ status: 'unavailable'; work: WorkReceipt }>;

/** Native expected selections only. Sealed pages still require exhaustive consumer pagination.
 * Missing/changed captures and unsealed native plans cannot become an empty complete observation.
 */
// A returned seal retains the exact input identity, including its native scope discriminant.
export function readLibraryScopeEffectsPage<Source extends NativeSourceIdentity>(
  pool: Pool,
  input: LibraryScopeEffectsKey &
    Readonly<{
      sourceIdentity: Source;
      after: LibraryExpectedEffectAfter | null;
      limit: number;
      allowance: WorkAllowance;
      deadline: number;
    }>,
): Promise<
  | Exclude<LibraryScopeEffectsPage, { status: 'sealed' }>
  | (Extract<LibraryScopeEffectsPage, { status: 'sealed' }> &
      Readonly<{
        seal: LibraryScopeEffectSeal & Readonly<{ key: LibraryScopeEffectsKey & Readonly<{ sourceIdentity: Source }> }>;
      }>)
>;
export async function readLibraryScopeEffectsPage(
  pool: Pool,
  input: LibraryScopeEffectsKey &
    Readonly<{
      after: LibraryExpectedEffectAfter | null;
      limit: number;
      allowance: WorkAllowance;
      deadline: number;
    }>,
): Promise<LibraryScopeEffectsPage> {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool))
    throw new TypeError('Selected Library original requires readLibraryScopeEffectsPageWithWork');
  const work = bindLibraryIdentityDeadline(new NativeCollectionWork(input.allowance, input.deadline), input.deadline);
  return executePage(pool, input, work);
}

export type LibraryScopeEffectsPageInput<Source extends NativeSourceIdentity = NativeSourceIdentity> =
  LibraryScopeEffectsKey & Readonly<{
    sourceIdentity: Source;
    after: LibraryExpectedEffectAfter | null;
    limit: number;
    deadline: number;
  }>;
export type LibraryScopeEffectsPageFor<Source extends NativeSourceIdentity> =
  | Exclude<LibraryScopeEffectsPage, { status: 'sealed' }>
  | (Extract<LibraryScopeEffectsPage, { status: 'sealed' }> & Readonly<{
      seal: LibraryScopeEffectSeal & Readonly<{
        key: LibraryScopeEffectsKey & Readonly<{ sourceIdentity: Source }>;
      }>;
    }>);

/** Use the live owner's exact prepaid ledger. The input carries no funding authority. */
export function readLibraryScopeEffectsPageWithWork<Source extends NativeSourceIdentity>(
  pool: Pool,
  input: LibraryScopeEffectsPageInput<Source>,
  work: NativeCollectionWork,
): Promise<LibraryScopeEffectsPageFor<Source>>;
export async function readLibraryScopeEffectsPageWithWork(
  pool: Pool,
  input: LibraryScopeEffectsPageInput,
  work: NativeCollectionWork,
): Promise<LibraryScopeEffectsPage> {
  bindLibraryIdentityPrepaidWork(pool, work, input.deadline);
  consumeLibraryIdentitySelectedCall(pool, work, 'effectPages');
  if (isPrepaidIdentitySourceConsumerMaintenance(pool) && input.limit !== 1)
    throw new TypeError('Selected Library original requires limit1');
  return executePage(pool, { ...input, allowance: remainingAllowance(work) }, work);
}
async function executePage(
  pool: Pool,
  input: LibraryScopeEffectsPageInput & { allowance: WorkAllowance },
  work: NativeCollectionWork,
): Promise<LibraryScopeEffectsPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new TypeError('Library expected-effects pages require a limit from 1 to 100');
  try {
    return await withLibraryIdentityWork(pool, work, () => readPage(pool, input, work));
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'dependency_unavailable')
      return { status: 'unavailable', work: work.receipt() };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}

async function readPage(
  pool: Pool,
  input: LibraryScopeEffectsKey & {
    after: LibraryExpectedEffectAfter | null;
    limit: number;
    allowance: WorkAllowance;
    deadline: number;
  },
  l: NativeCollectionWork,
): Promise<LibraryScopeEffectsPage> {
  // A depleted reservation cannot acquire a connection, even for an absent native source.
  if (
    input.deadline <= Date.now() ||
    input.allowance.remaining.statements < 1 ||
    input.allowance.remaining.nativePoints < 1 ||
    input.allowance.remaining.nativeRows < 1 ||
    input.allowance.remaining.bytes < 1
  )
    return { status: 'unavailable', work: l.receipt() };
  validateLibraryIdentityPlanKey(input);
  const sourceIdentity = input.sourceIdentity;
  if (sourceIdentity.scope === 'public_output' || identityJobPartition(input.job) !== partitionOf(sourceIdentity.route))
    return { status: 'unavailable', work: l.receipt() };
  if (
    input.after &&
    (!input.after.effectKey ||
      Buffer.byteLength(input.after.effectKey) > 256 ||
      !['OLD', 'NEW', 'first-apply', 'handoff'].includes(input.after.disposition))
  )
    throw new TypeError('Invalid native expected-effects continuation');
  const limit = Math.min(input.limit, l.available('candidateKeys'));
  if (limit < 1) return { status: 'pending', rows: [], after: input.after, work: l.receipt() };
  const page = await libraryIdentityCommand(pool, l, partitionOf(input.sourceIdentity.route), async (tx) => {
    const plan = await readLibraryIdentityPlan(tx, input, true);
    if (!plan || plan.state !== 'sealed' || !(await currentLibraryIdentityPlan(tx, input, plan, l)))
      return noEffect(null);
    const receipt = await nativeSealReceipt(tx, plan);
    if (!receipt) return noEffect(null);
    const rows = (
      await tx.query<{ effect_key: string; disposition: IdentityReceivingDisposition; original: string }>(
        libraryIdentityBoundedEffectPageSQL,
        [
          plan.route,
          plan.collection_id,
          plan.plan_key,
          input.after?.effectKey ?? '',
          input.after?.disposition ?? '',
          limit,
        ],
      )
    ).rows;
    if (rows.some((row) => typeof row.effect_key !== 'string' || !/^library-native:[0-9a-f]{64}$/.test(row.effect_key)))
      throw new TypeError('Invalid native Library effect key projection');
    const selected: IdentityReceivingSelection[] = rows.map((row) => ({
      job: input.job,
      original: row.original,
      effectKey: row.effect_key,
      owner: sourceIdentity.accountId,
      sourceId: input.sourceIdentity.collectionId,
      scope: input.scope,
      disposition: row.disposition,
      capture: { identity: input.sourceIdentity, frontier: plan.capture_frontier },
    }));
    const seal = {
      key: { job: input.job, sourceIdentity: input.sourceIdentity, scope: input.scope },
      generation: plan.generation,
      version: plan.version,
      frontier: plan.frontier,
      receipt,
    } as LibraryScopeEffectSeal;
    const last = rows.at(-1);
    return noEffect({
      status: 'sealed' as const,
      rows: selected,
      after: last ? { effectKey: last.effect_key, disposition: last.disposition } : input.after,
      exhausted: rows.length < limit,
      seal,
    });
  });
  return page ? { ...page, work: l.receipt() } : { status: 'pending', rows: [], after: input.after, work: l.receipt() };
}

async function nativeSealReceipt(
  tx: CommandTransaction,
  plan: LibraryIdentityPlan,
): Promise<IdentityNativeReceipt | null> {
  const row = (
    await tx.query<{ partition: number; epoch: number; position: string; transactionId: string }>(sealRead.sql, [
      plan.route,
      plan.collection_id,
      plan.plan_key,
    ])
  ).rows[0];
  return row ? { ...row, position: BigInt(row.position) } : null;
}

/** SAME Source-local Core client only. No foreign receiving lookup, checkout or supplied records[] here. */
export async function verifyLibraryScopeEffectsSeal(
  tx: CommandTransaction,
  key: LibraryScopeEffectsKey,
  seal: LibraryScopeEffectSeal,
): Promise<boolean> {
  const command = currentCommand(tx);
  if (!seal || !seal.key || !seal.receipt || !seal.frontier) return false;
  if (
    command.partition !== partitionOf(key.sourceIdentity.route) ||
    identityJobPartition(key.job) !== command.partition ||
    !equalLibraryIdentityValue({ job: key.job, sourceIdentity: key.sourceIdentity, scope: key.scope }, seal.key)
  )
    return false;
  const ledger = currentLibraryIdentityWork(tx);
  if (!ledger) return false;
  const resources = currentCommandResources(tx);
  consumeLibraryIdentitySelectedCall(resources.pool, ledger, 'verification');
  return withLibraryIdentityWork(resources.pool, ledger, () => instrumentNativeCollectionWork(
    resources.pool, ledger, (sql, values) => libraryIdentityFootprint(sql, values, ledger),
    () => verifyCurrentSeal(tx, key, seal, ledger), tx,
  ));
}
async function verifyCurrentSeal(
  tx: CommandTransaction, key: LibraryScopeEffectsKey, seal: LibraryScopeEffectSeal, ledger: NativeCollectionWork,
): Promise<boolean> {
  const plan = await readLibraryIdentityPlan(tx, key, true);
  if (
    !plan ||
    plan.state !== 'sealed' ||
    plan.generation !== seal.generation ||
    plan.version !== seal.version ||
    !equalLibraryIdentityValue(plan.frontier, seal.frontier)
  )
    return false;
  const receipt = await nativeSealReceipt(tx, plan);
  if (!receipt || !equalLibraryIdentityValue(receipt, seal.receipt)) return false;
  return currentLibraryIdentityPlan(tx, key, plan, ledger);
}
