import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import readRevisionBatch from './read-revision-batch.sql';
import readContainingThread from './read-containing-post-thread.sql';
import type { EditionIdentity } from './edition-model.ts';
import { createHash } from 'node:crypto';
import { parseDocument, serializeDocument } from '@rezics/document';
import { accessCheck, type Access } from '../request/access.ts';
import type { Pool } from 'pg';
import { ContentNotFoundError, prepareEditionSource, readPost, type ContentReadDependencies } from './reads.ts';
import type { ReadContext } from './model.ts';
import {
  editionBenefit,
  editionMetadata,
  editionRow,
  editionSnapshot,
  editionSource,
  sameEdition,
  sameSource,
  sourceOf,
  withEditionReadTime,
} from './edition-store.ts';
import { prepareContentEditionSale } from './edition-sale.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ContentEditionView, ContentEditionRevisionView } from './edition-model.ts';

type Dependencies = Readonly<{ pool: Pool; access: Access; clock: () => Date }>;
/** Closed authorized metadata never returns source post/thread IDs, body, URLs or history. */
export async function readContentEdition(deps: Dependencies, id: string, context: ReadContext, identity = false) {
  return readEditionMetadata(deps, id, context, false, identity);
}

/** Creator inventory additionally retains ordinary source authority, even after publication. */
export async function readCreatorContentEdition(deps: Dependencies, id: string, context: ReadContext, identity = true) {
  return readEditionMetadata(deps, id, context, true, identity);
}

async function readEditionMetadata(
  deps: Dependencies,
  id: string,
  context: ReadContext,
  creator: boolean,
  identity = true,
) {
  if (routeOf(id) === null) throw new ContentNotFoundError();
  return withEditionReadTime(deps, context, async (time) => {
    const row = (await editionSnapshot(deps, id, context, (client) => editionRow(client, id))).value;
    if (!row) throw new ContentNotFoundError();
    if (creator && (context.actor.kind !== 'account' || context.actor.accountId !== row.creator_account_id))
      throw new ContentNotFoundError();
    if (
      row.state !== 'published' &&
      (context.actor.kind !== 'account' || context.actor.accountId !== row.creator_account_id)
    )
      throw new ContentNotFoundError();
    const accessContext = { pool: deps.pool, deadline: context.deadline, time };
    const source = sourceOf(row);
    const guard = await prepareEditionSource(
      deps,
      source,
      context,
      time,
      accessContext,
      creator || row.state !== 'published',
    );
    if (!guard || !(await guard.final())) throw new ContentNotFoundError();
    const resource = {
      route: row.route,
      id,
      ...(row.state === 'published' ? { authenticatedBenefit: editionBenefit(row) } : {}),
    };
    const allowed = await accessCheck(deps.access, context.actor, 'edition:read', resource, accessContext);
    const checked = async () =>
      editionSnapshot(deps, id, context, async (client): Promise<ContentEditionView> => {
        if (
          !sameEdition(await editionRow(client, id), row) ||
          !sameSource(await editionSource(client, row.post_id, row.revision_id, row.target_subject_id), source) ||
          !(await guard.check(client)) ||
          !(await allowed(client, time))
        )
          throw new ContentNotFoundError();
        return editionMetadata(row);
      });
    await checked();
    if (!(await guard.final())) throw new ContentNotFoundError();
    const result = await checked();
    if (!identity) return result;
    const identities = await prepareEditionIdentities(
      deps,
      [result.value],
      context,
      creator || row.state !== 'published',
    );
    if (!(await guard.final())) throw new ContentNotFoundError();
    const final = await checked();
    return { ...final, value: { ...final.value, identity: (await identities()).get(id)! } };
  });
}

/** Fixed canonical bytes, after current seller, buyer and source/ancestry checks. No conditional shortcut. */
export async function readContentEditionRevision(deps: Dependencies, id: string, context: ReadContext) {
  if (routeOf(id) === null) throw new ContentNotFoundError();
  return withEditionReadTime(deps, context, async (time) => {
    const boundedContext = { ...context, deadline: Math.min(context.deadline, Date.now() + 1000) };
    const sale = await prepareContentEditionSale(deps, id, boundedContext, time);
    if (!sale) throw new ContentNotFoundError();
    const row = sale.row;
    const accessContext = { pool: deps.pool, deadline: boundedContext.deadline, time };
    const source = sourceOf(row);
    const guard = await prepareEditionSource(deps, source, boundedContext, time, accessContext, false);
    if (!guard || !(await guard.final())) throw new ContentNotFoundError();
    const allowed = await accessCheck(
      deps.access,
      context.actor,
      'edition:read',
      { route: row.route, id, authenticatedBenefit: editionBenefit(row) },
      accessContext,
    );
    if (!(await sale.final())) throw new ContentNotFoundError();
    if (!(await guard.final())) throw new ContentNotFoundError();
    return editionSnapshot(deps, id, accessContext, async (client): Promise<ContentEditionRevisionView> => {
      if (
        !sameEdition(await editionRow(client, id), row) ||
        !sameSource(await editionSource(client, row.post_id, row.revision_id, row.target_subject_id), source) ||
        !(await guard.check(client)) ||
        !(await allowed(client, time))
      )
        throw new ContentNotFoundError();
      const selected = (
        await client.query<{ body: Buffer }>(
          `SELECT body FROM content.revision
        WHERE route=$1 AND thread_id=$2 AND post_id=$3 AND revision_id=$4 AND availability='available'
          AND body IS NOT NULL AND body_sha256=decode($5,'hex') AND licence=$6`,
          [row.route, row.thread_id, row.post_id, row.revision_id, row.sha256, row.licence],
        )
      ).rows[0];
      if (!selected || createHash('sha256').update(selected.body).digest('hex') !== row.sha256)
        throw new ContentNotFoundError();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(selected.body);
      const body = parseDocument(JSON.parse(text));
      if (serializeDocument(body) !== text) throw new ContentNotFoundError();
      return { editionId: row.edition_id, revisionId: row.revision_id, sha256: row.sha256, licence: row.licence, body };
    });
  });
}

