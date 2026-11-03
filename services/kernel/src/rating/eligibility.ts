import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { ACCESS_EVENTS } from '../access/events.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { RatingSegmentJob } from './segment-job.ts';
import ensureVoterState from './voter-state-ensure.sql';
import readVoterState from './voter-state-read.sql';
import readVoterStateJob from './voter-state-job-read.sql';
import readCapped from './voter-realms-capped.sql';
import updateVoterState from './voter-state-update.sql';
import { advanceRatingSource, ratingSourcePosition } from './realm-rank-delivery.ts';

export type RatingEligibilityJob = {
  voterId: string;
  eligibility: true;
  direction: 'adding' | 'removing';
  transitionId: string;
  populations: string[];
};

const SUSPENDED = 'com.rezics.access.account.suspended.v1';
const REINSTATED = 'com.rezics.access.account.reinstated.v1';
const TOMBSTONED = 'com.rezics.access.account-tombstoned.v1';
const ELIGIBILITY_CHANGED = 'com.rezics.rating.eligibility.changed.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type EligibilityState = 'eligible' | 'leaving' | 'ineligible' | 'returning';
type EligibilityEvent = typeof SUSPENDED | typeof REINSTATED | typeof TOMBSTONED;

function validId(value: string): boolean {
  return UUID.test(value) && routeOf(value) !== null;
}

function eventState(type: EligibilityEvent, current: EligibilityState, purgeVotes: boolean) {
  if (type === TOMBSTONED) {
    if (purgeVotes && current === 'leaving') return null;
    return { state: 'leaving' as const, direction: 'removing' as const, purgeVotes: true };
  }
  if (type === SUSPENDED) {
    if (current !== 'eligible' && current !== 'returning') return null;
    return { state: 'leaving' as const, direction: 'removing' as const, purgeVotes: false };
  }
  if ((current === 'leaving' && !purgeVotes) || current === 'ineligible')
    return { state: 'returning' as const, direction: 'adding' as const, purgeVotes: false };
  return null;
}

/** Consume account eligibility events in the voter's partition and start one shared segment workflow. */
export function createVoterEligibilityEffect(pool: Pool): Effect {
  return {
    name: 'rating_voter_eligibility',
    types: [SUSPENDED, REINSTATED, TOMBSTONED],
    async run(event: CloudEvent) {
      const type = event.type as EligibilityEvent;
      const schema =
        type === SUSPENDED
          ? ACCESS_EVENTS[SUSPENDED]
          : type === REINSTATED
            ? ACCESS_EVENTS[REINSTATED]
            : ACCESS_EVENTS[TOMBSTONED];
      if (!Value.Check(schema, event.data)) throw new TypeError('Invalid account eligibility event');
      const accountId = (event.data as { accountId: string }).accountId;
      const route = routeOf(accountId);
      if (route === null || event.subject !== accountId) throw new TypeError('Invalid account eligibility address');
      await runCommand(
        pool,
        {
          partition: partitionOf(route),
          receipt: {
            actorAccountId: accountId,
            kind: 'rating.voter-eligibility.event',
            key: createHash('sha256')
              .update(canonicalize([event.source, event.id])!)
              .digest('hex'),
            digest: createHash('sha256').update(canonicalize(event.data)!).digest(),
          },
        },
        async (tx, command) => {
          if (
            !(await advanceRatingSource(tx, route, 'eligibility', [accountId], ratingSourcePosition(event, accountId)))
          )
            return { value: null, events: [] };
          await ensureVoterState.run(tx, { route, voter_id: accountId });
          const current = await readVoterState.run(tx, { route, voter_id: accountId });
          if (!current) throw new Error('Could not create rating voter state');
          const change = eventState(type, current.state as EligibilityState, current.purgeVotes);
          if (!change) return { value: null, events: [] };
          const realms = await readCapped.run(tx, { route, voter_id: accountId });
          const populations = [...new Set([GLOBAL_CONTEXT.id, ...realms.map(({ realmId }) => realmId)])];
          await updateVoterState.run(tx, {
            route,
            voter_id: accountId,
            state: change.state,
            cursor_question_id: null,
            cursor_target_id: null,
            transition_id: command.transactionId,
            purge_votes: change.purgeVotes,
            populations,
          });
          return {
            value: null,
            events: [{ type: ELIGIBILITY_CHANGED, subject: accountId, data: { voterId: accountId } }],
          };
        },
      );
    },
  };
}

/** Read an active eligibility transition as the same durable segment workflow used for Realm jobs. */
export async function readRatingEligibilityJob(
  pool: Pool,
  input: { voterId: string },
): Promise<RatingEligibilityJob | null> {
  const route = routeOf(input.voterId);
  if (route === null) throw new TypeError('Invalid rating eligibility address');
  const row = await withConnection(pool, (client) => readVoterStateJob.run(client, { route, voter_id: input.voterId }));
  if (!row || (row.state !== 'leaving' && row.state !== 'returning')) return null;
  const populations = row.populations.filter((id): id is string => id !== null);
  if (
    typeof row.transitionId !== 'string' ||
    !validId(row.transitionId) ||
    populations.length !== row.populations.length ||
    populations.length > 101 ||
    populations.some((id) => !validId(id))
  )
    throw new TypeError('Invalid rating eligibility transition');
  return {
    voterId: input.voterId,
    eligibility: true,
    direction: row.state === 'leaving' ? 'removing' : 'adding',
    transitionId: row.transitionId,
    populations,
  };
}

export function isRatingEligibilityJob(job: RatingSegmentJob): job is RatingEligibilityJob {
  return 'eligibility' in job && job.eligibility === true;
}
