import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { CommandUnavailableError } from '../request/unavailable.ts';
import { resourceAuthorization } from '../access/index.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, commandTime, principalCommandIdentity, runCommand } from '../command/command.ts';
import realmRead from '../community/realm-read.sql';
import { partitionReadClientObservation } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Partition } from '../partition/partition.ts';
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
export type QuestionLabelHistory = { labels: QuestionLabel[]; next: string | null };

export function validateQuestionLabel(input: QuestionLabelInput): void {
  if (!input || routeOf(input.questionId) === null) throw new QuestionDefinitionInvalidError('questionId');
  if (
    !Number.isInteger(input.expectedLabelRevision) ||
    input.expectedLabelRevision < 1 ||
    input.expectedLabelRevision >= 2_147_483_647
  )
    throw new QuestionDefinitionInvalidError('expectedLabelRevision');
  if (
    typeof input.label !== 'string' ||
    !input.label.trim() ||
    [...input.label].length > 200 ||
    input.label.includes('\0')
  )
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
    access: deps.access,
    actor,
    action: 'realm:manage',
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
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, body])!)
          .digest(),
      },
      authorization: {
        ...native,
        async prepare(attempt) {
          // Each retry, including receipt replay, refreshes disclosure before native
          // manage preparation. Both observations release before target checkout.
          await readableRealmQuestion(deps, actor, body.questionId, context.deadline);
          return native.prepare!(attempt);
        },
      },
    },
    async (tx) => {
      const head = await lock.run(tx, { question_id: body.questionId, realm_id: realmId });
      if (!head) throw new ProblemError('not_found');
      if (head.revision !== body.expectedLabelRevision) throw new ProblemError('conflict');
      const labelRevision = head.revision + 1;
      await append.run(tx, {
        question_id: body.questionId,
        revision: labelRevision,
        label: body.label,
        author_id: actor.accountId,
        at: authoritativeTimeValue(commandTime(tx)!),
      });
      return {
        value: { questionId: body.questionId, labelRevision, label: body.label },
        events: [
          {
            type: QUESTION_LABEL_CHANGED,
            subject: body.questionId,
            data: { questionId: body.questionId, realmId, labelRevision },
          },
        ],
      };
    },
  );
}

async function readableRealmQuestion(deps: Dependencies, actor: Actor, questionId: string, deadline: number) {
  const question = await readVisibleRatingQuestion(deps, actor, questionId, deadline);
  if (!question || question.realmId === null) throw new ProblemError('not_found');
  return question;
}

type LabelRow = Awaited<ReturnType<typeof pageRead.run>>[number];

type AuthorObservation = {
  identities: Map<string, PublicIdentity>;
  epochs: Map<number, number>;
};

type LabelObservation = {
  partition: Partition;
  question: NonNullable<Awaited<ReturnType<typeof questionRead.run>>>;
  rows: LabelRow[];
};

type LabelPageObservation = LabelObservation & {
  after: number;
  ceiling: number;
};

function sameQuestionDefinition(
  left: NonNullable<Awaited<ReturnType<typeof questionRead.run>>>,
  right: NonNullable<Awaited<ReturnType<typeof questionRead.run>>>,
): boolean {
  return (
    left.id === right.id &&
    left.realmId === right.realmId &&
    left.ownerId === right.ownerId &&
    left.revision === right.revision &&
    left.label === right.label &&
    left.meaning === right.meaning &&
    left.grain === right.grain &&
    left.minimumUnits === right.minimumUnits &&
    left.maximumUnits === right.maximumUnits &&
    left.stepUnits === right.stepUnits
  );
}

function sameLabelRows(left: LabelRow[], right: LabelRow[]): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const other = right[index]!;
      return (
        row.questionId === other.questionId &&
        row.labelRevision === other.labelRevision &&
        row.label === other.label &&
        row.authorId === other.authorId &&
        row.at === other.at
      );
    })
  );
}

