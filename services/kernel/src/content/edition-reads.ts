import { createHash } from 'node:crypto';
import { parseDocument, serializeDocument } from '@rezics/document';
import { accessCheck, type Access } from '../request/access.ts';
import type { Pool } from 'pg';
import { ContentNotFoundError, prepareEditionSource } from './reads.ts';
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
import { routeOf } from '../route/route.ts';
import type { ContentEditionView, ContentEditionRevisionView } from './edition-model.ts';

type Dependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date }>;
/** Closed authorized metadata never returns source post/thread IDs, body, URLs or history. */
export async function readContentEdition(deps: Dependencies, id: string, context: ReadContext) {
  return readEditionMetadata(deps, id, context, false);
}

/** Creator inventory additionally retains ordinary source authority, even after publication. */
export async function readCreatorContentEdition(deps: Dependencies, id: string, context: ReadContext) {
  return readEditionMetadata(deps, id, context, true);
}

async function readEditionMetadata(deps: Dependencies, id: string, context: ReadContext, creator: boolean) {
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
    return checked();
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
