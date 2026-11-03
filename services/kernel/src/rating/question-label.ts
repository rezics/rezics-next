import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/index.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, commandTime, principalCommandIdentity, runCommand } from '../command/command.ts';
import realmRead from '../community/realm-read.sql';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { QuestionDefinitionInvalidError } from './question-authoring.ts';
import { readVisibleRatingQuestion } from './question-directory.ts';
import append from './question-label-append.sql';
import lock from './question-label-lock.sql';
import pageRead from './question-label-page.sql';
import exactRead from './question-label-read.sql';
import questionRead from './question-read.sql';

export const QUESTION_LABEL_CHANGED = 'com.rezics.rating.question.label-changed.v1';
type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
export type QuestionLabelInput = Readonly<{ questionId: string; expectedLabelRevision: number; label: string }>;
export type QuestionLabel = {
  questionId: string;
  labelRevision: number;
  label: string;
  at: string | null;
  author: PublicIdentity | null;
};

export function validateQuestionLabel(input: QuestionLabelInput): void {
  if (!input || routeOf(input.questionId) === null) throw new QuestionDefinitionInvalidError('questionId');
  if (!Number.isInteger(input.expectedLabelRevision) || input.expectedLabelRevision < 1 || input.expectedLabelRevision >= 2_147_483_647)
    throw new QuestionDefinitionInvalidError('expectedLabelRevision');
  if (typeof input.label !== 'string' || !input.label.trim() || [...input.label].length > 200 || input.label.includes('\0'))
    throw new QuestionDefinitionInvalidError('label');
}

/** A caption can correct presentation; its revision never becomes a measurement revision.
 * The original definition remains the only canonical wording of that measurement. */
export async function updateQuestionLabel(
  deps: Dependencies,
  actor: Actor,
  input: QuestionLabelInput,
  context: { deadline: number; idempotencyKey: string },
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  validateQuestionLabel(input);
  const body = { questionId: input.questionId, expectedLabelRevision: input.expectedLabelRevision, label: input.label };
  const visible = await readableRealmQuestion(deps, actor, body.questionId, context.deadline);
  const realmId = visible.realmId!;
  const route = routeOf(body.questionId)!;
  const identity = principalCommandIdentity(actor);
  const kind = 'rating.question.label';
  const native = resourceAuthorization({
    access: deps.access, actor, action: 'realm:manage',
    anchor: {
      resource: { route, id: realmId },
      async validate(client, time) {
        const question = await questionRead.run(client, { question_id: body.questionId });
        if (!question || question.realmId !== realmId) throw new ProblemError('not_found');
        return !!(await realmRead.run(client, { route, id: realmId, at: authoritativeTimeValue(time) }));
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  return runCommand(deps.pool, {
    ...identity, partition: partitionOf(route), deadline: context.deadline, clock: deps.clock,
    receipt: {
      kind, key: context.idempotencyKey,
      digest: createHash('sha256').update(canonicalize([identity, kind, body])!).digest(),
    },
    authorization: {
      ...native,
      async prepare(attempt) {
        // Each retry, including receipt replay, refreshes disclosure before native
        // manage preparation. Both observations release before target checkout.
        await readableRealmQuestion(deps, actor, body.questionId, context.deadline);
        return native.prepare(attempt);
      },
    },
  }, async (tx) => {
    const head = await lock.run(tx, { question_id: body.questionId, realm_id: realmId });
    if (!head) throw new ProblemError('not_found');
    if (head.revision !== body.expectedLabelRevision) throw new ProblemError('conflict');
    const labelRevision = head.revision + 1;
    await append.run(tx, {
      question_id: body.questionId, revision: labelRevision, label: body.label, author_id: actor.accountId,
      at: authoritativeTimeValue(commandTime(tx)!),
    });
    return {
      value: { questionId: body.questionId, labelRevision, label: body.label },
      events: [{ type: QUESTION_LABEL_CHANGED, subject: body.questionId,
        data: { questionId: body.questionId, realmId, labelRevision } }],
    };
  });
}

async function readableRealmQuestion(deps: Dependencies, actor: Actor, questionId: string, deadline: number) {
  const question = await readVisibleRatingQuestion(deps, actor, questionId, deadline);
  if (!question || question.realmId === null) throw new ProblemError('not_found');
  return question;
}

type LabelRow = Awaited<ReturnType<typeof pageRead.run>>[number];

/** Hydrate only consumed provenance through the current account allowlist, never
 * copied profiles. Every author checkout is independently anchored and released. */
async function presentLabels(deps: Dependencies, rows: LabelRow[], deadline: number): Promise<QuestionLabel[]> {
  const authors = new Map<string, PublicIdentity>();
  const ids = [...new Set(rows.flatMap((row) => row.authorId === null ? [] : [row.authorId]))];
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) continue;
    const identities = await withReadTransaction(deps.pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      await partitionReadClient(bounded, partitionOf(route));
      return readPublicIdentities(bounded, [route], [id]);
    });
    for (const identity of identities) authors.set(identity.id, identity);
  }
  return rows.map((row) => ({
    questionId: row.questionId, labelRevision: row.labelRevision, label: row.label,
    at: row.at === null ? null : new Date(row.at).toISOString(),
    author: row.authorId === null ? null : authors.get(row.authorId) ?? null,
  }));
}

/** Exact captions are distinct from both creation wording and today's head. */
export async function readQuestionLabel(
  deps: Dependencies, actor: Actor, questionId: string, revision: number, deadline: number,
): Promise<QuestionLabel | null> {
  if (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647) throw new ProblemError('invalid_request');
  await readableRealmQuestion(deps, actor, questionId, deadline);
  const rows = await withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await partitionReadClient(bounded, partitionOf(routeOf(questionId)!));
    return exactRead.run(bounded, { question_id: questionId, revision });
  });
  const labels = await presentLabels(deps, rows, deadline);
  await readableRealmQuestion(deps, actor, questionId, deadline);
  return labels[0] ?? null;
}

