import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { noEffect, type CommandTransaction } from '../command/command.ts';
import { createLibraryCommandRunner } from '../library/command-support.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { RATING_IDENTITY_PAGE, RATING_IDENTITY_WORK, type RatingIdentityPageEvent } from './events.ts';
import {
  identityPageDigest,
  identityRoute,
  readIdentityFrame,
  readIdentityLimit,
  readIdentityVotes,
  sameIdentityWork,
  saveIdentityFrame,
  validateIdentityWork,
  type IdentityRepairPage,
  type IdentityWorkFrame,
  type IdentityWorkRef,
  type IdentityVoteKey,
} from './identity-work-frame.ts';
import { applyRatingIdentityPage } from './segment-identity.ts';
import {
  identityMappingDigest,
  RatingIdentityVotePending,
  unavailableRatingIdentityProducer,
  validIdentityAuthority,
  type RatingIdentityProducer,
} from './segment-identity-guard.ts';
import readState from './voter-state-read.sql';
import readReceipt from './identity-repair-receipt-read.sql';
import insertReceipt from './identity-repair-receipt-insert.sql';

export type RatingRepairReceipt = IdentityWorkRef & {
  pageId: string;
  digest: string;
  transactionId: string;
  checkpoint: IdentityVoteKey | null;
  terminal: boolean;
  mode: IdentityRepairPage['mode'];
  obligationId: string | null;
  mappingDigest: string | null;
};
type Pending = { status: 'pending'; reason: string };
type FrameResult = { status: 'admitted'; frame: IdentityWorkFrame } | Pending;
type SelectionResult = { status: 'selected'; page: IdentityRepairPage } | Pending;
type CommitResult = { status: 'committed'; receipt: RatingRepairReceipt } | Pending;
class RepairPending extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** One explicit bounded step per call. The controller owns scheduling, reconciliation and replacement.
 * The producer is trusted service configuration, never input from a caller or a released observation.
 */
