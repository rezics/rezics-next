import type { KernelClient } from '@rezics/client';
import { pickText, type SelectedContext } from '@rezics/composition';
import type { GuideRelease } from '../catalogue/definition-guide';
import { fetchGuideRelease } from '../catalogue/definition-guide';
import { loadSubjectPage, subjectBody, type SubjectPageData } from './subject';
import { isRecord } from './shared';
import type { Section } from './overview';

export const connectionGroups = ['relations', 'characters', 'credits'] as const;
export type ConnectionGroup = (typeof connectionGroups)[number];
export const CONNECTION_LIMIT = 12;
export const CONNECTION_BYTES = 1_048_576;
export type ConnectionStream = {
  key: string;
  property: string;
  direction: 'in' | 'out';
  group: ConnectionGroup;
  label: string;
  forwardLabel: string;
  language: string | null;
  filter?: string;
};
export type ConnectionSelection = { stream: string; cursor?: string };
export type ConnectionAddress = {
  id: string;
  locale: string;
  realm?: string | undefined;
  viewer?: string | undefined;
  context?: string | undefined;
  release?: string | undefined;
  selection?: Partial<Record<ConnectionGroup, ConnectionSelection>> | undefined;
  only?: ConnectionGroup | undefined;
  graph?: { properties: string[]; depth: 1 | 2 } | undefined;
};
export type ConnectionWork = { calls: number; values: number; bytes: number };
export type ConnectionSection = { stream: ConnectionStream; section: Section };
type SubjectEndpoint = ReturnType<KernelClient['subjects']>;
export type ConnectionGraph = NonNullable<Awaited<ReturnType<SubjectEndpoint['graph']['get']>>['data']>;
export type ConnectionVisit =
  | { ok: false; status: number }
  | {
      ok: true;
      id: string;
      release: string;
      context?: SelectedContext;
      streams: ConnectionStream[];
      sections: Partial<Record<ConnectionGroup, ConnectionSection>>;
      graph?: { ok: true; body: ConnectionGraph } | { ok: false; status: number };
    };

/** Metadata, not a catalogue traversal: emitted bases already contain the effective type ancestry. */
export function connectionStreams(release: GuideRelease, type: string, id: string, locale: string): ConnectionStream[] {
  const definition = release.types[type];
  if (!definition) return [];
  const types = new Set([type, ...definition.bases]);
  const forward = new Set(definition.properties);
  const result: ConnectionStream[] = [];
  for (const [property, field] of Object.entries(release.properties)) {
    const relation = field.relation;
    if (!relation || field.datatype !== 'wikibase-item') continue;
    const group: ConnectionGroup =
      relation.group === 'credit' ? 'credits' : relation.group === 'appearance' ? 'characters' : 'relations';
    const add = (direction: 'in' | 'out', filter?: string) => {
      const text = pickText(
        direction === 'in' && !relation.symmetric ? (relation.inverseLabels ?? field.labels) : field.labels,
        locale,
      );
      result.push({
        key: `${direction}:${property}${filter ? ':qualified' : ''}`,
        property,
        direction,
        group,
        label: text.text,
        forwardLabel: pickText(field.labels, locale).text,
        language: text.lang,
        ...(filter ? { filter } : {}),
      });
    };
    if (forward.has(property)) add('out');
    const incoming = field.targets?.some((target) => types.has(target));
    if (incoming && (relation.symmetric || relation.inverse !== 'none')) add('in');
    // A character's cast is qualified on its work, independent of that character's biography and appearances.
    if (
      !incoming &&
      relation.group === 'credit' &&
      field.qualifiers.some((qualifier) => release.properties[qualifier]?.targets?.some((target) => types.has(target)))
    )
      add('in', id);
  }
  return result;
}

function representation(page: SubjectPageData): string {
  return JSON.stringify([page.subject, page.profile, page.context ?? null]);
}

function retained(value: unknown, work: ConnectionWork): boolean {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  work.bytes += bytes;
  return bytes <= CONNECTION_BYTES;
}

