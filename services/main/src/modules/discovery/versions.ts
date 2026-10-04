import type { PoolClient } from 'pg';
import type { DiscoveryGeneration } from './store.ts';
import { DISCOVERY_COST, type DiscoveryPayload, type ProjectedWork } from './contract.ts';
import { RecommendationUnavailable } from '../recommendation/derived-generation.ts';

/** No catalogue copy/COUNT: <=W canonical rows, <=W*20 counters, <=W*84
 * posting versions. All reads address a storage family and explicit keys. */
export const DISCOVERY_VERSION_COST = {
  works: DISCOVERY_COST.buildWorks,
  entriesPerWork: DISCOVERY_COST.entriesPerWork,
  countersPerWork: DISCOVERY_COST.termsPerWork,
  statements: 16,
} as const;

export async function discoveryWriter(
  client: PoolClient,
  row: Pick<DiscoveryGeneration, 'generation_id'>,
) {
  await client.query("SELECT set_config('rezics.discovery_writer',$1,true)", [row.generation_id]);
}

/** An operator can activate an older independent cut. Reuse only the storage
 * family's current physical snapshot, never silently inherit a later one.
 * Every projected Work publishes its canonical posting alongside its tags. */
export async function discoveryStorageReusable(client: PoolClient, row: DiscoveryGeneration) {
  const result = (
    await client.query<{ reusable: boolean }>(
      `SELECT NOT EXISTS (
    SELECT 1 FROM access.discovery_entry WHERE generation_id=$1 AND work_type='' AND term=''
      AND entry_version>$2 LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM access.discovery_entry WHERE generation_id=$1 AND retired_version>$2 LIMIT 1) AS reusable`,
      [row.storage_generation ?? row.generation_id, row.storage_version ?? '0'],
    )
  ).rows[0];
  return !!result?.reusable;
}

export async function repairAbandonedDiscoveryVersion(
  client: PoolClient,
  row: DiscoveryGeneration,
) {
  const abandoned = (
    await client.query<
      Pick<DiscoveryGeneration, 'generation_id' | 'storage_generation' | 'storage_version'>
    >(
      `SELECT d.generation_id,d.storage_generation,d.storage_version::text
    FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
    WHERE d.storage_generation=$1 AND d.storage_version>$2
      AND g.state IN ('failed','cancelled','expired') ORDER BY d.storage_version DESC LIMIT 1 FOR UPDATE OF g`,
      [row.storage_generation ?? row.generation_id, row.storage_version ?? '0'],
    )
  ).rows[0];
  if (abandoned) {
    await rollbackDiscoveryVersion(client, abandoned);
  }
}

interface Counter {
  key: string;
  concept: string;
  count: number;
}
async function counters(
  client: PoolClient,
  row: DiscoveryGeneration,
  kind: 'term' | 'concept',
  changes: Map<string, Counter>,
) {
  if (!changes.size) return;
  const table = kind === 'term' ? 'discovery_term_count' : 'discovery_concept_count';
  const field = kind === 'term' ? 'term' : 'concept';
  const keys = [...changes.keys()];
  const root = row.storage_generation ?? row.generation_id,
    version = row.storage_version ?? '0';
  const old = (
    await client.query<{ key: string; count: string; concept: string }>(
      `SELECT ${field} AS key,
    work_count::text AS count, concept FROM access.${table} WHERE generation_id=$1 AND ${field}=ANY($2::text[])
      AND retired_version IS NULL AND entry_version<=$3`,
      [root, keys, version],
    )
  ).rows;
  for (const value of old) {
    const next = changes.get(value.key)!;
    if (next.concept !== value.concept)
      throw new RecommendationUnavailable('Discovery term meaning changed');
    next.count += Number(value.count);
  }
  if (
    [...changes.values()].some((value) => !Number.isSafeInteger(value.count) || value.count < 0)
  ) {
    throw new RecommendationUnavailable('Discovery counter underflow');
  }
  await client.query(
    `DELETE FROM access.${table} WHERE generation_id=$1 AND ${field}=ANY($2::text[]) AND entry_version=$3`,
    [root, keys, version],
  );
  await client.query(
    `UPDATE access.${table} SET retired_version=$3 WHERE generation_id=$1
    AND ${field}=ANY($2::text[]) AND entry_version<$3 AND retired_version IS NULL`,
    [root, keys, version],
  );
  const values = [...changes.values()].filter((value) => value.count > 0);
  if (values.length)
    await client.query(
      `INSERT INTO access.${table}
    (generation_id,${kind === 'term' ? 'term,concept' : 'concept'},work_count,entry_version)
    SELECT $1,${kind === 'term' ? 'v.key,v.concept' : 'v.key'},v.count,$3
    FROM jsonb_to_recordset($2::jsonb) v(key text,concept text,count bigint)`,
      [root, JSON.stringify(values), version],
    );
}