export function createRatingIdentityRepairCommands(config: {
  pool: Pool;
  clock?: KernelClock;
  producer?: RatingIdentityProducer;
}) {
  // Same native account, scope and authentication-epoch authorization as ordinary Rating vote commands.
  const runner = createLibraryCommandRunner(config);
  const producer = config.producer ?? unavailableRatingIdentityProducer;
  const owner = (actor: Actor): string => {
    if (actor.kind !== 'account' || !actor.scopes.includes('rating:vote')) throw new GrantDeniedError();
    identityRoute(actor.accountId);
    return actor.accountId;
  };
  const run = <T extends FrameResult | SelectionResult>(
    actor: Actor,
    kind: 'admit' | 'select' | 'cancel',
    input: unknown,
    key: string,
    body: (tx: CommandTransaction, transactionId: string) => Promise<T>,
  ) => {
    const voterId = owner(actor);
    return runner.ownAccount<T>(
      actor,
      { action: 'rating:vote', kind: `rating.identity.${kind}`, requestKey: key, input },
      async (tx, command) => {
        const value = await body(tx, command.transactionId);
        if (value.status === 'pending') return noEffect(value);
        const ref = value.status === 'selected' ? value.page : value.frame;
        return {
          value,
          events: [
            {
              type: RATING_IDENTITY_WORK,
              subject: voterId,
              data: { voterId, workId: ref.workId, generation: ref.generation, action: kind },
            },
          ],
        };
      },
    );
  };
  const eligible = async (tx: CommandTransaction, voterId: string) => {
    const state = await readState.run(tx, { route: identityRoute(voterId), voter_id: voterId });
    return !state || state.state === 'eligible' || state.state === 'returning';
  };

  async function admit(actor: Actor, input: { workId: string; expectedGeneration: string | null }, key: string) {
    const voterId = owner(actor);
    validateIdentityWork({ workId: input.workId, generation: input.expectedGeneration ?? '1' });
    return run<FrameResult>(actor, 'admit', input, key, async (tx) => {
      const prior = await readIdentityFrame(tx, voterId);
      if ((prior?.generation ?? null) !== input.expectedGeneration)
        return { status: 'pending', reason: 'stale-admission' };
      if (prior?.state === 'active') return { status: 'pending', reason: 'active-work' };
      const frame: IdentityWorkFrame = {
        workId: input.workId,
        generation: (BigInt(prior?.generation ?? '0') + 1n).toString(),
        state: 'active',
        mode: 'repair',
        cursor: null,
        through: await readIdentityLimit(tx, voterId),
        selected: null,
      };
      await saveIdentityFrame(tx, voterId, frame);
      return { status: 'admitted', frame };
    });
  }

  async function select(actor: Actor, ref: IdentityWorkRef, key: string) {
    const voterId = owner(actor);
    validateIdentityWork(ref);
    return run<SelectionResult>(actor, 'select', ref, key, async (tx, transactionId) => {
      const frame = await readIdentityFrame(tx, voterId);
      if (!sameIdentityWork(frame, ref) || frame.state !== 'active') return { status: 'pending', reason: 'stale-work' };
      if (frame.selected) return { status: 'selected', page: frame.selected };
      const votes = await readIdentityVotes(tx, voterId, frame.cursor, frame.through);
      const last = votes.at(-1);
      const page: IdentityRepairPage = {
        ...ref,
        pageId: transactionId,
        voterId,
        mode: frame.mode,
        after: frame.cursor,
        through: frame.through,
        next: last ? { questionId: last.questionId, targetId: last.targetId } : frame.cursor,
        terminal: votes.length === 0,
        votes,
        digest: '',
      };
      page.digest = identityPageDigest(page);
      frame.selected = page;
      await saveIdentityFrame(tx, voterId, frame);
      return { status: 'selected', page };
    });
  }

  async function commit(actor: Actor, input: IdentityWorkRef & { pageId: string; digest: string }, key: string) {
    const voterId = owner(actor);
    validateIdentityWork(input);
    if (routeOf(input.pageId) === null || !/^[0-9a-f]{64}$/.test(input.digest))
      throw new TypeError('Invalid Rating identity page');
    try {
      return await runner.ownAccount<CommitResult>(
        actor,
        { action: 'rating:vote', kind: 'rating.identity.commit', requestKey: key, input },
        async (tx, command) => {
          const route = identityRoute(voterId);
          const receipt = (await tx.query<RatingRepairReceipt>(readReceipt.sql, [route, voterId, input.pageId]))
            .rows[0];
          if (receipt) {
            if (
              receipt.digest !== input.digest ||
              receipt.workId !== input.workId ||
              receipt.generation !== input.generation
            )
              return noEffect<CommitResult>({ status: 'pending', reason: 'receipt-binding-mismatch' });
            return noEffect<CommitResult>({ status: 'committed', receipt });
          }
          const frame = await readIdentityFrame(tx, voterId);
          if (!sameIdentityWork(frame, input) || frame.state !== 'active') throw new RepairPending('stale-work');
          const page = frame.selected;
          if (
            !page ||
            page.pageId !== input.pageId ||
            page.digest !== input.digest ||
            identityPageDigest(page) !== input.digest
          )
            throw new RepairPending('stale-page');
          const votes = await readIdentityVotes(tx, voterId, page.after, page.through);
          if (identityPageDigest({ ...page, votes }) !== page.digest) {
            frame.selected = null;
            await saveIdentityFrame(tx, voterId, frame);
            return {
              value: { status: 'pending', reason: 'vote-changed' },
              events: [
                {
                  type: RATING_IDENTITY_WORK,
                  subject: voterId,
                  data: { voterId, workId: frame.workId, generation: frame.generation, action: 'invalidate' },
                },
              ],
            };
          }
          const active = await eligible(tx, voterId);
          if (active !== (page.mode === 'repair')) throw new RepairPending('voter-eligibility-changed');
          const authority = page.mode === 'repair' ? await producer.hold(tx, page) : null;
          if (authority?.status === 'pending') throw new RepairPending(authority.reason);
          if (authority?.status === 'current' && !validIdentityAuthority(page, authority))
            throw new RepairPending('invalid-exact-currentness');
          const events = await applyRatingIdentityPage(
            tx,
            page,
            authority?.status === 'current' ? authority.mappings : [],
          );
          const result: RatingRepairReceipt = {
            ...input,
            transactionId: command.transactionId,
            checkpoint: page.next,
            terminal: page.terminal,
            mode: page.mode,
            obligationId: authority?.status === 'current' ? authority.obligationId : null,
            mappingDigest: authority?.status === 'current' ? identityMappingDigest(authority.mappings) : null,
          };
          await tx.query(insertReceipt.sql, [
            route,
            voterId,
            page.pageId,
            page.workId,
            page.generation,
            page.digest,
            command.transactionId,
            JSON.stringify(page.next),
            page.terminal,
            page.mode,
            result.obligationId,
            result.mappingDigest,
          ]);
          frame.cursor = page.next;
          frame.selected = null;
          if (page.terminal) frame.state = 'complete';
          await saveIdentityFrame(tx, voterId, frame);
          if (
            authority?.status === 'current' &&
            !(await producer.complete(tx, {
              page,
              obligationId: authority.obligationId,
              mappingDigest: result.mappingDigest!,
              transactionId: command.transactionId,
            }))
          )
            throw new RepairPending('semantic-repair-obligation-handoff-pending');
          const data: RatingIdentityPageEvent = {
            voterId,
            workId: page.workId,
            generation: page.generation,
            pageId: page.pageId,
            digest: page.digest,
            terminal: page.terminal,
            mode: page.mode,
          };
          return {
            value: { status: 'committed', receipt: result },
            events: [...events, { type: RATING_IDENTITY_PAGE, subject: voterId, data }],
          };
        },
      );
    } catch (error) {
      if (error instanceof RepairPending || error instanceof RatingIdentityVotePending)
        return { value: { status: 'pending', reason: error.reason } as Pending };
      throw error;
    }
  }

  async function cancel(actor: Actor, ref: IdentityWorkRef, key: string) {
    const voterId = owner(actor);
    validateIdentityWork(ref);
    return run<FrameResult>(actor, 'cancel', ref, key, async (tx) => {
      const frame = await readIdentityFrame(tx, voterId);
      if (!sameIdentityWork(frame, ref)) return { status: 'pending', reason: 'stale-work' };
      if (await eligible(tx, voterId)) {
        frame.state = 'cancelled';
        frame.selected = null;
      } else if (frame.mode !== 'withdrawal') {
        frame.state = 'active';
        frame.mode = 'withdrawal';
        frame.selected = null;
        frame.cursor = null;
        frame.through = await readIdentityLimit(tx, voterId);
      }
      await saveIdentityFrame(tx, voterId, frame);
      return { status: 'admitted', frame };
    });
  }
  return { admit, select, commit, cancel };
}
