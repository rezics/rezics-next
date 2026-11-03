import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { COMMUNITY_EVENTS } from '../community/events.ts';
import type { Effect } from '../events/effects.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import readRealm from './voter-realm-read.sql';
import readCapped from './voter-realms-capped.sql';
import insertRealm from './voter-realm-insert.sql';
import updateRealm from './voter-realm-update.sql';
import deleteRealm from './voter-realm-delete.sql';
import promoteRealm from './voter-realm-promote.sql';
import ensureVoterState from './voter-state-ensure.sql';
import readVoterState from './voter-state-read.sql';
import { advanceRatingSource, ratingSourcePosition } from './realm-rank-delivery.ts';

export const VOTER_REALM_CAP = 100;
const MEMBERSHIP = 'com.rezics.community.realm.membership.v1';
const CHANGED = 'com.rezics.rating.voter-realm.changed.v1';
type Address = { route: number; voterId: string; realmId: string };
export type VoterRealmJob = {
  voterId: string;
  realmId: string;
  transitionId: string;
  direction: 'adding' | 'removing';
};

function parameters(input: Address) {
  return { route: input.route, voter_id: input.voterId, realm_id: input.realmId };
}

async function deleteAndPromote(
  tx: CommandTransaction,
  input: Address,
  transitionId: string,
): Promise<VoterRealmJob | null> {
  await deleteRealm.run(tx, parameters(input));
  const promoted = await promoteRealm.run(tx, {
    route: input.route,
    voter_id: input.voterId,
    transition_id: transitionId,
  });
  const row = promoted[0];
  return row
    ? { voterId: input.voterId, realmId: row.realmId, transitionId: row.transitionId, direction: 'adding' }
    : null;
}

/** Called by the removal pager in its voter-partition command, after its final page has been applied. */
export async function finishVoterRealmRemoval(
  tx: CommandTransaction,
  input: Address & { transitionId?: string },
): Promise<VoterRealmJob[]> {
  const row = await readRealm.run(tx, parameters(input));
  if (!row || row.state !== 'removing') throw new Error('Realm removal is not in progress');
  const transitionId = input.transitionId ?? Bun.randomUUIDv7();
  if (!row.rejoin) {
    const promoted = await deleteAndPromote(tx, input, transitionId);
    return promoted ? [promoted] : [];
  }
  await updateRealm.run(tx, {
    ...parameters(input),
    state: 'adding',
    cursor_question_id: null,
    cursor_target_id: null,
    limit_question_id: null,
    limit_target_id: null,
    rejoin: false,
    transition_id: transitionId,
  });
  return [{ voterId: input.voterId, realmId: input.realmId, transitionId, direction: 'adding' }];
}