/** Metadata only: one exact revision row-kind read per partition; never bytes,
 * history or current heads. The caller has already applied native source authority. */
async function revisionDates(
  deps: Dependencies,
  revisions: readonly Readonly<{ revisionId: string; sha256: string; licence: string }>[],
  context: ReadContext,
): Promise<Map<string, string>> {
  if (revisions.length > 100) throw new RangeError('Edition identity accepts at most 100 revisions');
  return withReadTransaction(
    deps.pool,
    async (client) => {
      const partitions = [...new Set(revisions.map((row) => partitionOf(routeOf(row.revisionId)!)))];
      await partitionReadClients(client, partitions);
      const dates = new Map<string, string>();
      for (const partition of partitions) {
        const group = revisions.filter((row) => partitionOf(routeOf(row.revisionId)!) === partition);
        const rows = await readRevisionBatch.run(client, {
          keys: group.map((row) => ({ route: routeOf(row.revisionId)!, id: row.revisionId })),
          include_body: false,
          query: '',
        });
        for (const row of rows) {
          if (row.availability !== 'available' || !row.sha256 || !row.created_at) continue;
          if (
            group.some(
              (pin) =>
                pin.revisionId === row.id &&
                pin.sha256 === Buffer.from(row.sha256!).toString('hex') &&
                pin.licence === row.licence,
            )
          )
            dates.set(row.id, new Date(row.created_at).toISOString());
        }
      }
      return dates;
    },
    context.deadline,
  );
}

/** Read exact revision metadata before final native source checks. The returned
 * reader refreshes independently authorized subject labels after those checks. */
export async function prepareEditionIdentities(
  deps: Dependencies,
  editions: readonly ContentEditionView[],
  context: ReadContext,
  ordinarySource = true,
) {
  if (editions.length > 100) throw new RangeError('Edition identity accepts at most 100 editions');
  const subjects = await prepareEditionSubjectIdentities(
    deps,
    editions.map((edition) => edition.targetSubjectId),
    context,
  );
  const dates = ordinarySource ? await revisionDates(deps, editions, context) : new Map<string, string>();
  return async (): Promise<Map<string, EditionIdentity>> => {
    const labels = await subjects();
    return new Map(
      editions.map((edition) => [
        edition.editionId,
        {
          subject: labels.get(edition.targetSubjectId)!,
          revisionCreatedAt: dates.get(edition.revisionId) ?? null,
        },
      ]),
    );
  };
}

/** Ordinary exact document authority owns both candidate associations and date.
 * Edition ownership supplies no source or subject permission. */
export async function readEditionSourceIdentity(
  deps: ContentReadDependencies,
  input: Readonly<{ postId: string; revisionId: string }>,
  context: ReadContext,
) {
  const route = routeOf(input.postId);
  if (route === null || routeOf(input.revisionId) !== route) throw new ContentNotFoundError();
  const thread = (
    await editionSnapshot(deps, input.postId, context, (client) =>
      readContainingThread.run(client, { route, id: input.postId }),
    )
  ).value;
  if (!thread) throw new ContentNotFoundError();
  const exact = await readPost(deps, thread.thread_id, input.postId, context, input.revisionId);
  const post = exact.value;
  if (
    !post ||
    post.availability !== 'available' ||
    post.revisionId !== input.revisionId ||
    context.actor.kind !== 'account' ||
    post.authorId !== context.actor.accountId ||
    !['published', 'protected'].includes(post.visibility) ||
    post.subjectIds.length > 128
  )
    throw new ContentNotFoundError();
  const subjects = await prepareEditionSubjectIdentities(deps, post.subjectIds, context);
  const dates = await revisionDates(
    deps,
    [{ revisionId: post.revisionId, sha256: post.sha256, licence: post.licence }],
    context,
  );
  const final = await readPost(deps, thread.thread_id, input.postId, context, input.revisionId);
  const current = final.value;
  if (
    !current ||
    current.availability !== 'available' ||
    current.revisionId !== post.revisionId ||
    current.sha256 !== post.sha256 ||
    current.licence !== post.licence ||
    current.authorId !== post.authorId ||
    !['published', 'protected'].includes(current.visibility) ||
    JSON.stringify(current.subjectIds) !== JSON.stringify(post.subjectIds)
  )
    throw new ContentNotFoundError();
  return {
    ...final,
    value: {
      post: current,
      editionIdentity: {
        postId: current.id,
        revisionId: current.revisionId,
        sha256: current.sha256,
        revisionCreatedAt: dates.get(current.revisionId) ?? null,
        subjects: [...(await subjects()).values()],
      },
    },
  };
}