/** Replace explicit Works, preserving every older logical generation's rows. */
export async function replaceDiscoveryWorks(
  client: PoolClient,
  row: DiscoveryGeneration,
  works: readonly string[],
  items: ProjectedWork[],
) {
  if (works.length > DISCOVERY_VERSION_COST.works)
    throw new RecommendationUnavailable('Discovery replacement exceeds its Work bound');
  const root = row.storage_generation ?? row.generation_id,
    version = row.storage_version ?? '0';
  const old = works.length
    ? (
        await client.query<{ work: string; payload: DiscoveryPayload }>(
          `SELECT work,payload
    FROM access.discovery_entry WHERE generation_id=$1 AND work=ANY($2::text[]) AND work_type='' AND term=''
      AND retired_version IS NULL AND entry_version<=$4 LIMIT $3`,
          [root, works, works.length + 1, version],
        )
      ).rows
    : [];
  if (old.length > works.length || new Set(old.map((value) => value.work)).size !== old.length) {
    throw new RecommendationUnavailable('Discovery replacement source is ambiguous');
  }
  const terms = new Map<string, Counter>(),
    concepts = new Map<string, Counter>();
  const charge = (classification: { sense: string; concept: string }[], sign: number) => {
    const unique = new Map(classification.map((value) => [value.sense, value.concept]));
    if (unique.size > DISCOVERY_COST.termsPerWork)
      throw new RecommendationUnavailable('Discovery counter fanout exceeds its bound');
    for (const [key, concept] of unique) {
      const prior = terms.get(key);
      if (prior && prior.concept !== concept)
        throw new RecommendationUnavailable('Discovery term meaning changed');
      terms.set(key, { key, concept, count: (prior?.count ?? 0) + sign });
    }
    for (const key of new Set(unique.values()))
      concepts.set(key, { key, concept: key, count: (concepts.get(key)?.count ?? 0) + sign });
  };
  // Card payloads intentionally retain only three tags. Counter maintenance
  // uses the complete bounded Work posting lists, including migrated builds.
  const oldTerms = works.length
    ? (
        await client.query<{ work: string; sense: string; concept: string }>(
          `SELECT work,
    term AS sense,payload->'classification'->>'concept' AS concept FROM access.discovery_entry
    WHERE generation_id=$1 AND work=ANY($2::text[]) AND work_type='' AND term<>''
      AND retired_version IS NULL AND entry_version<=$4 LIMIT $3`,
          [root, works, works.length * DISCOVERY_COST.termsPerWork + 1, version],
        )
      ).rows
    : [];
  if (oldTerms.length > works.length * DISCOVERY_COST.termsPerWork)
    throw new RecommendationUnavailable('Discovery old counter fanout exceeds its bound');
  const byWork = new Map<string, typeof oldTerms>();
  for (const value of oldTerms) byWork.set(value.work, [...(byWork.get(value.work) ?? []), value]);
  for (const value of byWork.values()) charge(value, -1);
  for (const item of items) charge(item.classifications, 1);
  for (const [key, value] of terms) if (!value.count) terms.delete(key);
  for (const [key, value] of concepts) if (!value.count) concepts.delete(key);
  await counters(client, row, 'term', terms);
  await counters(client, row, 'concept', concepts);
  if (works.length) {
    await client.query(
      `DELETE FROM access.discovery_entry WHERE generation_id=$1 AND work=ANY($2::text[]) AND entry_version=$3`,
      [root, works, version],
    );
    await client.query(
      `UPDATE access.discovery_entry SET retired_version=$3
      WHERE generation_id=$1 AND work=ANY($2::text[]) AND entry_version<$3 AND retired_version IS NULL`,
      [root, works, version],
    );
  }
  return old.length;
}

/** A failed staged delta cannot leak into the next version of its storage root. */
export async function rollbackDiscoveryVersion(
  client: PoolClient,
  row: Pick<DiscoveryGeneration, 'generation_id' | 'storage_generation' | 'storage_version'>,
) {
  if (!row.storage_generation) return;
  await discoveryWriter(client, row);
  await client.query("SELECT set_config('rezics.discovery_mode','rollback',true)");
  for (const table of ['discovery_entry', 'discovery_term_count', 'discovery_concept_count']) {
    await client.query(`DELETE FROM access.${table} WHERE generation_id=$1 AND entry_version=$2`, [
      row.storage_generation,
      row.storage_version,
    ]);
    await client.query(
      `UPDATE access.${table} SET retired_version=NULL WHERE generation_id=$1 AND retired_version=$2`,
      [row.storage_generation, row.storage_version],
    );
  }
}
