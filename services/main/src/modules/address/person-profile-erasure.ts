import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  PersonProfileErasureDenied,
  PersonProfileErasureStale,
  withPersonProfileErasureAuthority,
  type PersonProfileErasureProof,
} from '../access/person-profile-erasure.ts';

export interface PersonAliasEntry {
  readonly owner: 'registry' | 'history' | 'receipt' | 'import';
  readonly ref: string;
  readonly fingerprint: string;
  readonly erasureId: string | null;
  readonly erasureEpoch: string | null;
}
export interface PersonAliasInventory {
  readonly entries: readonly PersonAliasEntry[];
  readonly digest: string;
}

function digest(entries: readonly PersonAliasEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Opaque references and row digests seal the existing owner's exact copies.
 * No plaintext alias or arbitrary idempotency key leaves the inventory. */
async function inventory(client: Pool | PoolClient, person: string, limit: number): Promise<PersonAliasInventory> {
  if (!Number.isInteger(limit) || limit < 0 || limit > 256) {
    throw new PersonProfileErasureDenied('invalid Person alias inventory bound');
  }
  const entries = (await client.query<PersonAliasEntry>(`
    SELECT owner, ref, access.alias_digest(body::text) AS fingerprint,
      body->>'profile_erasure_id' AS "erasureId", body->>'profile_erasure_epoch' AS "erasureEpoch"
    FROM (
      (SELECT 'registry' AS owner, key_digest AS ref, to_jsonb(a) AS body
        FROM access.alias_registry a WHERE scope = 'agent' AND holder = $1 ORDER BY key_digest LIMIT $2)
      UNION ALL
      (SELECT 'history', revision::text, to_jsonb(h)
        FROM access.alias_history h WHERE scope = 'agent' AND holder = $1 ORDER BY revision LIMIT $2)
      UNION ALL
      (SELECT 'receipt', access.alias_digest(principal_id::text || ':' || idempotency_key), to_jsonb(r)
        FROM access.alias_receipt r WHERE result->>'scope' = 'agent' AND result->>'holder' = $1
        ORDER BY principal_id,idempotency_key LIMIT $2)
      UNION ALL
      (SELECT 'import', access.alias_digest(data_epoch || ':' || source_digest), to_jsonb(i)
        FROM access.alias_graph_import_report i WHERE holder = $1 ORDER BY data_epoch,source_digest LIMIT $2)
    ) copies ORDER BY owner, ref LIMIT $2`, [person, limit + 1])).rows;
  if (entries.length > limit) {
    throw new PersonProfileErasureDenied('Person aliases exceed aggregate inventory budget');
  }
  return { entries, digest: digest(entries) };
}

export async function listPersonProfileAliases(access: Pool, relay: Pool | PoolClient,
  proof: PersonProfileErasureProof, limit: number): Promise<PersonAliasInventory> {
  return withPersonProfileErasureAuthority(access, relay, proof, async client => {
    await lockAliases(client, proof.person);
    return inventory(client, proof.person, limit);
  });
}

async function lockAliases(client: PoolClient, person: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('alias-holder:agent:' || $1,0))", [person]);
  // Lock a bounded lookahead before fingerprints are compared. Inserts share
  // the holder lock; updates/deletes cannot race the sealed-row recheck.
  await client.query(`SELECT 1 FROM access.alias_registry WHERE scope = 'agent' AND holder = $1
    ORDER BY key_digest LIMIT 257 FOR UPDATE`, [person]);
  await client.query(`SELECT 1 FROM access.alias_history WHERE scope = 'agent' AND holder = $1
    ORDER BY revision LIMIT 257 FOR UPDATE`, [person]);
  await client.query(`SELECT 1 FROM access.alias_receipt WHERE result->>'scope' = 'agent' AND result->>'holder' = $1
    ORDER BY principal_id,idempotency_key LIMIT 257 FOR UPDATE`, [person]);
  await client.query(`SELECT 1 FROM access.alias_graph_import_report WHERE holder = $1
    ORDER BY data_epoch,source_digest LIMIT 257 FOR UPDATE`, [person]);
}

/** The caller can compose this callback with provision sanitation in the same
 * Access transaction; it inherits the Access owner's exact journal proof. */
