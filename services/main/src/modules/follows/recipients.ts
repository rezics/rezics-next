import type { Pool, PoolClient } from 'pg';

export interface RelationshipRecipients {
  targets: readonly string[];
  highlights: boolean;
  watches?: readonly string[];
  direct?: readonly string[];
  except?: readonly string[];
  languages?: readonly string[];
}
/** Recipient precedence is centralized here: involvement, level, then Watch.
 * Direct recipients survive Off and Ignore. Disclosure stays with the subject
 * owner and is repeated at delivery; this indexed read grants no read access. */
export async function relationshipRecipientPage(
  pool: Pool | PoolClient,
  input: RelationshipRecipients,
  after: string | null = null,
) {
  if (
    input.targets.length > 7 ||
    (input.watches?.length ?? 0) > 4 ||
    (input.direct?.length ?? 0) > 256 ||
    (input.languages?.length ?? 0) > 20
  )
    throw new Error('Relationship recipient input bound exceeded');
  const rows = (
    await pool.query<{ id: string }>(
      `WITH targets AS (
    SELECT COALESCE(a.space,id) AS target FROM unnest($1::text[]) id LEFT JOIN access.follow_space_alias a ON a.alias=id
  ), candidates AS (
    SELECT id,true AS direct FROM unnest($4::uuid[]) id
    UNION ALL SELECT f.principal_id,false FROM access.follow f JOIN targets t ON t.target=f.target
      LEFT JOIN access.person_preferences pref ON pref.agent_id=f.acting_subject
      WHERE f.following AND (f.level='all' OR ($2 AND f.level='highlights'))
      AND (cardinality($7::text[])=0 OR COALESCE(cardinality(pref.content_languages),0)=0
        OR EXISTS(SELECT 1 FROM unnest($7::text[]) actual,unnest(pref.content_languages) wanted
          WHERE lower(actual)=lower(wanted) OR lower(actual) LIKE lower(wanted)||'-%'))
      AND (f.kind<>'space' OR NOT EXISTS(SELECT 1 FROM access.follow_space_alias alias
        JOIN access.realm_admin_settings settings ON settings.realm=alias.realm
        WHERE alias.space=f.target AND settings.visibility='private'))
    UNION ALL SELECT w.principal_id,false FROM access.watch w WHERE w.target=ANY($3::text[])
      AND (w.level='all' OR w.level='participating' AND EXISTS(SELECT 1 FROM access.watch_participation participant
        WHERE participant.principal_id=w.principal_id AND participant.target=w.target))
  ) SELECT p.id::text FROM candidates c JOIN access.principal p ON p.id=c.id AND p.active
    WHERE NOT p.id=ANY($5::uuid[]) AND ($6::uuid IS NULL OR p.id>$6::uuid)
    AND NOT EXISTS(SELECT 1 FROM access.person_block b WHERE b.principal_id=p.id AND b.target_agent=ANY($1::text[]))
    AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=p.id AND e.strength='mute' AND e.target=ANY($1::text[]))
    GROUP BY p.id
    HAVING bool_or(c.direct) OR NOT EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id
      AND w.target=ANY($3::text[]) AND w.level='ignore') ORDER BY p.id LIMIT 257`,
      [
        input.targets,
        input.highlights,
        input.watches ?? [],
        input.direct ?? [],
        input.except ?? [],
        after,
        input.languages ?? [],
      ],
    )
  ).rows;
  const items = rows.slice(0, 256).map((row) => row.id);
  return { items, nextCursor: rows.length > 256 ? items.at(-1)! : null };
}
export async function relationshipRecipients(
  pool: Pool | PoolClient,
  input: RelationshipRecipients,
): Promise<string[]> {
  return (await relationshipRecipientPage(pool, input)).items;
}
/** A bounded single-recipient delivery recheck through the same selection. */
export async function relationshipEligible(
  pool: Pool | PoolClient,
  principal: string,
  input: Omit<RelationshipRecipients, 'direct' | 'except'>,
): Promise<boolean> {
  const row = (
    await pool.query(
      `WITH targets AS (SELECT COALESCE(a.space,id) AS target
    FROM unnest($2::text[]) id LEFT JOIN access.follow_space_alias a ON a.alias=id)
    SELECT 1 FROM access.principal p WHERE p.id=$1 AND p.active
    AND NOT EXISTS(SELECT 1 FROM access.person_block b WHERE b.principal_id=p.id AND b.target_agent=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=p.id AND e.strength='mute' AND e.target=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id AND w.target=ANY($4::text[]) AND w.level='ignore')
    AND (EXISTS(SELECT 1 FROM access.follow f JOIN targets t ON t.target=f.target
      LEFT JOIN access.person_preferences pref ON pref.agent_id=f.acting_subject
      WHERE f.principal_id=p.id AND f.following AND (f.level='all' OR ($3 AND f.level='highlights'))
        AND (cardinality($5::text[])=0 OR COALESCE(cardinality(pref.content_languages),0)=0
          OR EXISTS(SELECT 1 FROM unnest($5::text[]) actual,unnest(pref.content_languages) wanted
            WHERE lower(actual)=lower(wanted) OR lower(actual) LIKE lower(wanted)||'-%'))
        AND (f.kind<>'space' OR NOT EXISTS(SELECT 1 FROM access.follow_space_alias alias
          JOIN access.realm_admin_settings settings ON settings.realm=alias.realm
          WHERE alias.space=f.target AND settings.visibility='private')))
      OR EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id AND w.target=ANY($4::text[])
        AND (w.level='all' OR w.level='participating' AND EXISTS(SELECT 1 FROM access.watch_participation participant
          WHERE participant.principal_id=w.principal_id AND participant.target=w.target))))`,
      [principal, input.targets, input.highlights, input.watches ?? [], input.languages ?? []],
    )
  ).rowCount;
  return !!row;
}
