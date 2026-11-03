import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem.ts';
import { readableSubjects, SubjectIdentityUnavailableError } from '../library/subject-anchor.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IdentityMapping } from '../semantic/identity-epoch-contract.ts';
import { identityEpochStore } from '../semantic/identity-epoch-store.ts';
import { admitIdentityRatingEffect } from '../semantic/identity-rating-admission.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { readSubjectSummaries, type SubjectSummary } from '../semantic/summaries.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { ratingQuestionView, requireRealmQuestionRead, type RatingQuestionView } from './question-directory.ts';
import { VOTE_SCOPE, VoteInvalidError } from './votes.ts';
import selectPage from './own-votes-page.sql';
import selectCurrent from './own-votes-current.sql';
import selectQuestions from './own-votes-questions.sql';

export const OWN_VOTES_PAGE_SIZE = 20;
const first = '00000000-0000-0000-0000-000000000000';
type Key = { questionId: string; targetId: string };
type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };
type CommandLinks = { clear: string; readback: string };
export type OwnVoteActions =
  | (CommandLinks & { state: 'editable'; put: string })
  | (CommandLinks & { state: 'retired'; reason: 'question_retired' })
  | { state: 'unavailable'; reason: 'merged_source' | 'identity_pending' };
export type OwnVoteEntry = {
  /** Exact stored source key, even when its permitted navigation points at a terminal. */
  targetId: string;
  questionId: string;
  subject: SubjectSummary;
  subjectHref: string;
  question: RatingQuestionView;
  own: { units: number; revision: number; at: string };
  actions: OwnVoteActions;
};
export type OwnVotesPage = { viewer: { accountId: string }; votes: OwnVoteEntry[]; next: string | null };

function ownerOf(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || !actor.scopes.includes(VOTE_SCOPE) || routeOf(actor.accountId) === null)
    throw new GrantDeniedError();
  return actor;
}

async function currentAccount(client: Pick<PoolClient, 'query'>, owner: AccountActor): Promise<void> {
  const row = await readAccount(client, routeOf(owner.accountId)!, owner.accountId);
  if (!row || row.kind !== 'actor' || row.state !== 'active' || row.fenced ||
      !Number.isSafeInteger(owner.authnEpoch) || owner.authnEpoch < 1 ||
      row.minimumAuthnEpoch > BigInt(owner.authnEpoch)) throw new GrantDeniedError();
}

/** Raw selection is a single account-home prefix. Cleared rows are outside its partial index. */
export async function readOwnVotesRawPage(
  client: Pick<PoolClient, 'query'>, actor: Actor, after: Key | null,
) {
  const owner = ownerOf(actor);
  if (after && (routeOf(after.questionId) === null || routeOf(after.targetId) === null))
    throw new VoteInvalidError('after');
  await currentAccount(client, owner);
  const rows = await selectPage.run(client, {
    route: routeOf(owner.accountId)!, voter_id: owner.accountId,
    after_question: after?.questionId ?? first, after_target: after?.targetId ?? first,
  });
  const votes = rows.slice(0, OWN_VOTES_PAGE_SIZE);
  const last = votes.at(-1);
  return {
    votes, after: last ? { questionId: last.questionId, targetId: last.targetId } : null,
    hasMore: rows.length > OWN_VOTES_PAGE_SIZE,
  };
}

function mappingKey(mapping: IdentityMapping): string | null {
  if (mapping.state === 'unavailable') throw new AccessUnavailableError('contention');
  return mapping.state === 'mapped' ? `${mapping.original}:${mapping.terminal}:${mapping.epoch}` : null;
}
function key(row: Key) { return `${row.questionId}:${row.targetId}`; }

async function visibleSources(deps: Dependencies, actor: Actor, sources: readonly string[]) {
  try {
    return new Set(await readableSubjects(deps, actor, sources));
  } catch (error) {
    if (error instanceof SubjectIdentityUnavailableError) throw new AccessUnavailableError('contention');
    throw error;
  }
}

