import type { Pool, PoolClient } from 'pg';
import type { ProposalSubscriptionReason } from '../notification/store.ts';

export interface RelationshipRecipients {
  targets: readonly string[];
  highlights: boolean;
  watches?: readonly string[];
  direct?: readonly string[];
  relationships?: readonly string[];
  except?: readonly string[];
  languages?: readonly string[];
  editorial?: { proposals: readonly string[]; actor: string; skipAuthors: boolean };
}
/** Alias identities are visited serially, rather than accumulating an
 * audience-sized cursor. Only the current alias's principal seek is retained. */
export type RecipientFrontier =
  | {
      source: 'base';
      afterPrincipal: string | null;
      legacyAfter: string | null;
    }
  | {
      source: 'alias';
      target: string;
      alias: string;
      afterPrincipal: string | null;
      legacyAfter: string | null;
    };
export const RELATIONSHIP_RECIPIENT_COST = {
  candidatesPerSource: 257,
  examinedPerBatch: 256,
  targets: 7,
  watches: 4,
  direct: 256,
  relationships: 256,
  except: 257,
  languages: 20,
  proposals: 2,
  followRowsPerSource: 514,
  statementsPerBatch: 8,
  aliasIdentitiesPerBatch: 1,
  aliasDiscoveryRowsPerTarget: 1,
  followsPerPrincipal: 10_000,
} as const;