async function observeAuthors(deps: Dependencies, rows: LabelRow[], deadline: number): Promise<AuthorObservation> {
  const identities = new Map<string, PublicIdentity>();
  const epochs = new Map<number, number>();
  const ids = [...new Set(rows.flatMap((row) => (row.authorId === null ? [] : [row.authorId])))];
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) continue;
    const home = partitionOf(route);
    const observation = await withReadTransaction(deps.pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      const bound = await partitionReadClientObservation(bounded, home);
      return {
        epoch: bound.partition.epoch,
        identities: await readPublicIdentities(bound.client, [route], [id]),
      };
    });
    const previousEpoch = epochs.get(home);
    if (previousEpoch !== undefined && previousEpoch !== observation.epoch)
      throw new CommandUnavailableError('fenced', home);
    epochs.set(home, observation.epoch);
    for (const identity of observation.identities) identities.set(identity.id, identity);
  }
  return { identities, epochs };
}

function samePublicIdentity(left: PublicIdentity | undefined, right: PublicIdentity | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentAuthors(first: AuthorObservation, latest: AuthorObservation): Map<string, PublicIdentity> {
  for (const [home, epoch] of first.epochs)
    if (latest.epochs.get(home) !== epoch) throw new CommandUnavailableError('fenced', home);
  const identities = new Map<string, PublicIdentity>();
  for (const id of new Set([...first.identities.keys(), ...latest.identities.keys()])) {
    const before = first.identities.get(id);
    const now = latest.identities.get(id);
    const current = samePublicIdentity(before, now) ? before : now;
    if (current) identities.set(id, current);
  }
  return identities;
}

function labelValues(rows: LabelRow[], authors: Map<string, PublicIdentity>): QuestionLabel[] {
  return rows.map((row) => ({
    questionId: row.questionId,
    labelRevision: row.labelRevision,
    label: row.label,
    at: row.at === null ? null : new Date(row.at).toISOString(),
    author: row.authorId === null ? null : (authors.get(row.authorId) ?? null),
  }));
}

async function observeLabelPage(
  deps: Dependencies & { tokens: KeyRing },
  input: { questionId: string; limit: number },
  deadline: number,
  binding: CursorBinding,
  cursor?: string,
  selection?: { after: number; ceiling: number },
): Promise<LabelPageObservation> {
  const route = routeOf(input.questionId);
  if (route === null) throw new ProblemError('not_found');
  const home = partitionOf(route);
  return withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    const bound = await partitionReadClientObservation(bounded, home);
    const question = await questionRead.run(bound.client, { question_id: input.questionId });
    if (!question || question.realmId === null) throw new ProblemError('not_found');

    let after = selection?.after ?? 0;
    let ceiling = selection?.ceiling ?? question.labelRevision ?? 1;
    if (cursor !== undefined) {
      const decoded = decodeCursor(deps.tokens, binding, cursor, (deps.clock?.() ?? new Date()).getTime());
      if (
        !decoded.ok ||
        decoded.after.length !== 2 ||
        !decoded.after.every(
          (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647,
        ) ||
        Number(decoded.after[0]) >= Number(decoded.after[1])
      )
        throw new ProblemError('invalid_cursor');
      if (decoded.epoch !== bound.partition.epoch) throw new ProblemError('stale_cursor');
      after = Number(decoded.after[0]);
      ceiling = Number(decoded.after[1]);
    }
    const rows = await pageRead.run(bound.client, {
      question_id: input.questionId,
      after,
      ceiling,
      limit: input.limit,
    });
    return { partition: bound.partition, question, rows, after, ceiling };
  });
}

async function observeQuestionHome(deps: Dependencies, questionId: string, deadline: number): Promise<Partition> {
  const route = routeOf(questionId);
  if (route === null) throw new ProblemError('not_found');
  return withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    return (await partitionReadClientObservation(bounded, partitionOf(route))).partition;
  });
}

async function finishLabelSource(
  deps: Dependencies,
  actor: Actor,
  questionId: string,
  deadline: number,
  initial: LabelObservation,
  latest: LabelObservation,
  continuation: boolean,
): Promise<void> {
  const currentQuestion = await readableRealmQuestion(deps, actor, questionId, deadline);
  if (
    !sameQuestionDefinition(initial.question, latest.question) ||
    !sameQuestionDefinition(initial.question, currentQuestion)
  )
    throw new ProblemError('not_found');
  const finalHome = await observeQuestionHome(deps, questionId, deadline);
  if (
    latest.partition.partitionNo !== initial.partition.partitionNo ||
    latest.partition.epoch !== initial.partition.epoch ||
    finalHome.partitionNo !== initial.partition.partitionNo ||
    finalHome.epoch !== initial.partition.epoch
  ) {
    if (continuation) throw new ProblemError('stale_cursor');
    throw new CommandUnavailableError('fenced', initial.partition.partitionNo);
  }
  if (!sameLabelRows(initial.rows, latest.rows))
    throw new CommandUnavailableError('fenced', initial.partition.partitionNo);
}

