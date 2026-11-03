import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import { relationFields } from '../../../subject/relation-candidates';

/** Native graph.ts: per-expansion neighbour page, not a vertex or whole-graph cap. */
export const GRAPH_DEPTHS = [1, 2] as const;
export const GRAPH_LIMIT = 25;
export const GRAPH_PROPERTY_CAP = 8;
/** Producer edge-exploration budget; Web never requests more than GRAPH_LIMIT per expansion. */
export const GRAPH_EDGE_BUDGET = 500;
export const GRAPH_DETAIL_CAP = 2;
export const GRAPH_LIST_ROW_CAP = 25;
export const GRAPH_DETAIL_BYTE_CAP = 262_144;
export const QUOTATION_PAGE_CAP = 20;
export const CONCEPT_PAGE_CAP = 20;
export const MUSIC_CONTEXT_PAGE_CAP = 20;

export type GraphDepth = (typeof GRAPH_DEPTHS)[number];
export type GraphDirection = 'out' | 'in' | 'both';
export type GraphEdgeDirection = Exclude<GraphDirection, 'both'>;
export type ExploreFailure = CandidateFailure;
export type GraphNode = {
  id: string;
  type: string;
  label: string;
  summary: {
    id: string;
    type: string;
    label: { value: string; language: string } | null;
  };
};
export type GraphEdge = { from: string; property: string; to: string; statement: string };
export type GraphTruncation = {
  node: string;
  property: string;
  direction: GraphEdgeDirection;
  count?: number | undefined;
  cursor: string;
};
export type GraphPage = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: GraphTruncation[] };
export type GraphRelation = {
  id: string;
  label: { text: string; lang: string | null };
  inverse: { text: string; lang: string | null } | null;
  group: string;
  out?: number;
  in?: number;
};
export type GraphSelection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; statement: string; from: string; to: string; property: string };
export type GraphDetail = {
  subject: SubjectRead;
  statement?: SubjectRead['subject']['statements'][string][number];
  labels: Record<string, ReturnType<typeof pickText>>;
};
export type ExploreCost = {
  nativeCalls: number;
  valuesProcessed: number;
  bytesRetained: number;
  paths: string[];
};
export type GraphRead =
  | ExploreFailure
  | {
      ok: true;
      public: SubjectRead;
      relations: GraphRelation[];
      query: { property: string[]; direction: GraphDirection; depth: GraphDepth };
      graph: GraphPage;
      detail: GraphDetail | null;
      cost: ExploreCost;
      session?: string | undefined;
    };

type Endpoint = ReturnType<KernelClient['subjects']>;
type NativeGraph = Extract<NonNullable<Awaited<ReturnType<Endpoint['graph']['get']>>['data']>, { nodes: unknown[] }>;
type NativeCounts = Extract<NonNullable<Awaited<ReturnType<Endpoint['counts']['get']>>['data']>, { properties?: unknown }>;
type NativeRelations = Extract<NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>, { relations: unknown[] }>;
type NativeLinks = Extract<NonNullable<Awaited<ReturnType<Endpoint['links']['get']>>['data']>, { links: unknown[] }>;
type Definitions = Pick<Release, 'types' | 'properties'>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isExploreId(value: string): boolean {
  return uuid.test(value);
}

export function typeExtends(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => typeExtends(release, base, target, seen));
}

export function graphQueryOf(input: {
  property?: string | readonly string[] | undefined;
  direction?: string | undefined;
  depth?: string | number | undefined;
}): { property: string[]; direction: GraphDirection; depth: GraphDepth } | undefined {
  const raw = Array.isArray(input.property)
    ? input.property
    : typeof input.property === 'string'
      ? input.property.split(',')
      : [];
  const property = [...new Set(raw.map((id) => id.trim()).filter(Boolean))].slice(0, GRAPH_PROPERTY_CAP);
  if (!property.length || property.some((id) => id.length > 128)) return;
  const direction = input.direction === 'out' || input.direction === 'in' ? input.direction : 'both';
  const depth = Number(input.depth) === 2 ? 2 : 1;
  return { property, direction, depth };
}

