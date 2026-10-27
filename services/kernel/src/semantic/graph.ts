import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import type { KeyRing } from '../tokens/seal.ts';
import { encodeCursor } from '../tokens/cursor.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from './read.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { SubjectRedirectError, redirectOf } from './merges.ts';
import readVisibility from './read-visibility.sql';
import readGraphExpansions from './read-graph-expansions.sql';
import readTypes from './read-item-types.sql';
import { readSubjectSummaries, type SubjectSummary, type SummaryDependencies } from './summaries.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const EDGE_LIMIT = 500;
const SUMMARY_CHUNK_SIZE = 256;
// The anchor and at most one new node per emitted edge: ceil(501 / 256) = 2 chunks for the whole graph.
const MAX_SUMMARY_CHUNKS = Math.ceil((EDGE_LIMIT + 1) / SUMMARY_CHUNK_SIZE);

export type GraphDirection = 'out' | 'in' | 'both';
type EdgeDirection = Exclude<GraphDirection, 'both'>;

type Expansion = { node: string; property: string; direction: EdgeDirection };
type GraphNode = { id: string; type: string; label: string; summary: SubjectSummary };
type GraphEdge = { from: string; property: string; to: string; statement: string };
type TruncatedExpansion = {
  node: string;
  property: string;
  direction: EdgeDirection;
  count: number;
  cursor: string;
};

export type SubjectGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: TruncatedExpansion[];
  component: { partition: number; epoch: number; position: bigint };
};

type ExpansionRow = {
  ordinal: number;
  node: string;
  property: string;
  direction: EdgeDirection;
  count: string | number;
  page_rows: { other: string | null; statement: string; orderKey: string }[] | null;
  fetched_count: number;
  available_before: number | null;
  emitted_before: number;
  emitted_after: number;
  used: number;
  epoch: number;
};

function groupsOf(ids: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const id of new Set(ids)) {
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(id);
    groups.set(partition, group);
  }
  return groups;
}

async function visibleIdsFor(client: PoolClient, ids: readonly string[]): Promise<string[]> {
  const visible: string[] = [];
  for (const [partition, subjects] of groupsOf(ids)) {
    const rows = (await readTypes.run(client, {
      partition_no: partition,
      routes: subjects.map((id) => routeOf(id)!),
      subject_ids: subjects,
    })) as { id: string; type: string }[];
    for (const row of rows) visible.push(row.id);
  }
  return visible;
}

function directionsOf(direction: GraphDirection): EdgeDirection[] {
  return direction === 'both' ? ['out', 'in'] : [direction];
}

function expansionsFor(
  nodes: readonly string[],
  properties: readonly string[],
  direction: GraphDirection,
): Expansion[] {
  const result: Expansion[] = [];
  const directions = directionsOf(direction);
  for (const node of nodes) {
    for (const property of properties) {
      for (const expansionDirection of directions) result.push({ node, property, direction: expansionDirection });
    }
  }
  return result;
}

function linkCursor(
  ring: KeyRing,
  languages: readonly string[],
  row: ExpansionRow,
  after: readonly (string | number)[],
): string {
  if (row.direction === 'out') {
    return encodeCursor(
      ring,
      {
        operation: 'subject.relations',
        parameters: {
          subject: row.node,
          property: row.property,
          context: NIL_UUID,
          filter: null,
          type: null,
          language: languages.join(',') || null,
        },
      },
      { epoch: row.epoch, after },
    );
  }
  return encodeCursor(
    ring,
    {
      operation: 'subject.links',
      parameters: {
        subject: row.node,
        property: row.property,
        filter: null,
        type: null,
        language: languages.join(',') || null,
      },
    },
    { epoch: row.epoch, after },
  );
}

async function readExpansions(
  client: PoolClient,
  options: {
    requests: readonly Expansion[];
    limit: number;
    remaining: number;
  },
): Promise<{ rows: ExpansionRow[]; used: number }> {
  const partitions = new Map<number, Expansion[]>();
  for (const request of options.requests) {
    const route = routeOf(request.node);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = partitions.get(partition) ?? [];
    group.push(request);
    partitions.set(partition, group);
  }
  const output: ExpansionRow[] = [];
  let remaining = options.remaining;
  for (const [partition, requests] of [...partitions].sort(([left], [right]) => left - right)) {
    const input = requests.map((request, ordinal) => ({
      ordinal: ordinal + 1,
      node: request.node,
      route: routeOf(request.node)!,
      property: request.property,
      direction: request.direction,
    }));
    const rows = (await readGraphExpansions.run(client, {
      partition_no: partition,
      limit: options.limit,
      edge_budget: remaining,
      requests: input,
    })) as ExpansionRow[];
    const used = Number(rows[0]?.used ?? 0);
    remaining = Math.max(0, remaining - used);
    output.push(...rows);
  }
  return { rows: output, used: options.remaining - remaining };
}

