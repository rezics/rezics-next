import type { Pool, PoolClient } from 'pg';

export interface RelationshipRecipients {
  targets: readonly string[];
  highlights: boolean;
  watches?: readonly string[];
  direct?: readonly string[];
  relationships?: readonly string[];
  except?: readonly string[];
  languages?: readonly string[];
}
/** Each target source seeks at most 257 raw rows before eligibility. The merge
 * examines at most 256 distinct principals and writes at most 256 inbox items. */
export const RELATIONSHIP_RECIPIENT_COST = { candidatesPerSource: 257, examinedPerBatch: 256,
  targets: 7, watches: 4, direct: 256, relationships: 256, languages: 20 } as const;

/** Recipient precedence is centralized here: involvement, level, then Watch.
 * Direct recipients survive Off and Ignore. Disclosure stays with the subject
 * owner and is repeated at delivery; this indexed read grants no read access. */
export async function relationshipRecipientPage(
  pool: Pool | PoolClient,
  input: RelationshipRecipients,
  after: string | null = null,
) {
  if (
    input.targets.length > RELATIONSHIP_RECIPIENT_COST.targets ||
    (input.watches?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.watches ||
    (input.direct?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.direct ||
    (input.relationships?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.relationships ||
    (input.languages?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.languages
  )
    throw new Error('Relationship recipient input bound exceeded');
  // Materialized source limits bound selection before eligibility. Lateral
  // lookups and OFFSET 0 keep rechecks from becoming population-wide hash scans.
  const rows = (
    await pool.query<{ id: string; eligible: boolean }>(
      `WITH targets AS (
    SELECT COALESCE(a.space,id) AS target FROM unnest($1::text[]) id LEFT JOIN access.follow_space_alias a ON a.alias=id
  ), identities AS (SELECT target FROM targets UNION SELECT a.alias FROM access.follow_space_alias a JOIN targets t ON t.target=a.space),
  raw_follows AS MATERIALIZED (
    SELECT f.* FROM identities t CROSS JOIN LATERAL (
      SELECT f.principal_id,f.target,f.acting_subject,f.level FROM access.follow f
      WHERE f.target=t.target AND f.following AND ($6::uuid IS NULL OR f.principal_id>$6::uuid)
      ORDER BY f.principal_id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource}
    ) f
  ), raw_watches AS MATERIALIZED (
    SELECT w.* FROM unnest($3::text[]) AS source(target) CROSS JOIN LATERAL (
      SELECT w.principal_id,w.target,w.level FROM access.watch w
      WHERE w.target=source.target AND ($6::uuid IS NULL OR w.principal_id>$6::uuid)
      ORDER BY w.principal_id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource}
    ) w
  ), candidates AS MATERIALIZED (
    SELECT id,true AS direct,true AS eligible FROM unnest($4::uuid[]) id WHERE $6::uuid IS NULL OR id>$6::uuid
    UNION ALL SELECT id,false,true FROM unnest($8::uuid[]) id WHERE $6::uuid IS NULL OR id>$6::uuid
    UNION ALL SELECT f.principal_id,false,
      (f.level='all' OR ($2 AND f.level='highlights'))
      AND (cardinality($7::text[])=0 OR COALESCE(cardinality(pref.content_languages),0)=0
        OR EXISTS(SELECT 1 FROM unnest($7::text[]) actual,unnest(pref.content_languages) wanted
          WHERE lower(actual)=lower(wanted) OR lower(actual) LIKE lower(wanted)||'-%'))
      AND access.follow_space_notifying(f.principal_id,f.target)
      FROM raw_follows f LEFT JOIN LATERAL (SELECT content_languages FROM access.person_preferences
        WHERE agent_id=f.acting_subject LIMIT 1) pref ON true
    UNION ALL SELECT w.principal_id,false,
      (w.level='all' OR w.level='participating' AND EXISTS(SELECT 1 FROM access.watch_participation participant
        WHERE participant.principal_id=w.principal_id AND participant.target=w.target)) FROM raw_watches w
  ), frontier AS MATERIALIZED (SELECT DISTINCT id FROM candidates ORDER BY id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource})
  SELECT frontier.id::text, COALESCE(p.active,false) AND NOT frontier.id=ANY($5::uuid[])
    AND NOT EXISTS(SELECT 1 FROM access.person_block b WHERE b.principal_id=frontier.id AND b.target_agent=ANY($1::text[]) OFFSET 0)
    AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=frontier.id AND e.strength='mute' AND e.target=ANY($1::text[]) OFFSET 0)
    AND (bool_or(c.direct) OR NOT EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=frontier.id
      AND w.target=ANY($3::text[]) AND w.level='ignore' OFFSET 0)) AND bool_or(c.eligible) AS eligible
    FROM frontier JOIN candidates c ON c.id=frontier.id
    LEFT JOIN LATERAL (SELECT active FROM access.principal WHERE id=frontier.id LIMIT 1) p ON true
    GROUP BY frontier.id,p.active ORDER BY frontier.id`,
      [
        input.targets,
        input.highlights,
        input.watches ?? [],
        input.direct ?? [],
        input.except ?? [],
        after,
        input.languages ?? [],
        input.relationships ?? [],
      ],
    )
  ).rows;
  // The frontier records examined identities, including denied recipients. A
  // single UUID works because every source seeks in the same principal order;
  // the extra raw identity proves that at least one source is not exhausted.
  const examined = rows.slice(0, RELATIONSHIP_RECIPIENT_COST.examinedPerBatch);
  return {
    items: examined.filter(row => row.eligible).map(row => row.id),
    nextCursor: rows.length > RELATIONSHIP_RECIPIENT_COST.examinedPerBatch ? examined.at(-1)!.id : null,
  };
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
    FROM unnest($2::text[]) id LEFT JOIN access.follow_space_alias a ON a.alias=id),
    identities AS (SELECT target FROM targets UNION SELECT a.alias FROM access.follow_space_alias a JOIN targets t ON t.target=a.space)
    SELECT 1 FROM access.principal p WHERE p.id=$1 AND p.active
    AND NOT EXISTS(SELECT 1 FROM access.person_block b WHERE b.principal_id=p.id AND b.target_agent=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=p.id AND e.strength='mute' AND e.target=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id AND w.target=ANY($4::text[]) AND w.level='ignore')
    AND (p.id=ANY($6::uuid[]) OR EXISTS(SELECT 1 FROM access.follow f JOIN identities t ON t.target=f.target
      LEFT JOIN access.person_preferences pref ON pref.agent_id=f.acting_subject
      WHERE f.principal_id=p.id AND f.following AND (f.level='all' OR ($3 AND f.level='highlights'))
        AND (cardinality($5::text[])=0 OR COALESCE(cardinality(pref.content_languages),0)=0
          OR EXISTS(SELECT 1 FROM unnest($5::text[]) actual,unnest(pref.content_languages) wanted
            WHERE lower(actual)=lower(wanted) OR lower(actual) LIKE lower(wanted)||'-%'))
        AND access.follow_space_notifying(f.principal_id,f.target))
      OR EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id AND w.target=ANY($4::text[])
        AND (w.level='all' OR w.level='participating' AND EXISTS(SELECT 1 FROM access.watch_participation participant
          WHERE participant.principal_id=w.principal_id AND participant.target=w.target))))`,
      [principal, input.targets, input.highlights, input.watches ?? [], input.languages ?? [],input.relationships ?? []],
    )
  ).rowCount;
  return !!row;
}
