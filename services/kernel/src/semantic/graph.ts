import { requireAccessDeadline } from '../access/unavailable.ts';
import type { Pool, PoolClient } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { encodeCursor } from '../tokens/cursor.ts';
import type { Item } from './item.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from './read.ts';
import { SubjectNotFoundError } from './candidates.ts';
import { SubjectRedirectError, redirectOf } from './merges.ts';
import readVisibility from './read-visibility.sql';
import readGraphExpansions from './read-graph-expansions.sql';
import readTypes from './read-item-types.sql';
import readLabelChoices from './read-label-choices.sql';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { slotId } from './slots.ts';
import { chooseLabel } from './language.ts';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const EDGE_LIMIT = 500;

export type GraphDirection = 'out' | 'in' | 'both';
type EdgeDirection = Exclude<GraphDirection, 'both'>;

type Expansion = { node: string; property: string; direction: EdgeDirection };
type GraphNode = { id: string; type: string; label: string };
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

type LabelChoice = { labels: Item['labels']; original: string | null };
type NodeDetails = { type: string; labels: Item['labels']; original: string | null };

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

async function detailsFor(client: PoolClient, ids: readonly string[]): Promise<Map<string, NodeDetails>> {
  const details = new Map<string, NodeDetails>();
  for (const [partition, subjects] of groupsOf(ids)) {
    const rows = (await readTypes.run(client, {
      partition_no: partition,
      routes: subjects.map((id) => routeOf(id)!),
      subject_ids: subjects,
    })) as { id: string; type: string }[];
    const choices = (await readLabelChoices.run(client, {
      partition_no: partition,
      context_id: GLOBAL_CONTEXT,
      subjects: subjects.map((id) => ({ route: routeOf(id)!, id, original: slotId(id, 'schema:inLanguage') })),
    })) as { id: string; labels: Item['labels']; original: string | null }[];
    const labels = new Map<string, LabelChoice>();
    for (const row of choices) labels.set(row.id, { labels: row.labels ?? {}, original: row.original });
    for (const row of rows) {
      const choice = labels.get(row.id);
      details.set(row.id, {
        type: row.type,
        labels: choice?.labels ?? {},
        original: choice?.original ?? null,
      });
    }
  }
  return details;
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

    const nodeDetails = await detailsFor(client, [options.subject]);
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
      const details = await detailsFor(
        client,
        [...discovered].filter((id) => !nodeDetails.has(id)),
      );
      for (const [id, detail] of details) {
        nodeDetails.set(id, detail);
        visibleNodes.add(id);
      }
      frontier = [...discovered].filter((id) => visibleNodes.has(id) && !previouslyVisible.has(id));
    }

    const nodes = [...visibleNodes].flatMap((id) => {
      const detail = nodeDetails.get(id);
      if (!detail) return [];
      return [
        {
          id,
          type: detail.type,
          label: chooseLabel(detail.labels, options.languages, detail.original)?.value ?? '',
        },
      ];
    });
    const visibleEdges = edges.filter((edge) => visibleNodes.has(edge.from) && visibleNodes.has(edge.to));
    return {
      nodes,
      edges: visibleEdges.slice(0, EDGE_LIMIT),
      truncated,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
  requireAccessDeadline();
  return graph;
}
