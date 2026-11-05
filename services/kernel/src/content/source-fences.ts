import type { PoolClient } from 'pg';
import type { ImportedFieldGroup } from './imported-contract.ts';
import { partitionOf } from '../route/route.ts';
import read from './read-source-fences.sql';

export type SourceFenceTuple = Readonly<{
  route: number;
  source: string;
  external_id: string;
  field_group: ImportedFieldGroup;
}>;

export type SourceFence = SourceFenceTuple &
  Readonly<{
    takenDown: boolean;
    securityRevision: string | null;
    takenDownAt?: string;
    takedownId?: string;
  }>;

const sourcePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const identity = (tuple: SourceFenceTuple) => JSON.stringify([tuple.source, tuple.external_id]);
const exactKey = (tuple: SourceFenceTuple) =>
  JSON.stringify([tuple.route, tuple.source, tuple.external_id, tuple.field_group]);

/**
 * Internal fact read, never a permission check. The caller computes routes with
 * tupleRoute using its stable route key and owns the independently anchored
 * client. Each statement reads one partition. No pool checkout, anchor or Access query occurs here.
 */
export async function readFences(
  client: Pick<PoolClient, 'query'>,
  tuples: readonly SourceFenceTuple[],
): Promise<readonly SourceFence[]> {
  if (!Array.isArray(tuples) || tuples.length > 100) throw new RangeError('At most 100 source fence tuples');
  const homes = new Map<string, number>();
  const requested = new Map<string, SourceFenceTuple>();
  const ordered: SourceFenceTuple[] = [];
  for (const tuple of tuples) {
    if (!tuple || typeof tuple !== 'object') throw new RangeError('Invalid source fence tuple');
    partitionOf(tuple.route);
    if (
      typeof tuple.source !== 'string' ||
      tuple.source.length > 32 ||
      sourcePattern.exec(tuple.source)?.[0] !== tuple.source ||
      typeof tuple.external_id !== 'string' ||
      tuple.external_id.length === 0 ||
      tuple.external_id.length > 1024 ||
      !tuple.external_id.isWellFormed() ||
      controls.test(tuple.external_id) ||
      Buffer.byteLength(tuple.external_id, 'utf8') > 1024 ||
      !['facts', 'summary', 'cover'].includes(tuple.field_group)
    )
      throw new RangeError('Invalid source fence identity or field group');
    const home = homes.get(identity(tuple));
    if (home !== undefined && home !== tuple.route) throw new RangeError('Conflicting source tuple routes');
    homes.set(identity(tuple), tuple.route);
    // Copy only bounded identity fields; never serialize caller metadata.
    const { route, source, external_id, field_group } = tuple;
    const normalized = { route, source, external_id, field_group };
    ordered.push(normalized);
    requested.set(exactKey(normalized), normalized);
  }
  if (requested.size === 0) return [];
  const groups = new Map<number, SourceFenceTuple[]>();
  for (const tuple of requested.values()) {
    const partition = partitionOf(tuple.route);
    const group = groups.get(partition) ?? [];
    group.push(tuple);
    groups.set(partition, group);
  }
  const stored = new Map<string, (typeof read)['~reylo']['element']>();
  for (const [partition, tuples] of groups) {
    const parameters: (typeof read)['~reylo']['input'] = { partition, tuples };
    const values: Record<string, unknown> = {
      partition: parameters.partition,
      tuples: JSON.stringify(parameters.tuples),
    };
    // Use the compiled typed statement directly: run() also issues periodic
    // catalogue freshness queries, which do not belong in an exact fact read.
    const { rows } = await client.query<(typeof read)['~reylo']['element']>(
      read.sql,
      read.params.map((name) => values[name]),
    );
    for (const row of rows) stored.set(exactKey(row as SourceFenceTuple), row);
  }
  return ordered.map((tuple) => {
    const row = stored.get(exactKey(tuple));
    return {
      ...tuple,
      takenDown: row?.takenDown ?? false,
      securityRevision: row?.securityRevision ?? null,
      ...(row?.takenDownAt != null && row.takedownId != null
        ? { takenDownAt: row.takenDownAt, takedownId: row.takedownId }
        : {}),
    };
  });
}
