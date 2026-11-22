import { OpenSearchError, type OpenSearch } from './opensearch.ts';

type Shard = {
  routing?: { primary?: boolean; state?: string; relocating_node?: string | null; node?: string };
  seq_no?: { max_seq_no?: number; local_checkpoint?: number };
  docs?: { count?: number; deleted?: number };
  refresh?: { external_total?: number };
  retention_leases?: { primary_term?: number };
};

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Bracket PIT capture with the physical incarnation, completed write frontier
 * and externally visible reader. Include nested and deleted Lucene documents.
 */
export async function bookRelevanceBound(search: OpenSearch, target: string, slots: number | undefined) {
  if (!integer(slots, 1, 100)) return null;
  const limit = Math.min(600, 6 * slots + 3);
  const response = await search
    .request<{
      _shards?: { total?: number; successful?: number; failed?: number };
      indices?: Record<string, { uuid?: string; shards?: Record<string, Shard[]> }>;
    }>('GET', `/${target}/_stats/docs,refresh`, undefined, {
      query: {
        level: 'shards',
        filter_path: [
          '_shards',
          'indices.*.uuid',
          ...['routing', 'seq_no', 'docs', 'refresh.external_total', 'retention_leases.primary_term'].map(
            (field) => 'indices.*.shards.*.' + field,
          ),
        ].join(','),
      },
    })
    .catch((error) => {
      if (error instanceof OpenSearchError && [400, 403, 404].includes(error.status)) return null;
      throw error;
    });
  const body = response?.body;
  const index = body?.indices?.[target];
  const copies = index?.shards?.['0'];
  const shard = copies?.[0];
  const routing = shard?.routing;
  const sequence = shard?.seq_no?.max_seq_no;
  const refresh = shard?.refresh?.external_total;
  const term = shard?.retention_leases?.primary_term;
  const count = shard?.docs?.count;
  const deleted = shard?.docs?.deleted;
  if (
    response?.status !== 200 ||
    body?._shards?.total !== 1 ||
    body._shards.successful !== 1 ||
    body._shards.failed !== 0 ||
    !index?.uuid ||
    Object.keys(body.indices!).length !== 1 ||
    Object.keys(index.shards ?? {}).length !== 1 ||
    copies?.length !== 1 ||
    routing?.primary !== true ||
    routing.state !== 'STARTED' ||
    routing.relocating_node !== null ||
    !routing.node ||
    !integer(term, 1) ||
    !integer(refresh, 0) ||
    !integer(sequence, -1, limit - 1) ||
    shard?.seq_no?.local_checkpoint !== sequence ||
    !integer(count, 0, slots) ||
    !integer(deleted, 0, limit - count)
  )
    return null;
  return { uuid: index.uuid, node: routing.node, term, sequence, refresh };
}