async function observeExactLabel(
  deps: Dependencies,
  questionId: string,
  revision: number,
  deadline: number,
): Promise<LabelObservation> {
  return withReadTransaction(deps.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    const bound = await partitionReadClientObservation(bounded, partitionOf(routeOf(questionId)!));
    const question = await questionRead.run(bound.client, { question_id: questionId });
    if (!question || question.realmId === null) throw new ProblemError('not_found');
    return {
      partition: bound.partition,
      question,
      rows: await exactRead.run(bound.client, { question_id: questionId, revision }),
    };
  });
}

/** Exact captions are distinct from both creation wording and today's head. */
export async function readQuestionLabel(
  deps: Dependencies,
  actor: Actor,
  questionId: string,
  revision: number,
  deadline: number,
): Promise<QuestionLabel | null> {
  if (!Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647)
    throw new ProblemError('invalid_request');
  const question = await readableRealmQuestion(deps, actor, questionId, deadline);
  const initial = await observeExactLabel(deps, questionId, revision, deadline);
  if (!sameQuestionDefinition(question, initial.question)) throw new ProblemError('not_found');
  const firstAuthors = await observeAuthors(deps, initial.rows, deadline);
  const latestAuthors = await observeAuthors(deps, initial.rows, deadline);
  const latest = await observeExactLabel(deps, questionId, revision, deadline);
  await finishLabelSource(deps, actor, questionId, deadline, initial, latest, false);
  return labelValues(initial.rows, currentAuthors(firstAuthors, latestAuthors))[0] ?? null;
}

/** Bounded ascending history, with a signed initial ceiling. A continuation never
 * changes selection, viewer/session authority, page budget or captured ceiling. */
export async function readQuestionLabelHistory(
  deps: Dependencies & { tokens: KeyRing },
  actor: Actor,
  input: { questionId: string; limit: number; cursor?: string },
  deadline: number,
): Promise<QuestionLabelHistory> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new ProblemError('invalid_request');
  const question = await readableRealmQuestion(deps, actor, input.questionId, deadline);
  const route = routeOf(input.questionId)!;
  const home = partitionOf(route);
  const authority = actor.kind === 'anonymous' ? actor : { ...actor, scopes: [...new Set(actor.scopes)].sort() };
  const binding: CursorBinding = {
    operation: 'rating.question-label-history',
    parameters: {
      questionId: input.questionId,
      realmId: question.realmId,
      partition: home,
      limit: input.limit,
      authority: createHash('sha256').update(JSON.stringify(authority)).digest('hex'),
    },
  };
  const now = () => (deps.clock?.() ?? new Date()).getTime();
  const initial = await observeLabelPage(deps, input, deadline, binding, input.cursor);
  if (!sameQuestionDefinition(question, initial.question)) throw new ProblemError('not_found');
  const consumed = initial.rows.slice(0, input.limit);
  const firstAuthors = await observeAuthors(deps, consumed, deadline);
  const latestAuthors = await observeAuthors(deps, consumed, deadline);
  const authors = currentAuthors(firstAuthors, latestAuthors);
  const finalSource = await observeLabelPage(deps, input, deadline, binding, undefined, {
    after: initial.after,
    ceiling: initial.ceiling,
  });
  await finishLabelSource(deps, actor, input.questionId, deadline, initial, finalSource, true);
  const labels = labelValues(consumed, authors);
  const last = consumed.at(-1)?.labelRevision;
  return {
    labels,
    next:
      initial.rows.length > input.limit && last !== undefined
        ? encodeCursor(deps.tokens, binding, { epoch: initial.partition.epoch, after: [last, initial.ceiling] }, now())
        : null,
  };
}
