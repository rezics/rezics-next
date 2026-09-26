import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

interface AccessOutboxRow {
  id: string;
  kind: string;
  admission_id: string | null;
  scope_id: string | null;
  principal_id: string | null;
  authority_epoch: string;
}

export async function scanAccessOutbox(client: PoolClient): Promise<{ count: string; digest: string }> {
  const digest = createHash('sha256');
  let count = 0n;
  let lastId: string | null = null;
  while (true) {
    const result: QueryResult<AccessOutboxRow> = await client.query<AccessOutboxRow>(
      `SELECT id, kind, admission_id, scope_id, principal_id, authority_epoch FROM access.outbox
       WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 1000`, [lastId]);
    for (const row of result.rows) {
      digest.update(JSON.stringify([row.id, row.kind, row.admission_id,
        row.scope_id, row.principal_id, row.authority_epoch]));
      digest.update('\n');
      count++;
      lastId = row.id;
    }
    if (result.rows.length < 1000) break;
  }
  return { count: count.toString(), digest: digest.digest('hex') };
}

/** Canonical private row coverage at a fixed PostgreSQL version and UTC session. */
export async function scanAccessState(client: PoolClient): Promise<{ count: string; digest: string }> {
  const digest = createHash('sha256');
  let count = 0n;
  // Composite cursors are unambiguous: the first component is a fixed-width
  // UUID or canonical native IRI, followed by one separator and its second key.
  const tables = [
    { name: 'principal', cursor: 't.id', cast: 'uuid' },
    { name: 'authority_subject', cursor: 't.id', cast: 'text' },
    { name: 'scope_gate', cursor: 't.id', cast: 'text' },
    { name: 'representation', cursor: 't.id', cast: 'uuid' },
    { name: 'permission_grant', cursor: 't.id', cast: 'uuid' },
    { name: 'org_participation_subject', cursor: 't.subject', cast: 'text', historicalFixtureMayOmit: true },
    { name: 'org_realm_policy', cursor: 't.realm', cast: 'text', historicalFixtureMayOmit: true },
    { name: 'org_realm_ban', cursor: "(t.realm || ':' || t.organization_subject)",
      cast: 'text', historicalFixtureMayOmit: true },
    { name: 'org_realm_proposal', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'org_realm_participation', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'org_realm_history',
      cursor: "(t.participation_id::text || ':' || lpad(t.generation::text, 20, '0'))",
      cast: 'text', historicalFixtureMayOmit: true },
    { name: 'org_realm_proposal_use', cursor: 't.proposal_id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'org_realm_receipt', cursor: "(t.principal_id::text || ':' || t.idempotency_key)",
      cast: 'text', historicalFixtureMayOmit: true },
    { name: 'membership_policy', cursor: "(t.kind || ':' || t.owner_subject)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'membership_ban',
      cursor: "(t.kind || ':' || t.owner_subject || ':' || t.member_subject)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'membership', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'membership_history',
      cursor: "(t.membership_id::text || ':' || lpad(t.generation::text, 20, '0'))", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'membership_change_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'membership_consent', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'membership_consent_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'membership_consent_revocation', cursor: 't.consent_id', cast: 'uuid',
      historicalFixtureMayOmit: true },
    { name: 'membership_consent_use', cursor: 't.consent_id', cast: 'uuid',
      historicalFixtureMayOmit: true },
    { name: 'private_membership_ban',
      cursor: "(t.kind || ':' || t.owner_subject || ':' || t.principal_id::text)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'private_membership', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'private_membership_history',
      cursor: "(t.membership_id::text || ':' || lpad(t.generation::text, 20, '0'))", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'private_membership_consent', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'private_membership_consent_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'private_membership_consent_revocation', cursor: 't.consent_id', cast: 'uuid',
      historicalFixtureMayOmit: true },
    { name: 'private_membership_consent_use', cursor: 't.consent_id', cast: 'uuid',
      historicalFixtureMayOmit: true },
    { name: 'private_group_member', cursor: 't.id', cast: 'uuid',
      historicalFixtureMayOmit: true },
    { name: 'private_role_binding', cursor: 't.id', cast: 'uuid',
      historicalFixtureMayOmit: true },
    { name: 'private_recipient_change_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'private_membership_change_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'principal_permission_grant', cursor: 't.id', cast: 'uuid' },
    { name: 'principal_agent_attribution', cursor: 't.id', cast: 'uuid' },
    { name: 'recipient_group', cursor: 't.id', cast: 'uuid' },
    { name: 'group_member', cursor: 't.id', cast: 'uuid' },
    { name: 'group_permission_grant', cursor: 't.id', cast: 'uuid' },
    { name: 'role_family', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'role_revision',
      cursor: "(t.family_id::text || ':' || lpad(t.revision::text, 20, '0'))", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'role_revision_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'role_binding', cursor: 't.id', cast: 'uuid', historicalFixtureMayOmit: true },
    { name: 'role_binding_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text',
      historicalFixtureMayOmit: true },
    { name: 'admission', cursor: 't.id', cast: 'uuid' },
    { name: 'admission_receipt', cursor: 't.admission_id', cast: 'uuid' },
    { name: 'search_read_lease', cursor: 't.id', cast: 'uuid' },
    { name: 'reader_variant_preference',
      cursor: "(t.principal_id::text || ':' || t.main_version)", cast: 'text' },
    { name: 'reader_variant_preference_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text' },
    { name: 'realm_native_variant_recommendation',
      cursor: "(t.realm || ':' || t.main_version)", cast: 'text' },
    { name: 'realm_native_variant_recommendation_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text' },
    { name: 'acting_context_preference',
      cursor: "(t.principal_id::text || ':' || t.task)", cast: 'text' },
    { name: 'acting_context_preference_receipt',
      cursor: "(t.principal_id::text || ':' || t.idempotency_key)", cast: 'text' },
  ] as const;
  for (const table of tables) {
    if ('historicalFixtureMayOmit' in table) {
      const presence = await client.query<{ present: string | null }>(
        'SELECT to_regclass($1)::text AS present', [`access.${table.name}`]);
      if (!presence.rows[0]?.present) {
        // Old migration-step fixtures intentionally omit later tables. A
        // captured full-schema manifest includes the tables and therefore
        // cannot verify against this missing-table marker after restore.
        digest.update(JSON.stringify([table.name, 'schema-missing']));
        digest.update('\n');
        count++;
        continue;
      }
    }
    let lastId: string | null = null;
    while (true) {
      const result: QueryResult<{ cursor: string; body: string }> =
        await client.query<{ cursor: string; body: string }>(
          `SELECT ${table.cursor}::text AS cursor, to_jsonb(t)::text AS body
           FROM access.${table.name} AS t
           WHERE ($1::${table.cast} IS NULL OR ${table.cursor} > $1::${table.cast})
           ORDER BY ${table.cursor} LIMIT 1000`, [lastId]);
      for (const row of result.rows) {
        digest.update(JSON.stringify([table.name, row.cursor, row.body]));
        digest.update('\n');
        count++;
        lastId = row.cursor;
      }
      if (result.rows.length < 1000) break;
    }
  }
  return { count: count.toString(), digest: digest.digest('hex') };
}

/** Stable offline digest of the complete Access outbox at one PostgreSQL snapshot. */
export async function accessOutboxCoverage(pool: Pool): Promise<{ count: string; digest: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const coverage = await scanAccessOutbox(client);
    await client.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Stable offline digest of the authority and admission rows at one snapshot. */
export async function accessStateCoverage(pool: Pool): Promise<{ count: string; digest: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const coverage = await scanAccessState(client);
    await client.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