function validateRecipients(input: RelationshipRecipients) {
  if (
    input.targets.length > RELATIONSHIP_RECIPIENT_COST.targets ||
    (input.watches?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.watches ||
    (input.direct?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.direct ||
    (input.relationships?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.relationships ||
    (input.except?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.except ||
    (input.languages?.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.languages ||
    (input.editorial?.proposals.length ?? 0) > RELATIONSHIP_RECIPIENT_COST.proposals
  )
    throw new Error('Relationship recipient input bound exceeded');
}

/** ORDER/LIMIT alone can still sort a whole audience. Scope the indexed-read
 * plan to this batch, then restore the caller's planner settings. Each source
 * has an ordered index; bitmap scans would materialize its entire range.
 * https://www.postgresql.org/docs/18/runtime-config-query.html
 * https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-SET
 */
async function indexedRecipientRead<T>(
  pool: Pool | PoolClient,
  read: (client: Pick<PoolClient, 'query'>) => Promise<T>,
): Promise<T> {
  const scoped = async (client: Pick<PoolClient, 'query'>) => {
    const previous = (
      await client.query<{ sequential: string; bitmap: string }>(
        `SELECT current_setting('enable_seqscan') AS sequential,current_setting('enable_bitmapscan') AS bitmap`,
      )
    ).rows[0]!;
    await client.query(
      `SELECT set_config('enable_seqscan','off',true),set_config('enable_bitmapscan','off',true)`,
    );
    try {
      return await read(client);
    } finally {
      await client
        .query(
          `SELECT set_config('enable_seqscan',$1,true),set_config('enable_bitmapscan',$2,true)`,
          [previous.sequential, previous.bitmap],
        )
        .catch(() => {});
    }
  };
  if ('release' in pool) return scoped(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await scoped(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Realm identity comes from this exact projected alias, never by enumerating
 * every alias of a Space during a single recipient's eligibility check. */
function notifyingSql(realm: string, principal: string) {
  return `NOT EXISTS(SELECT 1 FROM access.realm_admin_settings settings
    WHERE settings.realm=${realm} AND settings.visibility='private'
    AND NOT EXISTS(SELECT 1 FROM access.private_membership m WHERE m.principal_id=${principal}
      AND m.owner_subject=settings.realm AND m.kind='realm' AND m.state='joined')
    AND NOT EXISTS(SELECT 1 FROM access.membership m JOIN access.agent_provision a ON a.agent_id=m.member_subject
      WHERE a.principal_id=${principal} AND a.agent_kind='person' AND a.state='active'
        AND m.owner_subject=settings.realm AND m.kind='realm' AND m.state='joined') OFFSET 0)`;
}

async function nextAlias(
  pool: Pick<PoolClient, 'query'>,
  input: RelationshipRecipients,
  frontier: RecipientFrontier,
) {
  const rows = (
    await pool.query<{ target: string; alias: string }>(
      `
    WITH targets AS MATERIALIZED (SELECT DISTINCT COALESCE(a.space,id) AS target
      FROM unnest($1::text[]) id LEFT JOIN LATERAL (
        SELECT space FROM access.follow_space_alias WHERE alias=id LIMIT 1
      ) a ON true)
    SELECT target,alias FROM (
      SELECT t.target,identity.alias FROM targets t CROSS JOIN LATERAL (
        SELECT a.alias FROM access.follow_space_alias a
        WHERE a.space=t.target AND a.alias<>t.target AND a.alias>$3
        ORDER BY a.alias LIMIT 1
      ) identity WHERE t.target=$2
      UNION ALL SELECT t.target,identity.alias FROM targets t CROSS JOIN LATERAL (
        SELECT a.alias FROM access.follow_space_alias a WHERE a.space=t.target AND a.alias<>t.target
        ORDER BY a.alias LIMIT 1
      ) identity WHERE $2::text IS NULL OR t.target>$2
    ) remaining ORDER BY target LIMIT 1`,
      [
        input.targets,
        frontier.source === 'alias' ? frontier.target : null,
        frontier.source === 'alias' ? frontier.alias : null,
      ],
    )
  ).rows;
  const row = rows[0];
  return row
    ? {
        source: 'alias' as const,
        ...row,
        afterPrincipal: frontier.legacyAfter,
        legacyAfter: frontier.legacyAfter,
      }
    : null;
}

/** Recipient precedence is centralized here: involvement, level, then Watch.
 * Direct recipients survive Off and Ignore. Disclosure stays with the subject
 * owner and is repeated at delivery; this indexed read grants no read access. */
export async function relationshipRecipientPage(
  pool: Pool | PoolClient,
  input: RelationshipRecipients,
  after: RecipientFrontier | string | null = null,
) {
  validateRecipients(input);
  return indexedRecipientRead(pool, (client) => selectRecipientPage(client, input, after));
}

async function selectRecipientPage(
  pool: Pick<PoolClient, 'query'>,
  input: RelationshipRecipients,
  after: RecipientFrontier | string | null = null,
) {
  // A legacy UUID already covered every alias below that principal. New base
  // seeks do not impose that floor on aliases that have yet to be visited.
  const position: RecipientFrontier =
    typeof after === 'string'
      ? { source: 'base', afterPrincipal: after, legacyAfter: after }
      : (after ?? { source: 'base', afterPrincipal: null, legacyAfter: null });
  // The audience index covers the ID seek; policy fields are read by exact
  // principal/target keys only after that limit. OFFSET 0 and lateral lookups prevent
  // the planner from replacing recipient rechecks with population hash scans.
  const rows = (
    await pool.query<{ id: string; eligible: boolean; reason: ProposalSubscriptionReason }>(
      `
    WITH targets AS MATERIALIZED (SELECT DISTINCT COALESCE(a.space,id) AS target
      FROM unnest($1::text[]) id LEFT JOIN LATERAL (
        SELECT space FROM access.follow_space_alias WHERE alias=id LIMIT 1
      ) a ON true),
    sources AS MATERIALIZED (
      SELECT t.target,a.realm FROM targets t LEFT JOIN LATERAL (
        SELECT realm FROM access.follow_space_alias WHERE alias=t.target LIMIT 1
      ) a ON true WHERE $9::text IS NULL
      UNION ALL SELECT a.alias,a.realm FROM access.follow_space_alias a
        WHERE a.alias=$9 AND a.space IN(SELECT target FROM targets)
    ), follow_keys AS MATERIALIZED (
      SELECT f.principal_id,t.target,t.realm FROM sources t CROSS JOIN LATERAL (
        SELECT f.principal_id FROM access.follow f
        WHERE f.target=t.target AND f.following AND ($6::uuid IS NULL OR f.principal_id>$6)
        ORDER BY f.principal_id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource}
      ) f
    ), raw_follows AS MATERIALIZED (
      SELECT k.*,f.acting_subject,f.level FROM follow_keys k CROSS JOIN LATERAL (
        SELECT acting_subject,level FROM access.follow
        WHERE principal_id=k.principal_id AND target=k.target LIMIT 1
      ) f
    ), raw_watches AS MATERIALIZED (
      SELECT w.* FROM unnest($3::text[]) AS source(target) CROSS JOIN LATERAL (
        SELECT w.principal_id,w.target,w.level FROM access.watch w
        WHERE $9::text IS NULL AND w.target=source.target AND ($6::uuid IS NULL OR w.principal_id>$6)
        ORDER BY w.principal_id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource}
      ) w
    ), raw_involvement AS MATERIALIZED (
      SELECT p.principal_id FROM unnest($10::uuid[]) proposal CROSS JOIN LATERAL (
        SELECT principal_id FROM access.watch_participation
        WHERE $9::text IS NULL AND target='urn:rezics:proposal:'||proposal::text
          AND ($6::uuid IS NULL OR principal_id>$6)
        ORDER BY principal_id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource}
      ) p
    ), candidates AS MATERIALIZED (
      SELECT id,true AS direct,true AS eligible FROM unnest($4::uuid[]) id
        WHERE $9::text IS NULL AND ($6::uuid IS NULL OR id>$6)
      UNION ALL SELECT id,false,true FROM unnest($8::uuid[]) id
        WHERE $9::text IS NULL AND ($6::uuid IS NULL OR id>$6)
      UNION ALL SELECT principal_id,false,false FROM raw_involvement
      UNION ALL SELECT f.principal_id,false,
        (f.level='all' OR ($2 AND f.level='highlights'))
        AND (cardinality($7::text[])=0 OR COALESCE(cardinality(pref.content_languages),0)=0
          OR EXISTS(SELECT 1 FROM unnest($7::text[]) actual,unnest(pref.content_languages) wanted
            WHERE lower(actual)=lower(wanted) OR lower(actual) LIKE lower(wanted)||'-%'))
        AND ${notifyingSql('f.realm', 'f.principal_id')}
        FROM raw_follows f LEFT JOIN LATERAL (SELECT content_languages FROM access.person_preferences
          WHERE agent_id=f.acting_subject LIMIT 1) pref ON true
      UNION ALL SELECT w.principal_id,false,
        (w.level='all' OR w.level='participating' AND EXISTS(SELECT 1 FROM access.watch_participation participant
          WHERE participant.principal_id=w.principal_id AND participant.target=w.target)) FROM raw_watches w
    ), frontier AS MATERIALIZED (SELECT DISTINCT id FROM candidates ORDER BY id LIMIT ${RELATIONSHIP_RECIPIENT_COST.candidatesPerSource}),
    classified AS MATERIALIZED (
      SELECT f.id,CASE WHEN ($12::boolean AND involved.reason='author')
        OR ($11::text IS NOT NULL AND EXISTS(SELECT 1 FROM access.representation self
          WHERE self.principal_id=f.id AND self.subject_id=$11 AND self.action='agent.control'
            AND self.active AND self.valid_until>clock_timestamp() OFFSET 0)) THEN 'manual'
        ELSE COALESCE(involved.reason,'manual') END AS reason FROM frontier f LEFT JOIN LATERAL (
        SELECT CASE WHEN p.proposer_principal=f.id THEN 'author'
          WHEN EXISTS(SELECT 1 FROM access.watch_participation participation
            WHERE participation.principal_id=f.id AND participation.target=w.target) THEN 'reviewer'
          WHEN f.id=ANY($8::uuid[]) AND w.reason<>'manual' THEN 'steward' ELSE 'manual' END AS reason
        FROM unnest($10::uuid[]) proposal JOIN access.editorial_proposal p ON p.id=proposal
        JOIN access.watch w ON w.principal_id=f.id AND w.target='urn:rezics:proposal:'||p.id::text
        ORDER BY CASE WHEN p.proposer_principal=f.id THEN 0
          WHEN EXISTS(SELECT 1 FROM access.watch_participation participation
            WHERE participation.principal_id=f.id AND participation.target=w.target) THEN 1
          WHEN f.id=ANY($8::uuid[]) AND w.reason<>'manual' THEN 2 ELSE 3 END LIMIT 1
      ) involved ON true
    ) SELECT f.id::text,f.reason,COALESCE(p.active,false) AND NOT f.id=ANY($5::uuid[])
      AND NOT EXISTS(SELECT 1 FROM access.person_block b WHERE b.principal_id=f.id AND b.target_agent=ANY($1::text[]) OFFSET 0)
      AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=f.id AND e.strength='mute' AND e.target=ANY($1::text[]) OFFSET 0)
      AND (f.reason IN('author','reviewer') OR f.id=ANY($4::uuid[]) OR bool_or(c.direct)
        OR NOT EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=f.id AND w.target=ANY($3::text[]) AND w.level='ignore' OFFSET 0))
      AND (bool_or(c.eligible) OR f.id=ANY($4::uuid[]) OR f.reason IN('author','reviewer'))
      AS eligible
      FROM classified f JOIN candidates c ON c.id=f.id
      LEFT JOIN LATERAL (SELECT active FROM access.principal WHERE id=f.id LIMIT 1) p ON true
      GROUP BY f.id,f.reason,p.active ORDER BY f.id`,
      [
        input.targets,
        input.highlights,
        input.watches ?? [],
        input.direct ?? [],
        input.except ?? [],
        position.afterPrincipal,
        input.languages ?? [],
        input.relationships ?? [],
        position.source === 'alias' ? position.alias : null,
        input.editorial?.proposals ?? [],
        input.editorial?.actor ?? null,
        input.editorial?.skipAuthors ?? false,
      ],
    )
  ).rows;
  const examined = rows.slice(0, RELATIONSHIP_RECIPIENT_COST.examinedPerBatch);
  const selected = examined.filter((row) => row.eligible);
  const nextCursor: RecipientFrontier | null =
    rows.length > RELATIONSHIP_RECIPIENT_COST.examinedPerBatch
      ? { ...position, afterPrincipal: examined.at(-1)!.id }
      : await nextAlias(pool, input, position);
  return {
    items: selected.map((row) => row.id),
    nextCursor,
    reasons: Object.fromEntries(selected.map((row) => [row.id, row.reason])) as Record<
      string,
      ProposalSubscriptionReason
    >,
  };
}

/** This convenience read is one batch; broadcasts consume the durable frontier. */
export async function relationshipRecipients(
  pool: Pool | PoolClient,
  input: RelationshipRecipients,
): Promise<string[]> {
  return (await relationshipRecipientPage(pool, input)).items;
}
/** A single recipient's own Follow inventory has an admitted 10,000-slot bound.
 * Resolve its exact alias mappings, rather than enumerate a Space's aliases. */
export async function relationshipEligible(
  pool: Pool | PoolClient,
  principal: string,
  input: Omit<RelationshipRecipients, 'direct' | 'except'>,
): Promise<boolean> {
  validateRecipients(input);
  return indexedRecipientRead(pool, async (client) => {
    const row = (
      await client.query(
        `WITH targets AS MATERIALIZED (
      SELECT COALESCE(a.space,id) AS target FROM unnest($2::text[]) id LEFT JOIN LATERAL (
        SELECT space FROM access.follow_space_alias WHERE alias=id LIMIT 1
      ) a ON true
    ), follows AS MATERIALIZED (SELECT target,level,acting_subject FROM access.follow
      WHERE principal_id=$1 AND following ORDER BY target LIMIT ${RELATIONSHIP_RECIPIENT_COST.followsPerPrincipal})
    SELECT 1 FROM access.principal p WHERE p.id=$1 AND p.active
      AND NOT EXISTS(SELECT 1 FROM access.person_block b WHERE b.principal_id=p.id AND b.target_agent=ANY($2::text[]) OFFSET 0)
      AND NOT EXISTS(SELECT 1 FROM access.home_exclusion e WHERE e.principal_id=p.id AND e.strength='mute' AND e.target=ANY($2::text[]) OFFSET 0)
      AND NOT EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id AND w.target=ANY($4::text[]) AND w.level='ignore' OFFSET 0)
      AND (p.id=ANY($6::uuid[]) OR EXISTS(SELECT 1 FROM follows f
        LEFT JOIN LATERAL (SELECT space,realm FROM access.follow_space_alias WHERE alias=f.target LIMIT 1) identity ON true
        LEFT JOIN LATERAL (SELECT content_languages FROM access.person_preferences WHERE agent_id=f.acting_subject LIMIT 1) pref ON true
        WHERE COALESCE(identity.space,f.target) IN(SELECT target FROM targets)
          AND (f.level='all' OR ($3 AND f.level='highlights'))
          AND (cardinality($5::text[])=0 OR COALESCE(cardinality(pref.content_languages),0)=0
            OR EXISTS(SELECT 1 FROM unnest($5::text[]) actual,unnest(pref.content_languages) wanted
              WHERE lower(actual)=lower(wanted) OR lower(actual) LIKE lower(wanted)||'-%'))
          AND ${notifyingSql('identity.realm', 'p.id')})
        OR EXISTS(SELECT 1 FROM access.watch w WHERE w.principal_id=p.id AND w.target=ANY($4::text[])
          AND (w.level='all' OR w.level='participating' AND EXISTS(SELECT 1 FROM access.watch_participation participation
            WHERE participation.principal_id=p.id AND participation.target=w.target))))`,
        [
          principal,
          input.targets,
          input.highlights,
          input.watches ?? [],
          input.languages ?? [],
          input.relationships ?? [],
        ],
      )
    ).rowCount;
    return !!row;
  });
}