function headersOf(authorization?: string, session?: string): Record<string, string> {
  return {
    ...(authorization ? { authorization } : {}),
    ...(session ? { 'rezics-session-token': session } : {}),
  };
}

function tokenOf(result: { headers?: HeadersInit | undefined }): string | undefined {
  const value = new Headers(result.headers ?? {}).get('rezics-session-token');
  return value || undefined;
}

function emptyCost(): ExploreCost {
  return { nativeCalls: 0, valuesProcessed: 0, bytesRetained: 0, paths: [] };
}

function recordCall(cost: ExploreCost, path: string, values: number, retained: unknown) {
  cost.nativeCalls += 1;
  cost.valuesProcessed += values;
  cost.bytesRetained = Math.max(cost.bytesRetained, jsonBytes(retained));
  cost.paths.push(path);
}

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function graphShapeBound(depth: GraphDepth, properties = 1, direction: GraphDirection = 'both'): number {
  const directions = direction === 'both' ? 2 : 1;
  const first = Math.min(GRAPH_LIMIT * properties * directions, GRAPH_EDGE_BUDGET);
  if (depth === 1) return first + 1;
  return Math.min(GRAPH_EDGE_BUDGET, first + first * properties * directions) + 1;
}

function asGraph(data: NativeGraph): GraphPage {
  return {
    nodes: data.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      summary: {
        id: node.summary.id,
        type: node.summary.type,
        label: node.summary.label,
      },
    })),
    edges: data.edges.map((edge) => ({
      from: edge.from,
      property: edge.property,
      to: edge.to,
      statement: edge.statement,
    })),
    truncated: data.truncated.map((entry) => ({
      node: entry.node,
      property: entry.property,
      direction: entry.direction,
      ...(typeof entry.count === 'number' ? { count: entry.count } : {}),
      cursor: entry.cursor,
    })),
  };
}

function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.from, edge.property, edge.to, edge.statement]);
}

