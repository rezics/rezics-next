import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { readRealm } from '../community/realm.ts';
import { withConnection } from '../database/pool.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { globalReadEligibility } from '../semantic/eligibility.ts';
import { withReadTransaction } from '../semantic/read.ts';
import directory from './question-directory.sql';
import realmDirectory from './question-directory-realm.sql';
import questionRead from './question-read.sql';
import type { QuestionGrain } from './question-authoring.ts';

type Dependencies = { pool: Pool; access: Access };
export type QuestionMetadata = NonNullable<Awaited<ReturnType<typeof questionRead.run>>>;

export type RatingQuestionView = {
  id: string;
  revision: number;
  label: string;
  grain: QuestionGrain;
  scale: { min: number; max: number; displayStep: number };
  realmId?: string;
  meaning?: string;
  canonicalLabel?: string;
  labelRevision?: number;
};

/** Keep the legacy wire shape exact. Realm definitions add explicit provenance and
 * meaning; ownerId is the authoring account and is never used as a Realm selector. */
export function ratingQuestionView(row: {
  id: string;
  revision: number;
  label: string;
  grain: string;
  minimumUnits: number;
  maximumUnits: number;
  stepUnits: number;
  realmId?: string | null;
  meaning?: string | null;
  presentationLabel?: string | null;
  labelRevision?: number | null;
}): RatingQuestionView {
  const grain = row.grain;
  if (grain !== 'work' && grain !== 'release' && grain !== 'episode' && grain !== 'character')
    throw new Error('Unknown rating question grain');
  return {
    id: row.id,
    revision: row.revision,
    label: row.presentationLabel ?? row.label,
    grain,
    scale: { min: row.minimumUnits, max: row.maximumUnits, displayStep: row.stepUnits },
    ...(row.realmId == null
      ? {}
      : {
          realmId: row.realmId,
          meaning: row.meaning!,
          canonicalLabel: row.label,
          labelRevision: row.labelRevision ?? 1,
        }),
  };
}

/** Existing Global definitions authority, with no held connection during preparation. */
export async function requireGlobalQuestionRead(deps: Dependencies, actor: Actor, deadline: number): Promise<void> {
  const check = await accessCheck(
    deps.access,
    actor,
    'definitions:read',
    {
      route: GLOBAL_CONTEXT.route,
      id: GLOBAL_CONTEXT.id,
      eligibility: globalReadEligibility('definitions:read'),
    },
    { pool: deps.pool, deadline },
  );
  await withConnection(deps.pool, async (client) => {
    if (!(await check(deadlineClient(client, deadline)))) throw new ProblemError('not_found');
  });
}

/** Native Realm readability includes protected grants, host state and current bans.
 * Failure/unavailability propagates; it must never become an empty selection. */
export async function requireRealmQuestionRead(
  deps: Dependencies,
  actor: Actor,
  realmId: string,
  deadline: number,
): Promise<void> {
  requireAccessDeadline(deadline);
  if (routeOf(realmId) === null || realmId === GLOBAL_CONTEXT.id) throw new ProblemError('not_found');
  const realm = await readRealm(deps, actor, realmId, { deadline });
  requireAccessDeadline(deadline);
  if (!realm) throw new ProblemError('not_found');
}

/** Exactly one question-home observation followed by one current authority check.
 * The metadata connection is released before Access prepares any native evidence.
 * No row, label or grain crosses the boundary until its provenance is readable. */
export async function readVisibleRatingQuestion(
  deps: Dependencies,
  actor: Actor,
  questionId: string,
  deadline: number,
  globalAuthority = true,
): Promise<QuestionMetadata | null> {
  const route = routeOf(questionId);
  if (route === null) return null;
  const row = await withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await partitionReadClient(bounded, partitionOf(route));
    return questionRead.run(bounded, { question_id: questionId });
  });
  if (!row) return null;
  if (row.realmId !== null) await requireRealmQuestionRead(deps, actor, row.realmId, deadline);
  else if (globalAuthority) await requireGlobalQuestionRead(deps, actor, deadline);
  return row;
}

/** One indexed seek and one unconsumed lookahead, authorized by the caller.
 * Explicit Realm selection prevents protected rows entering the Global directory.
 * Consumed raw keys drive progress even if a later visibility observation denies. */
export async function readRatingQuestionDirectory(
  client: Pick<PoolClient, 'query'>,
  input: { after: string | null; limit: number; realmId?: string },
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
    throw new RangeError('Invalid rating question page limit');
  const parameters = {
    after_id: input.after ?? '00000000-0000-0000-0000-000000000000',
    limit: input.limit,
  };
  const rows =
    input.realmId === undefined
      ? await directory.run(client, parameters)
      : await realmDirectory.run(client, { ...parameters, realm_id: input.realmId });
  const consumed = rows.slice(0, input.limit);
  return {
    ratingQuestions: consumed.map(ratingQuestionView),
    after: consumed.at(-1)?.id ?? null,
    hasMore: rows.length > input.limit,
  };
}

/** Selection is explicit, never inferred from owner_id or from a filtered page.
 * Every Realm page has at most 21 raw rows, 20 metadata views and two native Realm
 * reads, with all checkouts released between metadata and authority observations. */
export async function readSelectedQuestionDirectory(
  deps: Dependencies,
  actor: Actor,
  input: { after: string | null; limit: number; realmId?: string },
  deadline: number,
) {
  const authorize = () =>
    input.realmId === undefined
      ? requireGlobalQuestionRead(deps, actor, deadline)
      : requireRealmQuestionRead(deps, actor, input.realmId, deadline);
  await authorize();
  const page = await withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    // A selected Realm and every question it creates share one native home.
    await partitionReadClient(bounded, partitionOf(input.realmId === undefined ? 0 : routeOf(input.realmId)!));
    return readRatingQuestionDirectory(bounded, input);
  });
  if (input.realmId !== undefined) await authorize();
  return page;
}
