import type { AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { withConnection } from '../database/pool.ts';
import type { AccessClient, Actor } from '../request/access.ts';
import { accessCheck, deadlineClient } from './access-port.ts';
import { prepareEditionSource } from './reads.ts';
import { editionSnapshot, withEditionReadTime } from './edition-store.ts';
import type { ContentEditionSource } from './edition-model.ts';
import type { ReadContext } from './model.ts';
import { contentPostBenefitForPost } from '../access/authenticated-benefit.ts';
import type { ContentPostSaleAuthority, ContentPostSaleDependencies } from './post-benefit.ts';
import sourceRead from './post-benefit-source.sql';

type SourceRow = {
  route: number;
  threadId: string;
  postId: string;
  creatorAccountId: string;
  revisionId: string;
  sha256: string;
  licence: string;
  subjectIds: string[];
  postVisibility: string;
  postAvailability: string;
  deletedAt: string | null;
  threadVisibility: string;
  threadAvailability: string;
  boardVisibility: string;
};

function sourceOf(row: SourceRow, targetSubjectId: string): ContentEditionSource {
  return {
    targetSubjectId,
    threadId: row.threadId,
    postId: row.postId,
    revisionId: row.revisionId,
    sha256: row.sha256,
    licence: row.licence,
    creatorAccountId: row.creatorAccountId,
  };
}

async function readSource(client: AccessClient, postId: string): Promise<SourceRow | null> {
  const route = routeOf(postId);
  if (route === null) return null;
  const rows = await sourceRead.run(client, { route, post_id: postId });
  if (rows.length > 1) throw new AccessUnavailableError('overloaded');
  const row = rows[0];
  if (
    !row ||
    row.route !== route ||
    row.postId !== postId ||
    routeOf(row.threadId) !== route ||
    routeOf(row.revisionId) !== route ||
    routeOf(row.creatorAccountId) === null ||
    row.postVisibility !== 'published' ||
    row.postAvailability !== 'available' ||
    row.deletedAt !== null ||
    row.threadVisibility !== 'published' ||
    row.threadAvailability !== 'available' ||
    row.boardVisibility !== 'published' ||
    !Array.isArray(row.subjectIds) ||
    row.subjectIds.some((id) => routeOf(id) === null) ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.licence !== 'string'
  )
    return null;
  return row;
}

function selectSubject(row: SourceRow, requested?: string): string | null {
  const subject = requested ?? [...row.subjectIds].sort()[0];
  if (subject === undefined || routeOf(subject) === null || !row.subjectIds.includes(subject)) return null;
  return subject;
}

function noQueryAuthority(row: SourceRow, targetSubjectId: string): ContentPostSaleAuthority {
  return Object.freeze({
    benefit: contentPostBenefitForPost(row.postId),
    creatorAccountId: row.creatorAccountId,
    targetSubjectId,
  });
}

async function checkOnSnapshot(
  dependencies: ContentPostSaleDependencies,
  row: SourceRow,
  actor: Actor,
  deadline: number,
  time: AuthoritativeTime,
): Promise<boolean> {
  const context = { pool: dependencies.pool, deadline, time };
  const checks = await Promise.all([
    accessCheck(dependencies.access, actor, 'post:sell', { route: row.route, id: row.postId }, context),
    accessCheck(dependencies.access, actor, 'post:revise', { route: row.route, id: row.postId }, context),
  ]);
  return withConnection(dependencies.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    for (const check of checks) if (!(await check(bounded, time))) return false;
    return true;
  });
}

/** Actual seller admission: current Post authorship plus the Content-owned
 * source/parent checks and separate native sale and source actions.
 */
export async function readContentPostSaleAuthority(
  dependencies: ContentPostSaleDependencies,
  postId: string,
  context: ReadContext,
  targetSubjectId?: string,
): Promise<ContentPostSaleAuthority | null> {
  if (routeOf(postId) === null || context.actor.kind !== 'account') return null;
  const deadline = Math.min(context.deadline, Date.now() + 1000);
  return withEditionReadTime(dependencies, { deadline }, async (time) => {
    const row = (await editionSnapshot(dependencies, postId, { deadline }, (client) => readSource(client, postId)))
      .value;
    if (!row || row.creatorAccountId !== context.actor.accountId) return null;
    const subjectId = selectSubject(row, targetSubjectId);
    if (!subjectId) return null;
    const source = sourceOf(row, subjectId);
    const accessContext = { pool: dependencies.pool, deadline, time };
    const guard = await prepareEditionSource(
      dependencies,
      source,
      { actor: context.actor, deadline },
      time,
      accessContext,
      true,
    );
    if (!guard || !(await guard.final())) return null;
    if (!(await checkOnSnapshot(dependencies, row, context.actor, deadline, time))) return null;
    const finalRow = (await editionSnapshot(dependencies, postId, { deadline }, (client) => readSource(client, postId)))
      .value;
    if (
      !finalRow ||
      finalRow.creatorAccountId !== context.actor.accountId ||
      finalRow.revisionId !== row.revisionId ||
      finalRow.sha256 !== row.sha256 ||
      finalRow.licence !== row.licence ||
      !(await guard.final()) ||
      !(await checkOnSnapshot(dependencies, finalRow, context.actor, deadline, time))
    )
      return null;
    return noQueryAuthority(finalRow, subjectId);
  });
}

/** Mechanical settlement checks stable Post provenance and withdrawal/erasure.
 * It carries no seller actor and never changes Content's eventual read decision.
 */
export async function readContentPostMechanicalSaleAuthority(
  dependencies: ContentPostSaleDependencies,
  postId: string,
  targetSubjectId: string,
  context: Readonly<{ deadline: number }>,
): Promise<ContentPostSaleAuthority | null> {
  if (routeOf(postId) === null || routeOf(targetSubjectId) === null) return null;
  const deadline = Math.min(context.deadline, Date.now() + 1000);
  return withEditionReadTime(dependencies, { deadline }, async () => {
    const row = (await editionSnapshot(dependencies, postId, { deadline }, (client) => readSource(client, postId)))
      .value;
    if (!row) return null;
    const final = (await editionSnapshot(dependencies, postId, { deadline }, (client) => readSource(client, postId)))
      .value;
    if (
      !final ||
      final.creatorAccountId !== row.creatorAccountId ||
      final.threadId !== row.threadId ||
      final.postId !== row.postId
    )
      return null;
    return noQueryAuthority(final, targetSubjectId);
  });
}