export function mergeGraphPage(current: GraphPage, extra: GraphPage, replaceNode?: string): GraphPage {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const edges = new Map(current.edges.map((edge) => [edgeKey(edge), edge]));
  for (const node of extra.nodes) nodes.set(node.id, node);
  for (const edge of extra.edges) edges.set(edgeKey(edge), edge);
  const truncated = current.truncated.filter((entry) => entry.node !== replaceNode);
  for (const entry of extra.truncated) truncated.push(entry);
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

function relationOptions(release: Definitions, type: string, locale: string, counts: NativeCounts): GraphRelation[] {
  const counted = counts.properties ?? {};
  return relationFields(release as Release, type, locale).flatMap((field) => {
    const property = release.properties[field.id];
    const inverse = property?.relation?.inverseLabels
      ? pickText(property.relation.inverseLabels, locale)
      : null;
    const tally = counted[field.id];
    return [
      {
        id: field.id,
        label: pickText(property?.labels ?? { en: field.label }, locale),
        inverse: inverse && inverse.text ? inverse : null,
        group: field.group,
        ...(typeof tally?.out === 'number' ? { out: tally.out } : {}),
        ...(typeof tally?.in === 'number' ? { in: tally.in } : {}),
      },
    ];
  });
}

function statementOf(subject: SubjectRead, id: string) {
  for (const statements of Object.values(subject.subject.statements)) {
    const match = statements.find((statement) => statement.id === id);
    if (match) return match;
  }
}

function statementLabels(
  release: Definitions,
  statement: SubjectRead['subject']['statements'][string][number],
  locale: string,
) {
  const labels: Record<string, ReturnType<typeof pickText>> = {};
  for (const snak of [
    statement,
    ...statement.qualifiers,
    ...statement.references.flatMap((reference) => reference.parts),
  ]) {
    const property = release.properties[snak.property.id];
    if (property) labels[snak.property.id] = pickText(property.labels, locale);
  }
  return labels;
}

async function readDetail(
  client: KernelClient,
  release: Definitions,
  locale: string,
  selection: GraphSelection | undefined,
  headers: Record<string, string>,
  cost: ExploreCost,
): Promise<{ detail: GraphDetail | null; session?: string | undefined }> {
  if (!selection) return { detail: null };
  const id = selection.kind === 'node' ? selection.id : selection.from;
  const result = await client.subjects({ id }).get({ headers });
  recordCall(cost, `GET /v1/subjects/${id}`, 1, result.data ?? null);
  if (result.status !== 200 || !result.data) return { detail: null };
  const statement = selection.kind === 'edge' ? statementOf(result.data, selection.statement) : undefined;
  const session = tokenOf(result);
  return {
    detail: {
      subject: result.data,
      ...(statement ? { statement, labels: statementLabels(release, statement, locale) } : { labels: {} }),
    },
    ...(session ? { session } : {}),
  };
}

function expansionPage(
  node: string,
  property: string,
  direction: GraphEdgeDirection,
  page: NativeRelations | NativeLinks,
): GraphPage {
  if ('relations' in page) {
    return {
      nodes: page.relations.flatMap((row) =>
        row.summary
          ? [
              {
                id: row.summary.id,
                type: row.summary.type,
                label: row.summary.label?.value ?? '',
                summary: {
                  id: row.summary.id,
                  type: row.summary.type,
                  label: row.summary.label,
                },
              },
            ]
          : [],
      ),
      edges: page.relations.map((row) => ({
        from: node,
        property,
        to: row.summary?.id ?? '',
        statement: row.statement.id,
      })).filter((edge) => edge.to),
      truncated: page.next
        ? [
            {
              node,
              property,
              direction,
              cursor: page.next,
              ...(typeof page.count === 'number'
                ? { count: page.count }
                : page.count && typeof page.count.value === 'number'
                  ? { count: page.count.value }
                  : {}),
            },
          ]
        : [],
    };
  }
  return {
    nodes: page.links.flatMap((row) =>
      row.summary
        ? [
            {
              id: row.subject,
              type: row.summary.type,
              label: row.summary.label?.value ?? '',
              summary: {
                id: row.summary.id,
                type: row.summary.type,
                label: row.summary.label,
              },
            },
          ]
        : [],
    ),
    edges: page.links.map((row) => ({
      from: row.subject,
      property,
      to: node,
      statement: row.statement,
    })),
    truncated: page.next ? [{ node, property, direction, cursor: page.next }] : [],
  };
}

export async function readSubjectGraphPage(
  client: KernelClient,
  authorization: string | undefined,
  release: Definitions,
  id: string,
  locale: string,
  input: {
    property?: string | readonly string[] | undefined;
    direction?: string | undefined;
    depth?: string | number | undefined;
    selection?: GraphSelection | undefined;
    expansion?: GraphTruncation | undefined;
    graph?: GraphPage | undefined;
    session?: string | undefined;
  },
): Promise<GraphRead> {
  const cost = emptyCost();
  try {
    const headers = headersOf(authorization, input.session);
    const current = await client.subjects({ id }).get({ headers });
    recordCall(cost, `GET /v1/subjects/${id}`, 1, current.data ?? null);
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id) return candidateFailure(400);
    const counts = await client.subjects({ id }).counts.get({ headers });
    recordCall(cost, `GET /v1/subjects/${id}/counts`, Object.keys(counts.data && 'properties' in counts.data ? (counts.data.properties ?? {}) : {}).length, counts.data ?? null);
    if (counts.status !== 200 || !counts.data) return candidateFailure(counts.status);
    const counted: NativeCounts = 'content' in counts.data ? counts.data : { content: null };
    const relations = relationOptions(release, current.data.subject.type, locale, counted);
    const requested = graphQueryOf(input);
    const property = requested?.property.filter((id) => relations.some((relation) => relation.id === id)) ?? [];
    const selectedProperty = property.length ? property : relations.slice(0, 1).map((relation) => relation.id);
    const query = {
      property: selectedProperty,
      direction: requested?.direction ?? 'both',
      depth: requested?.depth ?? 1,
    };
    let session = tokenOf(current) ?? tokenOf(counts) ?? input.session;
    let graph: GraphPage = { nodes: [], edges: [], truncated: [] };
    if (selectedProperty.length) {
      const result = await client.subjects({ id }).graph.get({
        query: {
          property: selectedProperty,
          direction: query.direction,
          depth: query.depth,
          limit: GRAPH_LIMIT,
        },
        headers: headersOf(authorization, session),
      });
      recordCall(
        cost,
        `GET /v1/subjects/${id}/graph`,
        result.data && 'nodes' in result.data
          ? result.data.nodes.length + result.data.edges.length
          : 0,
        result.data ?? null,
      );
      if (result.status === 308) return candidateFailure(404);
      if (result.status !== 200 || !result.data || !('nodes' in result.data)) return candidateFailure(result.status);
      graph = asGraph(result.data);
      session = tokenOf(result) ?? session;
    }
    if (input.expansion) {
      const expansion = input.expansion;
      const pageQuery = {
        property: expansion.property,
        language: locale,
        limit: GRAPH_LIMIT,
        cursor: expansion.cursor,
      };
      const expanded =
        expansion.direction === 'out'
          ? await client.subjects({ id: expansion.node }).relations.get({
              query: pageQuery,
              headers: headersOf(authorization, session),
            })
          : await client.subjects({ id: expansion.node }).links.get({
              query: pageQuery,
              headers: headersOf(authorization, session),
            });
      const path =
        expansion.direction === 'out'
          ? `GET /v1/subjects/${expansion.node}/relations`
          : `GET /v1/subjects/${expansion.node}/links`;
      const extra = expanded.data;
      recordCall(
        cost,
        path,
        extra && 'relations' in extra ? extra.relations.length : extra && 'links' in extra ? extra.links.length : 0,
        extra ?? null,
      );
      if (expanded.status !== 200 || !extra || !('relations' in extra || 'links' in extra))
        return candidateFailure(expanded.status);
      graph = mergeGraphPage(
        input.graph ?? graph,
        expansionPage(expansion.node, expansion.property, expansion.direction, extra),
        expansion.node,
      );
      session = tokenOf(expanded) ?? session;
    }
    const requestedSelection = input.selection;
    const selected =
      requestedSelection &&
      (requestedSelection.kind === 'node'
        ? graph.nodes.some((node) => node.id === requestedSelection.id)
        : graph.edges.some((edge) => edge.statement === requestedSelection.statement))
        ? requestedSelection
        : undefined;
    const inspected = await readDetail(client, release, locale, selected, headersOf(authorization, session), cost);
    const retained = { graph, detail: inspected.detail, query };
    cost.bytesRetained = jsonBytes(retained);
    if (cost.bytesRetained > GRAPH_DETAIL_BYTE_CAP + jsonBytes(graph)) return candidateFailure(503);
    const token = inspected.session ?? session;
    return {
      ok: true,
      public: current.data,
      relations,
      query,
      graph,
      detail: inspected.detail,
      cost,
      ...(token ? { session: token } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}

export function replaceExploreSelection(read: Extract<GraphRead, { ok: true }>, selection: GraphSelection | undefined) {
  const detail =
    selection &&
    ((selection.kind === 'node' && read.detail?.subject.subject.id === selection.id) ||
      (selection.kind === 'edge' && read.detail?.statement?.id === selection.statement))
      ? read.detail
      : null;
  return { ...read, detail, cost: { ...read.cost, bytesRetained: jsonBytes({ graph: read.graph, detail, query: read.query }) } };
}