/** Membership effects and vote writes serialize on the same voter partition. */
export function createVoterRealmsEffect(pool: Pool): Effect {
  return {
    name: 'rating_voter_realms',
    types: [MEMBERSHIP],
    async run(event) {
      if (event.type !== MEMBERSHIP || !Value.Check(COMMUNITY_EVENTS[MEMBERSHIP], event.data))
        throw new TypeError('Invalid Realm membership event');
      const { accountId: voterId, realmId, role, at } = event.data;
      const route = routeOf(voterId);
      if (route === null || routeOf(realmId) === null) throw new TypeError('Invalid Realm membership address');
      const address = { route, voterId, realmId };
      await runCommand(
        pool,
        {
          partition: partitionOf(route),
          receipt: {
            actorAccountId: voterId,
            kind: 'rating.voter-realm.membership',
            key: createHash('sha256')
              .update(canonicalize([event.source, event.id])!)
              .digest('hex'),
            digest: createHash('sha256').update(canonicalize(event.data)!).digest(),
          },
        },
        async (tx, { transactionId }) => {
          if (
            !(await advanceRatingSource(
              tx,
              route,
              'membership',
              [voterId, realmId],
              ratingSourcePosition(event, realmId),
            ))
          )
            return { value: null, events: [] };
          const row = await readRealm.run(tx, parameters(address));
          const changedRealms = new Set<string>([realmId]);
          if (!row && role === 'member') {
            const capped = await readCapped.run(tx, { route, voter_id: voterId });
            await insertRealm.run(tx, {
              ...parameters(address),
              joined_at: at,
              state: capped.length < VOTER_REALM_CAP ? 'adding' : 'uncounted',
              transition_id: transactionId,
            });
          } else if (row) {
            if (
              role === null &&
              (row.state === 'uncounted' || (row.state === 'adding' && row.cursorQuestionId === null))
            ) {
              // Only a capped departure frees a slot.
              if (row.state === 'uncounted') await deleteRealm.run(tx, parameters(address));
              else {
                const promoted = await deleteAndPromote(tx, address, transactionId);
                if (promoted) changedRealms.add(promoted.realmId);
              }
            } else if (row.state === 'removing' || role === null) {
              const startsRemoval = role === null && row.state !== 'removing';
              await updateRealm.run(tx, {
                ...parameters(address),
                state: 'removing',
                cursor_question_id: row.state === 'removing' ? row.cursorQuestionId : null,
                cursor_target_id: row.state === 'removing' ? row.cursorTargetId : null,
                limit_question_id:
                  row.state === 'removing' ? row.limitQuestionId : row.state === 'adding' ? row.cursorQuestionId : null,
                limit_target_id:
                  row.state === 'removing' ? row.limitTargetId : row.state === 'adding' ? row.cursorTargetId : null,
                rejoin: role === 'member',
                transition_id: startsRemoval ? transactionId : row.transitionId,
              });
            }
          }
          return {
            value: null,
            events: [...changedRealms].map((changedRealmId) => ({
              type: CHANGED,
              subject: voterId,
              data: { voterId, realmId: changedRealmId },
            })),
          };
        },
      );
    },
  };
}

type VoteKey = { questionId: string; targetId: string };
export type VoterRealmPopulationRow = {
  realmId: string;
  state: string;
  cursorQuestionId: string | null;
  cursorTargetId: string | null;
  limitQuestionId: string | null;
  limitTargetId: string | null;
};

function compare(a: VoteKey, b: VoteKey): number {
  return a.questionId < b.questionId
    ? -1
    : a.questionId > b.questionId
      ? 1
      : a.targetId < b.targetId
        ? -1
        : a.targetId > b.targetId
          ? 1
          : 0;
}

/** Resolve the populations in which one key currently counts, including in-flight Realm cursors. */
export function populationsForVoteKey(input: VoteKey, rows: readonly VoterRealmPopulationRow[]): string[] {
  const populations: string[] = [];
  for (const row of rows) {
    const cursor =
      row.cursorQuestionId === null ? null : { questionId: row.cursorQuestionId, targetId: row.cursorTargetId! };
    const limit =
      row.limitQuestionId === null ? null : { questionId: row.limitQuestionId, targetId: row.limitTargetId! };
    if (
      row.state === 'counted' ||
      (row.state === 'adding' && cursor !== null && compare(input, cursor) <= 0) ||
      (row.state === 'removing' &&
        (cursor === null || compare(input, cursor) > 0) &&
        (limit === null || compare(input, limit) <= 0))
    )
      populations.push(row.realmId);
  }
  return populations;
}

/** Read only the capped set, in the same transaction as the vote and its emitted populations. */
export async function readVotePopulations(
  tx: CommandTransaction,
  input: { route: number; voterId: string; includeLeaving?: boolean } & VoteKey,
): Promise<string[]> {
  await ensureVoterState.run(tx, { route: input.route, voter_id: input.voterId });
  const eligibility = await readVoterState.run(tx, { route: input.route, voter_id: input.voterId });
  if (eligibility?.state === 'ineligible') return [];
  const rows = await readCapped.run(tx, { route: input.route, voter_id: input.voterId });
  if (eligibility?.state === 'leaving') {
    if (!input.includeLeaving) return [];
    const saved = new Set(eligibility.populations ?? []);
    return [
      ...(saved.has(GLOBAL_CONTEXT.id) ? [GLOBAL_CONTEXT.id] : []),
      ...populationsForVoteKey(input, rows).filter((realmId) => saved.has(realmId)),
    ];
  }
  return [GLOBAL_CONTEXT.id, ...populationsForVoteKey(input, rows)];
}
