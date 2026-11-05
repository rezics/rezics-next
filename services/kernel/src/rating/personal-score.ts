import type { PoolClient } from 'pg';
import { STANDARD_QUESTION_ID } from './votes.ts';
import { checkedRatingQuestionScale } from './question-scale.ts';
import type { ShelfScoreQuestion } from '../library/shelf-contract.ts';
import { ShelfReadUnavailableError } from '../library/shelf-reader-unavailable.ts';

/** Shared native meaning for shelf ordering and the independent viewer-facts consumer. */
export async function readPersonalScoreQuestion(client: Pick<PoolClient, 'query'>): Promise<ShelfScoreQuestion> {
  const { rows } = await client.query<ShelfScoreQuestion>(
    `SELECT q.id,q.meaning,q.revision,q.grain,q.minimum_units AS "minimumUnits",
      q.maximum_units AS "maximumUnits",q.step_units AS "stepUnits",
      COALESCE(l.state,'active') AS "lifecycleState",COALESCE(l.revision,1) AS "lifecycleRevision"
     FROM rating.question q LEFT JOIN rating.question_lifecycle l ON l.question_id=q.id WHERE q.id=$1::uuid`,
    [STANDARD_QUESTION_ID],
  );
  const question = rows[0];
  if (!question) throw new ShelfReadUnavailableError('native standard rating question is unavailable');
  checkedRatingQuestionScale(question);
  return question;
}

/** Content supplies this only after holding all native Entry/vote identity effects for this owner.
 * A current result covers the entire matching owner shelf, including rows beyond this page,
 * in the caller's RR snapshot. The version changes before a merge/lifecycle can make that
 * ordering stale. This is independent of the bounded viewer-facts overlay.
 */
export type PersonalScoreCurrentness = (
  client: Pick<PoolClient, 'query'>,
  owner: { route: number; accountId: string; question: ShelfScoreQuestion },
) => Promise<{ status: 'current'; version: string } | { status: 'pending' | 'unavailable'; reason: string }>;

export const unavailablePersonalScoreCurrentness: PersonalScoreCurrentness = async () => ({
  status: 'unavailable',
  reason: 'Content native owner-wide score identity fence is not installed',
});

/** Content's owner-wide fence: identity repair work plus voter standing in this RR snapshot.
 * Active repair is pending; ineligible standing is unavailable. The version is not inferred from vote rows.
 */
export const readPersonalScoreCurrentness: PersonalScoreCurrentness = async (client, owner) => {
  const frame = await client.query<{ generation: string; state: string }>(
    'SELECT generation::text,state FROM rating.identity_work_frame WHERE route=$1::integer AND voter_id=$2::uuid',
    [owner.route, owner.accountId],
  );
  const work = frame.rows[0];
  if (work?.state === 'active')
    return { status: 'pending', reason: 'Content score identity repair is pending' };
  const voter = await client.query<{ state: string; transitionId: string }>(
    'SELECT state,transition_id::text AS "transitionId" FROM rating.voter_state WHERE route=$1::integer AND voter_id=$2::uuid',
    [owner.route, owner.accountId],
  );
  const standing = voter.rows[0];
  if (standing && standing.state !== 'eligible')
    return { status: 'unavailable', reason: `Content voter standing ${standing.state} refuses score currentness` };
  const version = [
    owner.question.id,
    owner.question.revision,
    owner.question.lifecycleRevision,
    work?.generation ?? '0',
    work?.state ?? 'none',
    standing?.transitionId ?? 'none',
    standing?.state ?? 'eligible',
  ].join(':');
  if (!version || version.length > 256) return { status: 'unavailable', reason: 'invalid Content score currentness version' };
  return { status: 'current', version };
};
