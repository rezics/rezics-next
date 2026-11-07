import type { Actor } from '../request/access.ts';
import { newId } from '../route/route.ts';
import { createRatingIdentityRepairCommands, type RatingRepairReceipt } from './identity-repair.ts';
import {
  identityRoute,
  validateIdentityWork,
  type IdentityRepairPage,
  type IdentityWorkRef,
} from './identity-work-frame.ts';

export const IDENTITY_REPAIR_MAX_PAGES = 16;

type Commands = ReturnType<typeof createRatingIdentityRepairCommands>;
type Pending = Readonly<{ status: 'pending'; reason: string }>;
type Committed = Readonly<{ status: 'committed'; receipt: RatingRepairReceipt }>;

export type IdentityRepairPageStep =
  | Readonly<{ status: 'committed'; page: IdentityRepairPage; receipt: RatingRepairReceipt }>
  | Pending;

export type IdentityRepairGenerationResult =
  | Readonly<{
      status: 'complete';
      ref: IdentityWorkRef;
      receipts: readonly RatingRepairReceipt[];
      pages: number;
    }>
  | Readonly<{
      status: 'pending';
      reason: string;
      ref: IdentityWorkRef | null;
      receipts: readonly RatingRepairReceipt[];
      pages: number;
    }>;

function asPending(value: { status: string; reason?: string }): Pending | null {
  if (value.status !== 'pending') return null;
  return { status: 'pending', reason: value.reason ?? 'pending' };
}

/** One admitted generation: select and commit each durable page, including the empty terminal page. */
export async function runIdentityRepairGeneration(
  commands: Commands,
  actor: Actor,
  ref: IdentityWorkRef,
  nextKey: () => string,
  pageLimit = IDENTITY_REPAIR_MAX_PAGES,
): Promise<IdentityRepairGenerationResult> {
  validateIdentityWork(ref);
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > IDENTITY_REPAIR_MAX_PAGES)
    throw new RangeError('Rating identity repair page limit is outside its bound');
  const receipts: RatingRepairReceipt[] = [];
  for (let pages = 0; pages < pageLimit; pages++) {
    const selected = (await commands.select(actor, ref, nextKey())).value;
    const pendingSelect = asPending(selected);
    if (pendingSelect)
      return { status: 'pending', reason: pendingSelect.reason, ref, receipts: Object.freeze([...receipts]), pages };
    if (selected.status !== 'selected')
      return { status: 'pending', reason: 'stale-work', ref, receipts: Object.freeze([...receipts]), pages };
    const page = selected.page;
    const committed = await commitSelected(commands, actor, page, nextKey);
    if (committed.status === 'pending')
      return { status: 'pending', reason: committed.reason, ref, receipts: Object.freeze([...receipts]), pages };
    receipts.push(committed.receipt);
    if (committed.receipt.terminal)
      return { status: 'complete', ref, receipts: Object.freeze(receipts), pages: pages + 1 };
  }
  return {
    status: 'pending',
    reason: 'identity-repair-page-limit',
    ref,
    receipts: Object.freeze(receipts),
    pages: pageLimit,
  };
}

async function commitSelected(
  commands: Commands,
  actor: Actor,
  page: IdentityRepairPage,
  nextKey: () => string,
): Promise<Committed | Pending> {
  const binding = {
    workId: page.workId,
    generation: page.generation,
    pageId: page.pageId,
    digest: page.digest,
  };
  const first = (await commands.commit(actor, binding, nextKey())).value;
  if (first.status === 'committed') return first;
  if (first.status === 'pending' && first.reason === 'vote-changed') {
    const refreshed = (await commands.select(actor, { workId: page.workId, generation: page.generation }, nextKey()))
      .value;
    const pending = asPending(refreshed);
    if (pending) return pending;
    if (refreshed.status !== 'selected') return { status: 'pending', reason: 'stale-work' };
    const retry = (
      await commands.commit(
        actor,
        {
          workId: refreshed.page.workId,
          generation: refreshed.page.generation,
          pageId: refreshed.page.pageId,
          digest: refreshed.page.digest,
        },
        nextKey(),
      )
    ).value;
    if (retry.status === 'committed') return retry;
    return asPending(retry) ?? { status: 'pending', reason: 'stale-page' };
  }
  return asPending(first) ?? { status: 'pending', reason: 'stale-page' };
}

/** Admit a generation and run its pages. Replacement must match the expected generation. */
export async function admitIdentityRepairGeneration(
  commands: Commands,
  actor: Actor,
  input: Readonly<{ workId: string; expectedGeneration: string | null }>,
  nextKey: () => string,
  pageLimit = IDENTITY_REPAIR_MAX_PAGES,
): Promise<IdentityRepairGenerationResult> {
  const admitted = (await commands.admit(actor, input, nextKey())).value;
  const pending = asPending(admitted);
  if (pending) return { status: 'pending', reason: pending.reason, ref: null, receipts: Object.freeze([]), pages: 0 };
  if (admitted.status !== 'admitted')
    return { status: 'pending', reason: 'stale-admission', ref: null, receipts: Object.freeze([]), pages: 0 };
  const ref = { workId: admitted.frame.workId, generation: admitted.frame.generation };
  return runIdentityRepairGeneration(commands, actor, ref, nextKey, pageLimit);
}

/** A later identity change or vote beyond the captured upper key starts a new generation. */
export async function continueIdentityRepairGeneration(
  commands: Commands,
  actor: Actor,
  previous: IdentityWorkRef,
  nextKey: () => string,
  pageLimit = IDENTITY_REPAIR_MAX_PAGES,
): Promise<IdentityRepairGenerationResult> {
  validateIdentityWork(previous);
  if (actor.kind !== 'account') throw new TypeError('Invalid Rating identity voter');
  return admitIdentityRepairGeneration(
    commands,
    actor,
    { workId: newId(identityRoute(actor.accountId)), expectedGeneration: previous.generation },
    nextKey,
    pageLimit,
  );
}

export function identityRepairPageBinding(page: IdentityRepairPage) {
  return Object.freeze({
    workId: page.workId,
    generation: page.generation,
    pageId: page.pageId,
    digest: page.digest,
  });
}
