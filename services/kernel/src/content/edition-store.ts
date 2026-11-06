import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { CommandUnavailableError, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ReadContext, Anchored } from './model.ts';
import type { ContentEditionView, ContentEditionBenefit, ContentEditionSource } from './edition-model.ts';

export type EditionRow = {
  route: number;
  edition_id: string;
  target_subject_id: string;
  creator_account_id: string;
  thread_id: string;
  post_id: string;
  revision_id: string;
  sha256: string;
  licence: string;
  state: 'draft' | 'published' | 'unpublished';
  security_revision: string;
  recorded_transaction_id: string;
  created_at: string;
  inserted_here: boolean;
};
export type EditionDependencies = Readonly<{ pool: Pool; clock: () => Date }>;

/** Released, home-anchored bounded snapshots, including the final byte guard. */
export async function editionSnapshot<T>(
  deps: EditionDependencies,
  id: string,
  context: Pick<ReadContext, 'deadline'>,
  read: (client: AccessClient) => Promise<T>,
): Promise<Anchored<T>> {
  const route = routeOf(id);
  if (route === null) throw new RangeError('Invalid edition identity');
  return within(context.deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new CommandUnavailableError('overloaded', partitionOf(route));
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partition.partitionNo, partition.movedTo);
        const value = await read(client);
        await client.query('COMMIT');
        return { value, anchor: { partition, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** Reads own the time lifetime; commands use only the executor's attempt time. */
export async function withEditionReadTime<T>(
  deps: EditionDependencies,
  context: Pick<ReadContext, 'deadline'>,
  read: (time: AuthoritativeTime) => Promise<T>,
): Promise<T> {
  const time = await within(context.deadline, () =>
    withConnection(deps.pool, (client) => mintReadTime(deadlineClient(client, context.deadline), deps.clock)),
  );
  try {
    return await read(time);
  } finally {
    releaseOperationalTime(time);
  }
}

export async function editionRow(client: AccessClient, id: string): Promise<EditionRow | null> {
  const route = routeOf(id);
  if (route === null) return null;
  return (
    (
      await client.query<EditionRow>(
        `SELECT route, edition_id, creator_account_id, target_subject_id, thread_id, post_id, revision_id,
       encode(body_sha256,'hex') AS sha256, licence, state, security_revision::text,
       recorded_transaction_id, created_at::text,
       xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
     FROM content.edition WHERE route=$1 AND edition_id=$2`,
        [route, id],
      )
    ).rows[0] ?? null
  );
}

/** Native exact revision and its original writer, never a history search or current head substitute. */
export async function editionSource(
  client: AccessClient,
  postId: string,
  revisionId: string,
  targetSubjectId: string,
): Promise<ContentEditionSource | null> {
  const route = routeOf(postId);
  if (route === null || routeOf(revisionId) !== route || routeOf(targetSubjectId) === null) return null;
  const row = (
    await client.query<{
      thread_id: string;
      post_id: string;
      revision_id: string;
      sha256: string;
      licence: string;
      creator_account_id: string;
    }>(
      `SELECT p.thread_id, p.post_id, r.revision_id, encode(r.body_sha256,'hex') AS sha256,
          r.licence, p.author_account_id AS creator_account_id
      FROM content.post p JOIN content.revision r
        ON r.route=p.route AND r.thread_id=p.thread_id AND r.post_id=p.post_id AND r.revision_id=$3
      JOIN editorial.write_basis w ON w.partition_no=$4 AND w.transaction_id=r.recorded_transaction_id
        AND w.principal_kind='account' AND w.principal_id=p.author_account_id
      WHERE p.route=$1 AND p.post_id=$2 AND p.availability='available'
        AND p.visibility IN ('published','protected') AND r.availability='available'
        AND r.body IS NOT NULL AND r.body_sha256=sha256(r.body)
        AND $5::uuid=ANY(r.subject_ids)`,
      [route, postId, revisionId, partitionOf(route), targetSubjectId],
    )
  ).rows[0];
  return row
    ? {
        targetSubjectId,
        threadId: row.thread_id,
        postId: row.post_id,
        revisionId: row.revision_id,
        sha256: row.sha256,
        licence: row.licence,
        creatorAccountId: row.creator_account_id,
      }
    : null;
}
export function sourceOf(row: EditionRow): ContentEditionSource {
  return {
    targetSubjectId: row.target_subject_id,
    threadId: row.thread_id,
    postId: row.post_id,
    revisionId: row.revision_id,
    sha256: row.sha256,
    licence: row.licence,
    creatorAccountId: row.creator_account_id,
  };
}
export function sameSource(a: ContentEditionSource | null, b: ContentEditionSource): boolean {
  return (
    !!a &&
    a.targetSubjectId === b.targetSubjectId &&
    a.threadId === b.threadId &&
    a.postId === b.postId &&
    a.revisionId === b.revisionId &&
    a.sha256 === b.sha256 &&
    a.licence === b.licence &&
    a.creatorAccountId === b.creatorAccountId
  );
}
export function sameEdition(a: EditionRow | null, b: EditionRow): a is EditionRow {
  return (
    !!a &&
    a.edition_id === b.edition_id &&
    a.route === b.route &&
    a.state === b.state &&
    a.security_revision === b.security_revision &&
    a.recorded_transaction_id === b.recorded_transaction_id &&
    a.created_at === b.created_at &&
    sameSource(sourceOf(a), sourceOf(b))
  );
}
export function editionBenefit(row: EditionRow): ContentEditionBenefit {
  return Object.freeze({
    kind: 'content-edition',
    resourceType: 'content.edition',
    resource: Object.freeze({ route: row.route, id: row.edition_id }),
    version: Object.freeze({ revisionId: row.revision_id, sha256: row.sha256 }),
    action: 'edition:read',
  });
}
export function editionMetadata(row: EditionRow): ContentEditionView {
  return {
    editionId: row.edition_id,
    targetSubjectId: row.target_subject_id,
    state: row.state === 'unpublished' ? 'withdrawn' : row.state,
    creatorAccountId: row.creator_account_id,
    revisionId: row.revision_id,
    sha256: row.sha256,
    licence: row.licence,
    editionRevision: row.security_revision,
  };
}
export function editionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)!).digest('hex');
}