export async function listSubjectGraph(
  pool: Pool,
  ring: KeyRing,
  options: {
    subject: string;
    properties: readonly string[];
    direction: GraphDirection;
    depth: 1 | 2;
    limit: number;
    languages: readonly string[];
    release: Release;
    authorizeSummary: SummaryDependencies['authorize'];
    authorize: (client: PoolClient) => Promise<boolean>;
  },
): Promise<SubjectGraph> {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 25)
    throw new RangeError('Invalid graph page size');
  const partitionNo = partitionOf(route);

  const graph = await withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionNo);
    const state = (await readVisibility.run(client, { route, subject_id: options.subject })) as {
      visibility: string;
    } | null;
    if (!partition || state?.visibility !== 'visible' || !(await options.authorize(client)))
      throw new SubjectNotFoundError();
    const redirect = await redirectOf(client, options.subject);
    if (redirect) throw new SubjectRedirectError(options.subject, redirect);
    await client.query('SET LOCAL enable_seqscan = off');
    // Ordered graph pages must stop in the index; a bitmap plan reads every edge in a hub before applying LIMIT.
    await client.query('SET LOCAL enable_bitmapscan = off');

    const visibleNodes = new Set([options.subject]);
    let frontier = [options.subject];
    const edges: GraphEdge[] = [];
    const edgeKeys = new Set<string>();
    const truncated: TruncatedExpansion[] = [];
    let remaining = EDGE_LIMIT;

    for (let currentDepth = 1; currentDepth <= options.depth; currentDepth++) {
      const requests = expansionsFor(frontier, options.properties, options.direction);
      const expansionResult = await readExpansions(client, {
        requests,
        limit: options.limit,
        remaining,
      });
      remaining = Math.max(0, remaining - expansionResult.used);

      const discovered = new Set<string>();
      for (const row of expansionResult.rows) {
        const rows = Array.isArray(row.page_rows) ? row.page_rows : [];
        const pageCapacity = Math.max(0, Math.min(options.limit, row.available_before ?? 0, row.fetched_count));
        const selected = rows.slice(0, pageCapacity);
        const count = Number(row.count);
        if (count > selected.length) {
          const last = selected.at(-1);
          const after = last ? [last.orderKey, last.other ?? NIL_UUID, last.statement] : ['', NIL_UUID, NIL_UUID];
          truncated.push({
            node: row.node,
            property: row.property,
            direction: row.direction,
            count,
            cursor: linkCursor(ring, options.languages, row, after),
          });
        }
        for (const entry of selected) {
          if (entry.other === null) continue;
          const from = row.direction === 'out' ? row.node : entry.other;
          const to = row.direction === 'out' ? entry.other : row.node;
          discovered.add(entry.other);
          const edge = { from, property: row.property, to, statement: entry.statement };
          const key = JSON.stringify([edge.from, edge.property, edge.to, edge.statement]);
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push(edge);
          }
        }
      }

      const previouslyVisible = new Set(visibleNodes);
      const visible = await visibleIdsFor(
        client,
        [...discovered].filter((id) => !visibleNodes.has(id)),
      );
      for (const id of visible) visibleNodes.add(id);
      frontier = [...discovered].filter((id) => visibleNodes.has(id) && !previouslyVisible.has(id));
    }

    return {
      ids: [...visibleNodes],
      edges,
      truncated,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
  // Access evidence preparation uses the pool before its checks run; release the traversal connection first.
  const summaries = new Map<string, SubjectSummary | null>();
  for (let chunk = 0; chunk < MAX_SUMMARY_CHUNKS; chunk++) {
    const batch = graph.ids.slice(chunk * SUMMARY_CHUNK_SIZE, (chunk + 1) * SUMMARY_CHUNK_SIZE);
    if (!batch.length) break;
    const filled = await readSubjectSummaries(
      { client: { query: pool.query.bind(pool) }, pool, release: options.release, authorize: options.authorizeSummary },
      batch,
      { languages: options.languages },
    );
    for (const [id, summary] of filled) summaries.set(id, summary);
  }
  const disclosedEdges = graph.edges.filter((edge) => summaries.get(edge.from) && summaries.get(edge.to));
  const neighbours = new Map<string, string[]>();
  for (const edge of disclosedEdges) {
    for (const [from, to] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      const group = neighbours.get(from) ?? [];
      group.push(to);
      neighbours.set(from, group);
    }
  }
  // Removing an unreadable bridge must also remove nodes that no longer connect to the anchor.
  const connected = new Set<string>(summaries.get(options.subject) ? [options.subject] : []);
  for (const id of connected) for (const neighbour of neighbours.get(id) ?? []) connected.add(neighbour);
  const nodes = graph.ids.flatMap((id) => {
    const summary = summaries.get(id);
    return summary && connected.has(id) ? [{ id, type: summary.type, label: summary.label?.value ?? '', summary }] : [];
  });
  return {
    nodes,
    edges: disclosedEdges.filter((edge) => connected.has(edge.from) && connected.has(edge.to)).slice(0, EDGE_LIMIT),
    truncated: graph.truncated.filter((entry) => connected.has(entry.node)),
    component: graph.component,
  };
}