/** Observe the same native identity admission as a changed vote, without writing or holding an account checkout. */
async function admittedSources(deps: Dependencies, sources: readonly string[], deadline: number) {
  const homes = new Map<number, string[]>();
  for (const id of sources) {
    const home = partitionOf(routeOf(id)!);
    homes.set(home, [...(homes.get(home) ?? []), id]);
  }
  const admitted = new Set<string>();
  for (const [home, ids] of homes) {
    await withReadTransaction(deps.pool, async (client) => {
      await partitionReadClient(client, home);
      for (const id of ids) {
        const result = await admitIdentityRatingEffect(client, { requestedTargetId: id, resolvedTargetId: id });
        if (result.status === 'admitted') admitted.add(id);
      }
    }, deadline);
  }
  return admitted;
}

/** Supplied exact keys only; each question home is released before native Realm Access preparation. */
async function questions(deps: Dependencies, actor: Actor, ids: readonly string[], deadline: number) {
  const groups = new Map<number, string[]>();
  for (const id of new Set(ids)) {
    const home = partitionOf(routeOf(id)!);
    groups.set(home, [...(groups.get(home) ?? []), id]);
  }
  const rows: Awaited<ReturnType<typeof selectQuestions.run>> = [];
  for (const [home, ids] of groups) {
    rows.push(...await withReadTransaction(deps.pool, async (client) => {
      await partitionReadClient(client, home);
      return selectQuestions.run(client, { ids });
    }, deadline));
  }
  const readable = new Set<string>();
  for (const realmId of new Set(rows.flatMap((row) => row.realmId ? [row.realmId] : []))) {
    try {
      await requireRealmQuestionRead(deps, actor, realmId, deadline);
      readable.add(realmId);
    } catch (error) {
      // A deliberate native denial suppresses metadata; failed authority remains retryable failure.
      if (!(error instanceof ProblemError && error.code === 'not_found')) throw error;
    }
  }
  // Matches native vote admission: standard definitions have no extra Global scope requirement.
  return new Map(rows.filter((row) => row.realmId === null || readable.has(row.realmId)).map((row) => [row.id, row]));
}

