import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { HostedPublicationStagingLocator } from './hosted-publication-staging-model.ts';

/** Uses the caller's existing active terminal-cleanup authority and shared row budget. */
export async function cleanupHostedLanguageCandidate(
  client: AccessClient,
  locator: HostedPublicationStagingLocator,
  limit: number,
): Promise<Readonly<{ deletedRows: number; complete: boolean }>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Hosted language cleanup exceeds its native page bound');
  const route = routeOf(locator.catalogueId);
  const identity = [route, locator.catalogueId, locator.stageId];
  const authority = await client.query<{ allowed: boolean }>(
    'SELECT content.hosted_language_cleanup_allowed($1,$2,$3) AS allowed',
    identity,
  );
  if (!authority.rows[0]?.allowed) throw new Error('Hosted language cleanup requires its active native step');

  let deletedRows = 0;
  const snapshots = await client.query(
    `WITH namespace AS MATERIALIZED (
       SELECT namespace_id FROM content.hosted_chapter_language_namespace
       WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3 AND stage_id=$3 AND state<>'published'
     ), page AS MATERIALIZED (
       SELECT s.occurrence_id,s.language FROM namespace n CROSS JOIN LATERAL (
         SELECT occurrence_id,language FROM content.hosted_chapter_language_snapshot
         WHERE route=$1 AND catalogue_id=$2 AND namespace_id=n.namespace_id
         ORDER BY occurrence_id,language LIMIT $4
       ) s
     ) DELETE FROM content.hosted_chapter_language_snapshot s USING page p
     WHERE s.route=$1 AND s.catalogue_id=$2 AND s.namespace_id=$3
       AND (s.occurrence_id,s.language)=(p.occurrence_id,p.language) RETURNING s.language`,
    [...identity, limit],
  );
  deletedRows += snapshots.rows.length;
  if (deletedRows < limit) {
    const namespace = await client.query(
      `DELETE FROM content.hosted_chapter_language_namespace n
       WHERE n.route=$1 AND n.catalogue_id=$2 AND n.namespace_id=$3 AND n.stage_id=$3 AND n.state<>'published'
         AND NOT EXISTS (SELECT 1 FROM content.hosted_chapter_language_snapshot s
                         WHERE s.route=$1 AND s.catalogue_id=$2 AND s.namespace_id=$3 LIMIT 1)
       RETURNING n.namespace_id`,
      identity,
    );
    deletedRows += namespace.rows.length;
  }
  if (deletedRows < limit) {
    const members = await client.query(
      `WITH page AS MATERIALIZED (
         SELECT thread_id,post_id,target_revision_id,body_sha256,occurrence_id
         FROM content.hosted_publication_language_target
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
         ORDER BY thread_id,post_id,target_revision_id,body_sha256,occurrence_id LIMIT $4
       ) DELETE FROM content.hosted_publication_language_target t USING page p
       WHERE t.route=$1 AND t.catalogue_id=$2 AND t.stage_id=$3
         AND (t.thread_id,t.post_id,t.target_revision_id,t.body_sha256,t.occurrence_id)=
             (p.thread_id,p.post_id,p.target_revision_id,p.body_sha256,p.occurrence_id)
       RETURNING t.occurrence_id`,
      [...identity, limit - deletedRows],
    );
    deletedRows += members.rows.length;
  }
  if (deletedRows < limit) {
    const progress = await client.query(
      `DELETE FROM content.hosted_publication_language_progress
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 RETURNING stage_id`,
      identity,
    );
    deletedRows += progress.rows.length;
  }
  const pending = await client.query<{ pending: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM content.hosted_chapter_language_namespace
                    WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3 AND stage_id=$3)
       OR EXISTS (SELECT 1 FROM content.hosted_publication_language_target
                  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 LIMIT 1)
       OR EXISTS (SELECT 1 FROM content.hosted_publication_language_progress
                  WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS pending`,
    identity,
  );
  return { deletedRows, complete: !pending.rows[0]?.pending };
}
