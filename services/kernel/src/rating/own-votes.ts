import type { PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { VOTE_SCOPE, VoteInvalidError } from './votes.ts';
import ownVotes from './own-votes.sql';

/** Read raw target keys in the caller's repeatable-read snapshot, without checking out a connection. */
export async function readOwnVotes(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  questionId: string,
  targetIds: readonly string[],
): Promise<Map<string, { units: number; revision: number; at: string }>> {
  if (actor.kind !== 'account' || !actor.scopes.includes(VOTE_SCOPE)) throw new GrantDeniedError();
  const route = routeOf(actor.accountId);
  if (route === null) throw new GrantDeniedError();
  if (targetIds.length > 100) throw new VoteInvalidError('targetIds');
  if (routeOf(questionId) === null) throw new VoteInvalidError('questionId');
  const targets = [...new Set(targetIds)];
  if (targets.some((id) => routeOf(id) === null)) throw new VoteInvalidError('targetIds');
  const current = await readAccount(client, route, actor.accountId);
  if (
    !current ||
    current.kind !== 'actor' ||
    current.state !== 'active' ||
    current.fenced ||
    !Number.isSafeInteger(actor.authnEpoch) ||
    actor.authnEpoch < 1 ||
    current.minimumAuthnEpoch > BigInt(actor.authnEpoch)
  )
    throw new GrantDeniedError();

  const result = new Map<string, { units: number; revision: number; at: string }>();
  if (targets.length === 0) return result;
  const rows = await ownVotes.run(client, {
    route,
    voter_id: actor.accountId,
    question_id: questionId,
    target_ids: targets,
  });
  for (const row of rows) {
    if (row.units === null) continue;
    if (row.at === null) throw new Error('Rating vote has no change time');
    result.set(row.targetId, {
      units: Number(row.units),
      revision: Number(row.revision),
      at: new Date(row.at).toISOString(),
    });
  }
  return result;
}