export async function erasePersonProfileAliasesInTransaction(client: PoolClient,
  proof: PersonProfileErasureProof, sealed: PersonAliasInventory): Promise<void> {
  await client.query('SELECT access.assert_person_profile_erasure($1)', [proof.person]);
  await lockAliases(client, proof.person);
  if (sealed.entries.length > 256 || sealed.digest !== digest(sealed.entries)) {
    throw new PersonProfileErasureDenied('invalid sealed Person alias inventory');
  }
  // Access installs this value from the immutable child-journal target, never
  // from the caller's freshly recollected inventory. Check it even on replay.
  const authority = (await client.query<{ seal: string | null }>(`SELECT
    current_setting('rezics.person_profile_erasure', true)::jsonb->>'aliasInventorySeal' AS seal`)).rows[0];
  if (authority?.seal !== `${proof.person}|${sealed.digest}`) {
    throw new PersonProfileErasureStale('Person aliases differ from the original journal seal');
  }
  const current = await inventory(client, proof.person, sealed.entries.length);
  const refsEqual = current.entries.length === sealed.entries.length
    && current.entries.every((entry, index) => entry.owner === sealed.entries[index]?.owner
      && entry.ref === sealed.entries[index]?.ref);
  const terminal = refsEqual && current.entries.every(entry => entry.erasureId === proof.erasureId
    && entry.erasureEpoch === proof.erasureEpoch);
  if (terminal && await personProfileAliasesErased(client, proof)) return;
  if (!refsEqual || current.digest !== sealed.digest
    || current.entries.some(entry => entry.erasureId !== null)) {
    throw new PersonProfileErasureStale('Person alias inventory changed after sealing');
  }
  const params = [proof.person, proof.erasureId, proof.erasureEpoch];
  await client.query(`UPDATE access.alias_registry SET key = NULL, skeleton = NULL,
    state = 'retired', successor = NULL, profile_erasure_id = $2, profile_erasure_epoch = $3
    WHERE scope = 'agent' AND holder = $1 AND profile_erasure_id IS NULL`, params);
  await client.query(`UPDATE access.alias_history SET key = NULL, successor = NULL,
    profile_erasure_id = $2, profile_erasure_epoch = $3
    WHERE scope = 'agent' AND holder = $1 AND profile_erasure_id IS NULL`, params);
  await client.query(`UPDATE access.alias_receipt
    SET result = (result - ARRAY['key','previousKey','display','successor'])
      || '{"profile":"alias-erased-v1"}'::jsonb,
      profile_erasure_id = $2, profile_erasure_epoch = $3
    WHERE result->>'scope' = 'agent' AND result->>'holder' = $1 AND profile_erasure_id IS NULL`, params);
  await client.query(`UPDATE access.alias_graph_import_report
    SET source = NULL, legacy_alias = NULL, reason = 'Person alias erased',
      profile_erasure_id = $2, profile_erasure_epoch = $3
    WHERE holder = $1 AND profile_erasure_id IS NULL`, params);
  if (!await personProfileAliasesErased(client, proof)) {
    throw new PersonProfileErasureStale('Person alias sanitation did not prove absence');
  }
}

export async function erasePersonProfileAliases(access: Pool, relay: Pool | PoolClient,
  proof: PersonProfileErasureProof, sealed: PersonAliasInventory): Promise<void> {
  await withPersonProfileErasureAuthority(access, relay, proof,
    client => erasePersonProfileAliasesInTransaction(client, proof, sealed));
}

/** Probe every retained owner copy and its exact terminal erasure identity.
 * Reservation digests are retained evidence, never a public alias lookup. */
export async function personProfileAliasesErased(access: Pool | PoolClient,
  proof: PersonProfileErasureProof): Promise<boolean> {
  const row = (await access.query<{ absent: boolean }>(`SELECT
    NOT EXISTS (SELECT 1 FROM access.alias_registry WHERE scope = 'agent' AND holder = $1
      AND (key IS NOT NULL OR skeleton IS NOT NULL OR state <> 'retired' OR successor IS NOT NULL
        OR profile_erasure_id IS DISTINCT FROM $2::uuid OR profile_erasure_epoch IS DISTINCT FROM $3::bigint))
    AND NOT EXISTS (SELECT 1 FROM access.alias_history WHERE scope = 'agent' AND holder = $1
      AND (key IS NOT NULL OR successor IS NOT NULL OR profile_erasure_id IS DISTINCT FROM $2::uuid
        OR profile_erasure_epoch IS DISTINCT FROM $3::bigint))
    AND NOT EXISTS (SELECT 1 FROM access.alias_receipt WHERE result->>'scope' = 'agent' AND result->>'holder' = $1
      AND (result ?| ARRAY['key','previousKey','display','successor'] OR result->>'profile' IS DISTINCT FROM 'alias-erased-v1'
        OR profile_erasure_id IS DISTINCT FROM $2::uuid OR profile_erasure_epoch IS DISTINCT FROM $3::bigint))
    AND NOT EXISTS (SELECT 1 FROM access.alias_graph_import_report WHERE holder = $1
      AND (source IS NOT NULL OR legacy_alias IS NOT NULL OR reason <> 'Person alias erased'
        OR profile_erasure_id IS DISTINCT FROM $2::uuid OR profile_erasure_epoch IS DISTINCT FROM $3::bigint)) AS absent`,
  [proof.person, proof.erasureId, proof.erasureEpoch])).rows[0];
  return row?.absent === true;
}