/** Actual typed calls are counted here, where responses enter the Web reader. No endpoint is read per row. */
export async function readConnectionStream(
  client: KernelClient,
  address: ConnectionAddress,
  stream: ConnectionStream,
  context: string | undefined,
  authorization: string | undefined,
  cursor: string | undefined,
  work: ConnectionWork,
  signal?: AbortSignal,
): Promise<Section> {
  const query = {
    property: stream.property,
    limit: CONNECTION_LIMIT,
    ...(context ? { context } : {}),
    ...(stream.filter ? { filter: stream.filter } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const options = {
    query,
    fetch: { cache: 'no-store' as const, redirect: 'manual' as const, ...(signal ? { signal } : {}) },
    ...(authorization ? { headers: { authorization } } : {}),
  };
  work.calls++;
  const response =
    stream.direction === 'in'
      ? await client.subjects({ id: address.id }).links.get(options)
      : await client.subjects({ id: address.id }).relations.get(options);
  if (response.status !== 200 || !response.data) return { ok: false, status: response.status };
  const body = response.data as unknown as Record<string, unknown>;
  const rows = body[stream.direction === 'in' ? 'links' : 'relations'];
  if (!Array.isArray(rows)) return { ok: false, status: 503 };
  work.values += rows.length;
  if (rows.length > CONNECTION_LIMIT || !retained(body, work)) return { ok: false, status: 503 };
  return {
    ok: true,
    body,
    read: {
      kind: stream.direction === 'in' ? 'links' : 'relations',
      id: address.id,
      property: stream.property,
      limit: CONNECTION_LIMIT,
      ...(context ? { context } : {}),
      ...(stream.filter ? { filter: stream.filter } : {}),
      ...(cursor ? { cursor } : {}),
    },
  };
}

type ConnectionDependencies = {
  page?: typeof loadSubjectPage;
  release?: typeof fetchGuideRelease;
  observe?: (work: Readonly<ConnectionWork>) => void;
};

/**
 * Cost: two current page aggregates, the existing active/release pair and at most three selected streams.
 * The graph is one explicit native depth-1/2, limit-25 read instead of those streams. It has no Context selector.
 * Native engines and their indexed rows/SQL bounds remain with Semantic; this adapter introduces no query engine.
 */
export async function readConnectionVisit(
  client: KernelClient,
  address: ConnectionAddress,
  authorization?: string,
  signal?: AbortSignal,
  dependencies: ConnectionDependencies = {},
): Promise<ConnectionVisit> {
  const work: ConnectionWork = { calls: 0, values: 0, bytes: 0 };
  const page = dependencies.page ?? loadSubjectPage;
  const releaseRead = dependencies.release ?? fetchGuideRelease;
  const currentPage = async () => {
    work.calls++;
    return page(client, address.id, undefined, address.locale, { realm: address.realm, authorization });
  };
  try {
    const first = await currentPage();
    if (first.kind !== 'page') return { ok: false, status: first.kind === 'missing' ? 404 : 409 };
    const reading = subjectBody(first.page);
    if (!reading) return { ok: false, status: 503 };
    if (address.context !== undefined && address.context !== reading.subject.context) return { ok: false, status: 409 };
    work.calls += 2;
    const release = await releaseRead(client, undefined, authorization ? { authorization } : {});
    if (address.release !== undefined && address.release !== release.digest) return { ok: false, status: 409 };
    const streams = connectionStreams(release, reading.subject.type, address.id, address.locale);
    const sections: Partial<Record<ConnectionGroup, ConnectionSection>> = {};
    let graph: Extract<ConnectionVisit, { ok: true }>['graph'];
    if (address.graph) {
      if (address.realm || first.page.context?.population.kind === 'realm') graph = { ok: false, status: 503 };
      else {
        const properties = address.graph.properties;
        if (properties.some((property) => !streams.some((stream) => stream.property === property)))
          return { ok: false, status: 400 };
        work.calls++;
        const response = await client.subjects({ id: address.id }).graph.get({
          query: { property: properties, direction: 'both', depth: address.graph.depth, limit: 25 },
          fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
          ...(authorization ? { headers: { authorization } } : {}),
        });
        if (response.status === 200 && response.data) {
          const body = response.data;
          work.values += body.nodes.length + body.edges.length + body.truncated.length;
          graph =
            body.nodes.length <= 501 && body.edges.length <= 500 && retained(body, work)
              ? { ok: true, body }
              : { ok: false, status: 503 };
        } else graph = { ok: false, status: response.status };
      }
    } else {
      const requested = address.only ? [address.only] : connectionGroups;
      const results = await Promise.allSettled(
        requested.map(async (group) => {
          const selected = address.selection?.[group];
          const choices = streams.filter((stream) => stream.group === group);
          const counts = (reading.subject as unknown as { relationCounts?: Record<string, number> }).relationCounts;
          const stream = selected
            ? choices.find((stream) => stream.key === selected.stream)
            : (choices.find((stream) => stream.direction === 'out' && (counts?.[stream.property] ?? 0) > 0) ??
              choices[0]);
          if (!stream) {
            if (selected) throw new Error('Unknown connection stream');
            return;
          }
          const section = await readConnectionStream(
            client,
            address,
            stream,
            reading.subject.context,
            authorization,
            selected?.cursor,
            work,
            signal,
          );
          return { group, stream, section };
        }),
      );
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === 'fulfilled' && result.value) {
          const { group, stream, section } = result.value;
          sections[group] = { stream, section };
        } else if (result.status === 'rejected') {
          const group = requested[i]!;
          const stream = streams.find(
            (stream) =>
              stream.group === group &&
              (!address.selection?.[group] || stream.key === address.selection[group]!.stream),
          );
          if (!stream) return { ok: false, status: 400 };
          sections[group] = { stream, section: { ok: false, status: 503 } };
        }
      }
    }
    const final = await currentPage();
    if (final.kind !== 'page' || representation(final.page) !== representation(first.page) || signal?.aborted)
      return { ok: false, status: 409 };
    return {
      ok: true,
      id: address.id,
      release: release.digest,
      ...(first.page.context ? { context: first.page.context } : {}),
      streams,
      sections,
      ...(graph ? { graph } : {}),
    };
  } catch (error) {
    return { ok: false, status: isRecord(error) && typeof error.status === 'number' ? error.status : 503 };
  } finally {
    dependencies.observe?.(Object.freeze({ ...work }));
  }
}