/** Account-home native inventory. No mounted point GET calls, refill loop or secondary writer. */
export function createOwnVotesReader(deps: Dependencies) {
  return {
    async page(actor: Actor, input: { cursor?: string }, deadline: number): Promise<OwnVotesPage> {
      const owner = ownerOf(actor);
      const home = partitionOf(routeOf(owner.accountId)!);
      const accountRead = <T>(read: (client: PoolClient) => Promise<T>) =>
        withReadTransaction(deps.pool, async (client) => {
          await partitionReadClient(client, home);
          await currentAccount(client, owner);
          return read(client);
        }, deadline);
      // Validate the security episode before decoding or reading private vote payloads.
      await accountRead(async () => undefined);
      const binding: CursorBinding = {
        operation: 'rating.own-votes-page',
        parameters: { account: owner.accountId, authnEpoch: owner.authnEpoch, selection: 'current-native', order: 'question-target.v1' },
      };
      const now = () => (deps.clock?.() ?? new Date()).getTime();
      let after: Key | null = null;
      if (input.cursor !== undefined) {
        const cursor = decodeCursor(deps.tokens, binding, input.cursor, now());
        if (!cursor.ok || cursor.epoch !== 1 || cursor.after.length !== 2 ||
            cursor.after.some((value) => typeof value !== 'string' || routeOf(value) === null))
          throw new ProblemError('invalid_cursor');
        after = { questionId: cursor.after[0] as string, targetId: cursor.after[1] as string };
      }
      const page = await accountRead((client) => readOwnVotesRawPage(client, owner, after));
      if (!page.votes.length) return { viewer: { accountId: owner.accountId }, votes: [], next: null };
      const sources = [...new Set(page.votes.map((row) => row.targetId))];
      const questionIds = [...new Set(page.votes.map((row) => row.questionId))];
      const mappings = await identityEpochStore.readMappings(deps.pool, sources);
      const initial = new Map(sources.map((id, i) => [id, mappings[i]!]));
      // Force typed identity failures to fail the whole page, including withheld-only batches.
      for (const mapping of mappings) mappingKey(mapping);
      const visible = await visibleSources(deps, owner, sources);
      const initialQuestions = await questions(deps, owner, questionIds, deadline);
      const terminals = [...new Set(mappings.flatMap((mapping) =>
        mapping.state === 'mapped' && visible.has(mapping.original) ? [mapping.terminal] : []))];
      // Missing release authority is dependency failure, never a deliberately empty summary batch.
      const requireRelease = () => withReadTransaction(deps.pool, async (client) => {
        await partitionReadClient(client, 0);
        if (!(await activeRelease(client))) throw new AccessUnavailableError('contention');
      }, deadline);
      await requireRelease();
      const summaries = await readSubjectSummaries({ ...deps, actor: owner, deadline }, terminals);
      const finalQuestions = await questions(deps, owner, questionIds, deadline);
      const finalVisible = await visibleSources(deps, owner, sources);
      const finalMappings = await identityEpochStore.readMappings(deps.pool, sources);
      const final = new Map(sources.map((id, i) => [id, finalMappings[i]!]));
      for (const mapping of finalMappings) mappingKey(mapping);
      const admitted = await admittedSources(deps, sources.filter((id) => {
        const mapping = final.get(id)!;
        return mapping.state === 'mapped' && mapping.terminal === id && finalVisible.has(id);
      }), deadline);
      await requireRelease();
      const current = await accountRead((client) => selectCurrent.run(client, {
        route: routeOf(owner.accountId)!, voter_id: owner.accountId,
        keys: page.votes.map((row) => ({ question_id: row.questionId, target_id: row.targetId })),
      }));
      const byKey = new Map(current.map((row) => [key(row), row]));
      const votes: OwnVoteEntry[] = [];
      for (const selected of page.votes) {
        const row = byKey.get(key(selected));
        const before = initial.get(selected.targetId)!;
        const latest = final.get(selected.targetId)!;
        if (!row || before.state !== 'mapped' || latest.state !== 'mapped' ||
            mappingKey(before) !== mappingKey(latest) || !visible.has(row.targetId) || !finalVisible.has(row.targetId)) continue;
        const subject = summaries.get(latest.terminal);
        const question = finalQuestions.get(row.questionId);
        const previousQuestion = initialQuestions.get(row.questionId);
        if (!subject || !question || !previousQuestion || question.revision !== previousQuestion.revision) continue;
        if (row.units === null) continue;
        if (row.changedAt === null) throw new Error('Rating vote has no change time');
        const path = `/v1/subjects/${row.targetId}/ratings/${row.questionId}/vote`;
        let actions: OwnVoteActions;
        if (row.targetId !== latest.terminal) actions = { state: 'unavailable', reason: 'merged_source' };
        else if (row.countedTarget !== row.targetId || !admitted.has(row.targetId))
          actions = { state: 'unavailable', reason: 'identity_pending' };
        else if (question.lifecycleState === 'retired') actions = { state: 'retired', reason: 'question_retired', clear: path, readback: path };
        else actions = { state: 'editable', put: path, clear: path, readback: path };
        votes.push({
          targetId: row.targetId, questionId: row.questionId, subject,
          subjectHref: `/v1/subjects/${latest.terminal}`, question: ratingQuestionView(question),
          own: { units: Number(row.units), revision: Number(row.revision), at: new Date(row.changedAt).toISOString() }, actions,
        });
      }
      return {
        viewer: { accountId: owner.accountId }, votes,
        next: page.hasMore && page.after ? encodeCursor(deps.tokens, binding, {
          epoch: 1, after: [page.after.questionId, page.after.targetId],
        }, now()) : null,
      };
    },
  };
}
