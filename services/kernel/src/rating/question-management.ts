import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { AccessUnavailableError } from '../request/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  ratingQuestionView,
  readSelectedQuestionDirectory,
  readVisibleRatingQuestion,
  requireRealmQuestionRead,
  type QuestionMetadata,
  type RatingQuestionView,
} from './question-directory.ts';
import generationRead from './question-lifecycle-generation-read.sql';
import questionRead from './question-read.sql';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type ManagementInput = { realmId: string; selectedQuestionId?: string; cursor?: string };
const PAGE_SIZE = 20;
const MAX_CURSOR = 4096;
const MAX_BYTES = 1_048_576;
const MAX_REVISION = 2_147_483_647;

function managementQuestion(view: RatingQuestionView) {
  if (
    view.realmId === undefined ||
    view.meaning === undefined ||
    view.canonicalLabel === undefined ||
    view.labelRevision === undefined ||
    view.lifecycle === undefined
  )
    throw new AccessUnavailableError('overloaded');
  return {
    ...view,
    realmId: view.realmId,
    meaning: view.meaning,
    canonicalLabel: view.canonicalLabel,
    labelRevision: view.labelRevision,
    lifecycle: view.lifecycle,
  };
}

/** Advice is the native Realm manage formula, never a membership/creator shortcut.
 * Preparation releases its connections before the decision's checkout. Every
 * writer still repeats its own current authorization before looking up a receipt. */
async function manageAdvice(deps: Dependencies, actor: Actor, realmId: string, deadline: number) {
  const check = await accessCheck(
    deps.access,
    actor,
    'realm:manage',
    { route: routeOf(realmId)!, id: realmId },
    { pool: deps.pool, deadline },
  );
  return withConnection(deps.pool, (client) => check(deadlineClient(client, deadline)));
}

/** One Realm directory and one optional exact definition. This is an additive
 * read projection; create, caption and lifecycle commands retain their owners.
 * Caption history and exact revisions retain the existing native read methods. */
export async function readQuestionManagementPage(
  deps: Dependencies,
  actor: Actor,
  input: ManagementInput,
  deadline: number,
) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const realmId = input.realmId;
  const selectedQuestionId = input.selectedQuestionId;
  const cursor = input.cursor;
  const route = routeOf(realmId);
  if (route === null || (selectedQuestionId !== undefined && routeOf(selectedQuestionId) !== route))
    throw new ProblemError('not_found');
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_CURSOR))
    throw new ProblemError('invalid_cursor');
  const authority = { ...actor, scopes: [...new Set(actor.scopes)].sort() };
  const binding: CursorBinding = {
    operation: 'rating.question-management',
    parameters: {
      realm: realmId,
      selected: selectedQuestionId ?? null,
      limit: PAGE_SIZE,
      authority: createHash('sha256').update(JSON.stringify(authority)).digest('hex'),
    },
  };
  const now = () => (deps.clock?.() ?? new Date()).getTime();
  let after: string | null = null;
  let lifecycleGeneration: string | undefined;
  if (cursor !== undefined) {
    const decoded = decodeCursor(deps.tokens, binding, cursor, now());
    if (
      !decoded.ok ||
      decoded.epoch !== 2 ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      routeOf(decoded.after[0]) !== route ||
      typeof decoded.after[1] !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(decoded.after[1])
    )
      throw new ProblemError('invalid_cursor');
    after = decoded.after[0];
    lifecycleGeneration = decoded.after[1];
  }
  const directory = await readSelectedQuestionDirectory(
    deps,
    actor,
    {
      realmId,
      after,
      limit: PAGE_SIZE,
      ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }),
    },
    deadline,
  );
  let selected: QuestionMetadata | null = null;
  if (selectedQuestionId !== undefined) {
    selected = await readVisibleRatingQuestion(deps, actor, selectedQuestionId, deadline);
    // Global questions and other Realms have no authoring path on this page.
    if (!selected || selected.realmId !== realmId) throw new ProblemError('not_found');
  }
  const canManage = await manageAdvice(deps, actor, realmId, deadline);
  // Foreign advice preparation must not release rows after disclosure is revoked.
  await requireRealmQuestionRead(deps, actor, realmId, deadline);
  await withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await partitionReadClient(bounded, partitionOf(route));
    const generation = (await generationRead.run(bounded, { realm_id: realmId }))?.generation ?? '0';
    if (generation !== directory.lifecycleGeneration) throw new ProblemError('invalid_cursor');
    if (selected !== null) {
      const current = await questionRead.run(bounded, { question_id: selected.id });
      if (!current || current.realmId !== realmId) throw new ProblemError('not_found');
      if (JSON.stringify(current) !== JSON.stringify(selected)) throw new ProblemError('conflict');
    }
  });
  const question = selected === null ? null : managementQuestion(ratingQuestionView(selected));
  const selectedBase = question === null ? null : `/v1/rating-questions/${question.id}`;
  const next =
    directory.hasMore && directory.after !== null
      ? encodeCursor(deps.tokens, binding, { epoch: 2, after: [directory.after, directory.lifecycleGeneration] }, now())
      : null;
  const page = {
    viewer: { accountId: actor.accountId },
    realmId,
    directory: { ratingQuestions: directory.ratingQuestions.map(managementQuestion), next },
    actions: {
      create: canManage ? { method: 'POST' as const, href: `/v1/realms/${realmId}/rating-questions` } : null,
    },
    selected:
      question === null
        ? null
        : {
            question,
            readback: selectedBase!,
            history: `${selectedBase}/labels`,
            actions: {
              caption:
                canManage && question.labelRevision! < MAX_REVISION
                  ? {
                      method: 'PUT' as const,
                      href: `${selectedBase}/label`,
                      expectedLabelRevision: question.labelRevision!,
                    }
                  : null,
              lifecycle:
                canManage && question.lifecycle!.revision < MAX_REVISION
                  ? {
                      method: 'POST' as const,
                      href: `${selectedBase}/$${question.lifecycle!.state === 'active' ? 'retire' : 'restore'}`,
                      expectedLifecycleRevision: question.lifecycle!.revision,
                    }
                  : null,
            },
          },
  };
  // The closed source bounds every field before this copy: one indexed raw page
  // and one exact row, with no votes or revision-history materialized here.
  if ((next !== null && next.length > MAX_CURSOR) || Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES)
    throw new AccessUnavailableError('overloaded');
  return page;
}
