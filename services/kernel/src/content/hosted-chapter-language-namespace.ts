import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { HOSTED_PAGE_LIMIT } from './hosted-chapters-limits.ts';
import type { HostedChapterTarget } from './hosted-chapters-model.ts';
import type { HostedLanguageBinding } from './hosted-chapter-language-store.ts';

export type HostedLanguageNamespaceRow = Readonly<{
  occurrenceId: string;
  language: string;
  firstVersion: string;
  title: string;
  target: HostedChapterTarget;
}>;

export async function createHostedLanguageNamespace(
  client: AccessClient,
  catalogueId: string,
  namespaceId: string,
  stageId?: string,
): Promise<void> {
  const parameters = [routeOf(catalogueId), catalogueId, namespaceId, stageId ?? null];
  await client.query(
    `INSERT INTO content.hosted_chapter_language_namespace(route,catalogue_id,namespace_id,stage_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT (route,catalogue_id,namespace_id) DO NOTHING`,
    parameters,
  );
  const existing = await client.query<{ valid: boolean }>(
    `SELECT state='published' OR stage_id IS NOT DISTINCT FROM $4::uuid AS valid
     FROM content.hosted_chapter_language_namespace
     WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3`,
    parameters,
  );
  if (!existing.rows[0]?.valid) throw new Error('Hosted language namespace owner changed');
}

/** One admitted ingestion step. The producer proves source completion before sealing. */
export async function appendHostedLanguageNamespaceRows(
  client: AccessClient,
  catalogueId: string,
  namespaceId: string,
  rows: readonly HostedLanguageNamespaceRow[],
): Promise<void> {
  if (rows.length > HOSTED_PAGE_LIMIT) throw new RangeError('Hosted language namespace step exceeds its page bound');
  const route = routeOf(catalogueId);
  for (const row of rows) {
    const parameters = [
      route,
      catalogueId,
      namespaceId,
      row.occurrenceId,
      row.language,
      row.firstVersion,
      row.title,
      JSON.stringify(row.target),
    ];
    const inserted = await client.query(
      `INSERT INTO content.hosted_chapter_language_snapshot
       (route,catalogue_id,namespace_id,occurrence_id,language,first_version,title,target)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,$7,$8::jsonb)
       ON CONFLICT (route,catalogue_id,namespace_id,occurrence_id,language) DO NOTHING
       RETURNING language`,
      parameters,
    );
    if (inserted.rows.length) continue;
    const identical = await client.query<{ same: boolean }>(
      `SELECT first_version=$6::bigint AND title=$7 AND target=$8::jsonb AND NOT title_redacted AS same
       FROM content.hosted_chapter_language_snapshot
       WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3 AND occurrence_id=$4 AND language=$5`,
      parameters,
    );
    if (!identical.rows[0]?.same) throw new Error('Hosted language namespace selection changed');
  }
}

export async function sealHostedLanguageNamespace(
  client: AccessClient,
  catalogueId: string,
  namespaceId: string,
): Promise<void> {
  const parameters = [routeOf(catalogueId), catalogueId, namespaceId];
  await client.query(
    `UPDATE content.hosted_chapter_language_namespace SET state='sealed'
     WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3 AND state='open'`,
    parameters,
  );
  const sealed = await client.query<{ ready: boolean }>(
    `SELECT state IN ('sealed','published') AS ready FROM content.hosted_chapter_language_namespace
     WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3`,
    parameters,
  );
  if (!sealed.rows[0]?.ready) throw new Error('Hosted language namespace is not prepared');
}

/** Called only in the transaction installing the immutable public revision and pointer. */
export async function publishHostedLanguageNamespace(
  client: AccessClient,
  catalogueId: string,
  namespaceId: string,
  publicationId: string,
): Promise<void> {
  const parameters = [routeOf(catalogueId), catalogueId, namespaceId, publicationId];
  await client.query(
    `UPDATE content.hosted_chapter_language_namespace n
     SET state='published',publication_id=$4,stage_id=NULL
     WHERE n.route=$1 AND n.catalogue_id=$2 AND n.namespace_id=$3 AND n.state='sealed'
       AND EXISTS (SELECT 1 FROM content.hosted_structure_revision r
                   WHERE r.route=$1 AND r.catalogue_id=$2 AND r.revision_id=$4 AND r.kind='publication')`,
    parameters,
  );
  const published = await client.query<{ ready: boolean }>(
    `SELECT state='published' AND publication_id=$4 AS ready FROM content.hosted_chapter_language_namespace
     WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3`,
    parameters,
  );
  if (!published.rows[0]?.ready) throw new Error('Hosted language namespace has no activated publication');
}

export async function readHostedLanguageNamespaceBinding(
  client: AccessClient,
  catalogueId: string,
  namespaceId: string,
  occurrenceId: string,
  language: string,
): Promise<HostedLanguageBinding | null> {
  const result = await client.query<HostedLanguageBinding>(
    `SELECT s.language,s.first_version::text AS "firstVersion",s.title,s.target
     FROM content.hosted_chapter_language_namespace n
     JOIN content.hosted_chapter_language_snapshot s USING (route,catalogue_id,namespace_id)
     WHERE n.route=$1 AND n.catalogue_id=$2 AND n.namespace_id=$3 AND n.state='published'
       AND s.occurrence_id=$4 AND s.language=$5`,
    [routeOf(catalogueId), catalogueId, namespaceId, occurrenceId, language],
  );
  return result.rows[0] ?? null;
}

/** Bound the raw namespace-key page before metadata/current-target disclosure. */
export async function pageHostedLanguageNamespaceBindings(
  client: AccessClient,
  catalogueId: string,
  namespaceId: string,
  occurrenceId: string,
  after: Readonly<{ firstVersion: string; language: string }> | null,
  limit: number,
): Promise<readonly HostedLanguageBinding[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PAGE_LIMIT + 1)
    throw new RangeError('Hosted language namespace page exceeds its bound');
  const result = await client.query<HostedLanguageBinding>(
    `SELECT s.language,s.first_version::text AS "firstVersion",s.title,s.target
     FROM content.hosted_chapter_language_namespace n
     CROSS JOIN LATERAL (
       (SELECT language,first_version,title,target FROM content.hosted_chapter_language_snapshot
        WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3 AND occurrence_id=$4 AND $5::bigint IS NULL
        ORDER BY first_version,language LIMIT $7)
       UNION ALL
       (SELECT language,first_version,title,target FROM content.hosted_chapter_language_snapshot
        WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3 AND occurrence_id=$4 AND $5::bigint IS NOT NULL
          AND (first_version,language)>($5::bigint,$6::text COLLATE "C")
        ORDER BY first_version,language LIMIT $7)
     ) s
     WHERE n.route=$1 AND n.catalogue_id=$2 AND n.namespace_id=$3 AND n.state='published'
     ORDER BY s.first_version,s.language`,
    [
      routeOf(catalogueId),
      catalogueId,
      namespaceId,
      occurrenceId,
      after?.firstVersion ?? null,
      after?.language ?? null,
      limit,
    ],
  );
  return result.rows;
}