/** Bounded ascending history, with a signed initial ceiling. A continuation never
 * changes selection, viewer/session authority, page budget or captured ceiling. */
export async function readQuestionLabelHistory(
  deps: Dependencies & { tokens: KeyRing }, actor: Actor,
  input: { questionId: string; limit: number; cursor?: string }, deadline: number,
): Promise<{ labels: QuestionLabel[]; next: string | null }> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new ProblemError('invalid_request');
  const question = await readableRealmQuestion(deps, actor, input.questionId, deadline);
  const authority = actor.kind === 'anonymous' ? actor : { ...actor, scopes: [...new Set(actor.scopes)].sort() };
  const binding: CursorBinding = {
    operation: 'rating.question-label-history',
    parameters: { questionId: input.questionId, realmId: question.realmId, limit: input.limit,
      authority: createHash('sha256').update(JSON.stringify(authority)).digest('hex') },
  };
  const now = () => (deps.clock?.() ?? new Date()).getTime();
  let after = 0;
  let ceiling = question.labelRevision ?? 1;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(deps.tokens, binding, input.cursor, now());
    if (!cursor.ok || cursor.epoch !== 1 || cursor.after.length !== 2 ||
        !cursor.after.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2_147_483_647) ||
        Number(cursor.after[0]) >= Number(cursor.after[1])) throw new ProblemError('invalid_cursor');
    after = Number(cursor.after[0]);
    ceiling = Number(cursor.after[1]);
  }
  const raw = await withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await partitionReadClient(bounded, partitionOf(routeOf(input.questionId)!));
    return pageRead.run(bounded, { question_id: input.questionId, after, ceiling, limit: input.limit });
  });
  const consumed = raw.slice(0, input.limit);
  const labels = await presentLabels(deps, consumed, deadline);
  await readableRealmQuestion(deps, actor, input.questionId, deadline);
  const last = consumed.at(-1)?.labelRevision;
  return { labels, next: raw.length > input.limit && last !== undefined
    ? encodeCursor(deps.tokens, binding, { epoch: 1, after: [last, ceiling] }, now()) : null };
}
