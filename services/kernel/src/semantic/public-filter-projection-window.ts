import { facetProperties } from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import type { PoolClient } from 'pg';
import { memoizedValue } from '../memoized.ts';
import readPartition from '../partition/read.sql';
import readSubjects from './search-source-subjects.sql';
import readBuild from './public-filter-projection-build-read.sql';
import readPage from './public-filter-projection-page.sql';
import startBuild from './public-filter-projection-build-start.sql';
import retireBuildHeads from './public-filter-projection-build-retire.sql';

/** Bind the existing owner statements to this snapshot's typed columns. */
function correlate(query: { sql: string; params: readonly string[] }, bindings: Record<string, string>) {
  return query.sql
    .trim()
    .replace(/;$/, '')
    .replace(/\$(\d+)\b/g, (_, index: string) => {
      const name = query.params[Number(index) - 1]!;
      if (!Object.hasOwn(bindings, name)) throw new TypeError('Unknown projection operand ' + name);
      return bindings[name]!;
    });
}

const facetMaps = new WeakMap<Release, string>();

const key = { partition_no: '$1::integer', route: '$2::integer', subject_id: '$3::uuid' };
function subjectSql() {
  return correlate(readSubjects, {
    partition_no: key.partition_no,
    routes: 'ARRAY[$2::integer]',
    subject_ids: 'ARRAY[$3::uuid]',
  });
}

/** Owner, revision, privacy and the actual selected keyset all come from one statement snapshot. */
export function projectionWindowSql() {
  return memoizedValue(projectionWindowSql, () => {
    const build = correlate(readBuild, { ...key, meaning_digest: '$4::text' });
    const selected = correlate(readPage, {
      ...key,
      properties: 'ARRAY(SELECT jsonb_array_elements_text($5::jsonb -> s.type))',
      after_property: '$6::text',
      after_slot: '$7::uuid',
      after_candidate: '$8::uuid',
      input_limit: '$9::integer',
    });
    return `SELECT to_jsonb(home) || jsonb_build_object('position',home.position::text) AS owner, to_jsonb(s) AS subject,
      h.position::text AS privacy, to_jsonb(b) AS build,
      ARRAY(SELECT to_jsonb(f) FROM (${selected}) f WHERE s.id IS NOT NULL ORDER BY f.property COLLATE "C", f.slot_id, f.candidate_id) AS selected
      FROM (${correlate(readPartition, { partition_no: key.partition_no })}) home
      LEFT JOIN LATERAL (${subjectSql()}) s ON true
      LEFT JOIN semantic.public_filter_privacy_head h ON h.partition_no=$1
      LEFT JOIN LATERAL (${build}) b ON $10::boolean`;
  });
}

export function facetsByType(release: Release) {
  let serialized = facetMaps.get(release);
  if (serialized === undefined) {
    serialized = JSON.stringify(
      Object.fromEntries(Object.keys(release.types).map((type) => [type, facetProperties(release, [type])])),
    );
    facetMaps.set(release, serialized);
  }
  return serialized;
}

/** Check the original subject and every head about to be retained at the build's snapshot. */
export function projectionCurrentSql() {
  return memoizedValue(
    projectionCurrentSql,
    () => `SELECT p.position::text, to_jsonb(s) AS subject
    FROM core.partition p CROSS JOIN LATERAL (${subjectSql()}) s
    WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=$4
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset($5::jsonb) e(partition_no integer,owner_epoch integer,position bigint)
      WHERE NOT EXISTS (SELECT 1 FROM core.partition owner JOIN semantic.public_filter_privacy_head h
        ON h.partition_no=owner.partition_no AND h.owner_epoch=owner.epoch
        WHERE owner.partition_no=e.partition_no AND owner.write_state='active'
          AND owner.epoch=e.owner_epoch AND h.position=e.position))`,
  );
}

/** The caller holds the prior build lock. Replace its old heads and seed the new generation atomically. */
export async function startProjectionWithHeads(
  client: PoolClient,
  input: Parameters<typeof startBuild.run>[1],
  heads: string,
) {
  const sql = memoizedValue(startProjectionWithHeads, () => {
    const bind = startBuild.params.length + 1;
    const retired = correlate(retireBuildHeads, {
      subject_id: '$' + (startBuild.params.indexOf('subject_id') + 1),
      partition_no: '$' + (startBuild.params.indexOf('partition_no') + 1),
    });
    return `WITH removed AS (${retired}),
      created AS (${startBuild.sql.trim().replace(/;$/, '')}),
      retained AS (INSERT INTO semantic.public_filter_projection_head(build_id,partition_no,owner_epoch,position)
        SELECT c.build_id::uuid,h.partition_no,h.owner_epoch,h.position FROM created c,
        jsonb_to_recordset($${bind}::jsonb) h(partition_no integer,owner_epoch integer,position bigint))
      SELECT build_id,generation,route FROM created`;
  });
  const values = startBuild['~standard'].query.encode(input);
  return (await client.query<{ build_id: string; generation: string; route: number }>(sql, [...values, heads])).rows[0];
}
