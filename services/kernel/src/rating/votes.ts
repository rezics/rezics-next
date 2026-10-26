import type { Pool, PoolClient } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { LibraryNotFoundError, createLibraryCommandRunner, requireRoute } from '../library/command-support.ts';
import { resolveSubject } from '../library/subject-anchor.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import questionRead from './question-read.sql';
import voteInsert from './vote-insert.sql';
import voteLock from './vote-lock.sql';
import voteRead from './vote-read.sql';
import voteUpdate from './vote-update.sql';

export const STANDARD_QUESTION_ID = '00000000-0000-7000-8000-000000000001';
export const VOTE_SCOPE = 'rating:vote';
const VOTE_EVENT = 'com.rezics.rating.vote.changed.v1';

export type RatingQuestion = {
  id: string;
  ownerId: string | null;
  revision: number;
  label: string;
  grain: 'work' | 'release' | 'episode' | 'character';
  minimumUnits: number;
  maximumUnits: number;
  stepUnits: number;
};

export type Vote = {
  voterId: string;
  questionId: string;
  targetId: string;
  units: number | null;
  revision: number;
  changedAt: string;
  transactionId: string;
};

export type PutVoteInput = { questionId: string; targetId: string; units: number | null };

export class VoteInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid rating vote field: ${field}`);
    this.name = 'VoteInvalidError';
  }
}

export class RatingQuestionNotFoundError extends Error {
  constructor() {
    super('Rating question not found');
    this.name = 'RatingQuestionNotFoundError';
  }
}

type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
type Queryable = Pick<Pool | PoolClient, 'query'>;
type QuestionRow = NonNullable<Awaited<ReturnType<typeof questionRead.run>>>;
type VoteRow = NonNullable<Awaited<ReturnType<typeof voteRead.run>>>;

function account(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null) throw new GrantDeniedError();
  return actor;
}

function voteAccount(actor: Actor): AccountActor {
  const owner = account(actor);
  if (!owner.scopes.includes(VOTE_SCOPE)) throw new GrantDeniedError();
  return owner;
}

function asQuestion(row: QuestionRow): RatingQuestion {
  if (row.grain !== 'work' && row.grain !== 'release' && row.grain !== 'episode' && row.grain !== 'character')
    throw new Error(`Unknown rating grain: ${row.grain}`);
  return {
    ...row,
    grain: row.grain,
    revision: Number(row.revision),
    minimumUnits: Number(row.minimumUnits),
    maximumUnits: Number(row.maximumUnits),
    stepUnits: Number(row.stepUnits),
  };
}

function asVote(row: VoteRow): Vote {
  return {
    voterId: row.voterId,
    questionId: row.questionId,
    targetId: row.targetId,
    units: row.units === null ? null : Number(row.units),
    revision: Number(row.revision),
    changedAt: new Date(row.changedAt).toISOString(),
    transactionId: row.transactionId,
  };
}

function queryClient(client: Queryable): Queryable {
  return { query: client.query.bind(client) };
}

async function readQuestion(pool: Pool, questionId: string): Promise<RatingQuestion> {
  if (routeOf(questionId) === null) throw new RatingQuestionNotFoundError();
  const row = await withConnection(pool, (client) => questionRead.run(client, { question_id: questionId }));
  if (!row) throw new RatingQuestionNotFoundError();
  return asQuestion(row);
}

function validateUnits(question: RatingQuestion, units: number | null): void {
  if (units === null) return;
  if (
    !Number.isSafeInteger(units) ||
    units < question.minimumUnits ||
    units > question.maximumUnits ||
    (units - question.minimumUnits) % question.stepUnits !== 0
  )
    throw new VoteInvalidError('units');
}

function assertCurrentAccount(owner: AccountActor, current: Awaited<ReturnType<typeof readAccount>>): void {
  if (
    !current ||
    current.kind !== 'actor' ||
    current.state !== 'active' ||
    current.fenced ||
    !Number.isSafeInteger(owner.authnEpoch) ||
    owner.authnEpoch < 1 ||
    current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
  )
    throw new GrantDeniedError();
}

class VoteUnchanged extends Error {
  constructor(readonly vote: Vote | null) {
    super('Vote is unchanged');
    this.name = 'VoteUnchanged';
  }
}

/** Writes and reads the signed-in person's current rating vote on the account's partition. */
export function createVoteCommands(config: Dependencies) {
  const { pool, access, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function putVote(actor: Actor, input: PutVoteInput, idempotencyKey: string): Promise<Vote | null> {
    const owner = voteAccount(actor);
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.questionId !== 'string' ||
      typeof input.targetId !== 'string'
    )
      throw new VoteInvalidError('vote');
    if (input.units !== null && typeof input.units !== 'number') throw new VoteInvalidError('units');

    const question = await readQuestion(pool, input.questionId);
    validateUnits(question, input.units);
    const resolved = await resolveSubject(
      { pool, access, ...(clock === undefined ? {} : { clock }) },
      owner,
      input.targetId,
    );
    if (!resolved) throw new LibraryNotFoundError();

    try {
      const outcome = await runner.ownAccount(
        actor,
        {
          action: VOTE_SCOPE,
          kind: 'rating.vote.put',
          requestKey: idempotencyKey,
          input: { questionId: input.questionId, targetId: input.targetId, units: input.units },
        },
        async (tx, command) => {
          const route = requireRoute(owner.accountId);
          const previousRow = await voteLock.run(queryClient(tx), {
            route,
            voter_id: owner.accountId,
            question_id: question.id,
            target_id: resolved.subjectId,
          });
          const previous = previousRow ? asVote(previousRow) : null;
          if ((!previous && input.units === null) || (previous && previous.units === input.units))
            throw new VoteUnchanged(previous);

          const time = authoritativeTimeValue(command.time);
          let nextRow: Awaited<ReturnType<typeof voteRead.run>>;
          if (previousRow) {
            nextRow = await voteUpdate.run(queryClient(tx), {
              route,
              voter_id: owner.accountId,
              question_id: question.id,
              target_id: resolved.subjectId,
              revision: previousRow.revision,
              units: input.units,
              changed_at: time,
              transaction_id: command.transactionId,
            });
          } else {
            if (input.units === null) throw new VoteUnchanged(null);
            nextRow = await voteInsert.run(queryClient(tx), {
              route,
              voter_id: owner.accountId,
              question_id: question.id,
              target_id: resolved.subjectId,
              units: input.units,
              changed_at: time,
              transaction_id: command.transactionId,
            });
          }
          if (!nextRow) throw new Error('Rating vote changed while its row was locked');
          const vote = asVote(nextRow);
          return {
            value: vote,
            events: [
              {
                type: VOTE_EVENT,
                subject: owner.accountId,
                data: {
                  voterId: owner.accountId,
                  questionId: question.id,
                  targetId: resolved.subjectId,
                  previous: previous?.units ?? null,
                  units: vote.units,
                  revision: vote.revision,
                  populations: [GLOBAL_CONTEXT.id],
                },
              },
            ],
          };
        },
      );
      return outcome.value;
    } catch (error) {
      if (error instanceof VoteUnchanged) return error.vote;
      throw error;
    }
  }

  async function readOwnVote(actor: Actor, questionId: string, targetId: string): Promise<Vote | null> {
    const owner = account(actor);
    if (routeOf(questionId) === null || routeOf(targetId) === null) return null;
    const route = requireRoute(owner.accountId);
    return withConnection(pool, async (client) => {
      const current = await readAccount(client, route, owner.accountId);
      assertCurrentAccount(owner, current);
      const row = await voteRead.run(client, {
        route,
        voter_id: owner.accountId,
        question_id: questionId,
        target_id: targetId,
      });
      return row ? asVote(row) : null;
    });
  }

  return { putVote, readOwnVote };
}
