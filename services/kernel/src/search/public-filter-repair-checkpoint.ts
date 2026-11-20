import type { OpenSearch } from './opensearch.ts';
import { SearchUnavailableError } from './opensearch.ts';

type Shard = {
  routing: {
    primary: boolean;
    node: string;
    state: string;
    relocating_node: string | null;
  };
  seq_no: {
    max_seq_no: number;
    local_checkpoint: number;
    global_checkpoint: number;
  };
  retention_leases: { primary_term: number };
};

/** With a successful refresh and an unchanged checkpoint, exact winner readbacks
 * can span calls. Include every searchable copy and its primary term so moves,
 * failover and direct engine writes invalidate the proof. */
export async function readRepairWinnerCheckpoint(search: OpenSearch, index: string, incarnation: string) {
  const { status, body } = await search.request<{
    _shards?: { total: number; successful: number; failed: number };
    indices?: Record<string, { uuid: string; shards: Record<string, Shard[]> }>;
  }>('GET', `/${index}/_stats/docs`, undefined, {
    query: {
      level: 'shards',
      filter_path:
        '_shards,indices.*.uuid,indices.*.shards.*.routing,indices.*.shards.*.seq_no,indices.*.shards.*.retention_leases.primary_term',
    },
  });
  const target = body?.indices?.[index];
  const entries = Object.entries(target?.shards ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  const unavailable = () => new SearchUnavailableError('Native repair winner checkpoint is unavailable');
  if (
    status !== 200 ||
    target?.uuid !== incarnation ||
    Object.keys(body?.indices ?? {}).length !== 1 ||
    !entries.length ||
    entries.some(([, copies]) => !Array.isArray(copies) || copies.some((copy) => !copy)) ||
    body?._shards?.failed !== 0 ||
    body._shards.successful !== body._shards.total ||
    body._shards.total !== entries.reduce((count, [, copies]) => count + copies.length, 0)
  )
    throw unavailable();
  return entries.map(([id, copies]) => {
    const primaries = copies.filter(({ routing }) => routing?.primary);
    if (primaries.length !== 1) throw unavailable();
    const primaryPosition = primaries[0]!.seq_no?.max_seq_no;
    return [
      id,
      copies
        .map(({ routing, seq_no, retention_leases }) => {
          if (
            routing?.state !== 'STARTED' ||
            routing.relocating_node !== null ||
            typeof routing.node !== 'string' ||
            !routing.node ||
            typeof routing.primary !== 'boolean' ||
            !Number.isSafeInteger(seq_no?.max_seq_no) ||
            seq_no.max_seq_no < -1 ||
            seq_no.max_seq_no !== primaryPosition ||
            seq_no.max_seq_no !== seq_no.local_checkpoint ||
            !Number.isSafeInteger(seq_no.global_checkpoint) ||
            !Number.isSafeInteger(retention_leases?.primary_term) ||
            retention_leases.primary_term < 1
          )
            throw unavailable();
          return { routing, seq_no, term: retention_leases.primary_term };
        })
        .sort((a, b) => a.routing.node.localeCompare(b.routing.node)),
    ];
  });
}
