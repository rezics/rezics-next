import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { HostedChapterTarget, HostedChapterLanguages } from './hosted-chapters-model.ts';
import {
  readHostedLanguageNamespaceBinding,
  pageHostedLanguageNamespaceBindings,
} from './hosted-chapter-language-namespace.ts';

export type HostedLanguageBinding = Readonly<{
  language: string;
  firstVersion: string;
  title: string | null;
  target: HostedChapterTarget | null;
}>;

/** Full immutable occurrence/language/version key; never select by a guessed body digest. */
export async function readHostedLanguageBinding(
  client: AccessClient,
  catalogueId: string,
  occurrenceId: string,
  selection: string | HostedChapterLanguages,
  language: string,
): Promise<HostedLanguageBinding | null> {
  if (typeof selection !== 'string' && selection.namespaceId !== undefined)
    return readHostedLanguageNamespaceBinding(client, catalogueId, selection.namespaceId, occurrenceId, language);
  const version = typeof selection === 'string' ? selection : selection.version;
  const row = (
    await client.query<{ title: string | null; target: HostedChapterTarget | null }>(
      `SELECT title,target FROM content.hosted_chapter_language_binding
     WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3 AND language=$4 AND version<=$5::bigint
     ORDER BY version DESC LIMIT 1`,
      [routeOf(catalogueId), catalogueId, occurrenceId, language, version],
    )
  ).rows[0];
  return row ? { language, firstVersion: '0', ...row } : null;
}

/** The admitted raw key window is bounded before temporal lookup and disclosure. Future private keys
 * lie past the immutable version frontier, so they cannot change an old release's continuation. */
export async function pageHostedLanguageBindings(
  client: AccessClient,
  catalogueId: string,
  occurrenceId: string,
  selection: string | HostedChapterLanguages,
  after: Readonly<{ firstVersion: string; language: string }> | null,
  limit: number,
): Promise<readonly HostedLanguageBinding[]> {
  if (typeof selection !== 'string' && selection.namespaceId !== undefined)
    return pageHostedLanguageNamespaceBindings(client, catalogueId, selection.namespaceId, occurrenceId, after, limit);
  const version = typeof selection === 'string' ? selection : selection.version;
  return (
    await client.query<HostedLanguageBinding>(
      `WITH first_keys AS (
       SELECT language,first_version FROM content.hosted_chapter_language_key
       WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3 AND first_version<=$4::bigint
         AND $5::bigint IS NULL
       ORDER BY first_version,language LIMIT $7
     ), continued_keys AS (
       SELECT language,first_version FROM content.hosted_chapter_language_key
       WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3 AND first_version<=$4::bigint
         AND $5::bigint IS NOT NULL AND (first_version,language)>($5::bigint,$6::text COLLATE "C")
       ORDER BY first_version,language LIMIT $7
     ), keys AS MATERIALIZED (
       SELECT language,first_version FROM first_keys
       UNION ALL SELECT language,first_version FROM continued_keys
       ORDER BY first_version,language LIMIT $7
     )
     SELECT keys.language,keys.first_version::text AS "firstVersion",binding.title,binding.target
     FROM keys LEFT JOIN LATERAL (
       SELECT title,target FROM content.hosted_chapter_language_binding
       WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3 AND language=keys.language AND version<=$4::bigint
       ORDER BY version DESC LIMIT 1
     ) binding ON true ORDER BY keys.first_version,keys.language`,
      [
        routeOf(catalogueId),
        catalogueId,
        occurrenceId,
        version,
        after?.firstVersion ?? null,
        after?.language ?? null,
        limit,
      ],
    )
  ).rows;
}

export async function writeHostedLanguageBinding(
  client: AccessClient,
  catalogueId: string,
  occurrenceId: string,
  language: string,
  title: string | null,
  target: HostedChapterTarget | null,
): Promise<string> {
  const version = (
    await client.query<{ version: string }>(
      `SELECT nextval('content.hosted_chapter_language_version')::text AS version`,
    )
  ).rows[0]!.version;
  const values = [routeOf(catalogueId), catalogueId, occurrenceId, language, version];
  await client.query(
    `INSERT INTO content.hosted_chapter_language_key(route,catalogue_id,occurrence_id,language,first_version)
     VALUES ($1,$2,$3,$4,$5::bigint) ON CONFLICT (route,catalogue_id,occurrence_id,language) DO NOTHING`,
    values,
  );
  await client.query(
    `INSERT INTO content.hosted_chapter_language_binding(route,catalogue_id,occurrence_id,language,version,title,target)
     VALUES ($1,$2,$3,$4,$5::bigint,$6,$7::jsonb)`,
    [...values, title, target === null ? null : JSON.stringify(target)],
  );
  return version;
}
