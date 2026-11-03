import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import { candidateContext, candidateFailure, type CandidateFailure } from '../../subject/candidates';
import {
  relationDraft,
  validRelationSlot,
  type RelationDraft,
  type RelationSlot,
} from '../../subject/relation-candidates';

type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
export type PartStream = {
  key: string;
  property: string;
  direction: 'forward' | 'inverse';
  label: { text: string; lang: string | null };
  positionEditable: boolean;
  slotKey?: string;
};
export type PartRow = {
  holder: string;
  statementId: string;
  statement?: ForwardPage['relations'][number]['statement'];
  summary: ForwardPage['relations'][number]['summary'];
  related: SubjectRead['related'];
};
type PartLabels = Record<string, ReturnType<typeof pickText>>;
export type WorkPartsRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      streams: PartStream[];
      stream?: PartStream;
      rows: PartRow[];
      labels: PartLabels;
      next: string | null;
      count?: ForwardPage['count'];
      caughtUp: boolean;
      session?: string;
      episodeCreate?: boolean;
    };

// These are existing canonical part relations, not their display-only inverse aliases.
const contained = new Set(['bf:hasPart', 'rezics:storyArc']);
const belongs = new Set(['schema:isPartOf', 'wdt:P179', 'wdt:P1433', 'wdt:P361']);

/** Project only properties present in this bounded page from the definitions already loaded. */
export function partLabels(release: Definitions, rows: PartRow[], locale: string): PartLabels {
  const labels: PartLabels = {};
  for (const row of rows) {
    if (!row.statement) continue;
    for (const snak of [
      row.statement,
      ...row.statement.qualifiers,
      ...row.statement.references.flatMap((reference) => reference.parts),
    ]) {
      const property = release.properties[snak.property.id];
      if (property) labels[snak.property.id] = pickText(property.labels, locale);
    }
  }
  return labels;
}

function isType(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

/** Directions, admission and editable order come from the current emitted definitions. */
export function partStreams(release: Definitions, type: string, locale: string): PartStream[] {
  return Object.entries(release.properties).flatMap(([id, property]) => {
    const relation = property.relation;
    if (!relation || relation.group !== 'membership' || property.datatype !== 'wikibase-item') return [];
    const forward = contained.has(id) && release.types[type]?.properties.includes(id);
    const inverse =
      belongs.has(id) &&
      relation.inverse &&
      relation.inverse !== 'none' &&
      property.targets?.some((target) => isType(release, type, target));
    if (!forward && !inverse) return [];
    return [
      {
        key: `${forward ? 'forward' : 'inverse'}:${id}`,
        property: id,
        direction: forward ? ('forward' as const) : ('inverse' as const),
        label: pickText(forward ? property.labels : (relation.inverseLabels ?? {}), locale),
        positionEditable:
          relation.order === 'position' &&
          property.qualifiers.includes('schema:position') &&
          release.properties['schema:position']?.datatype === 'string',
        ...(relation.slotKey ? { slotKey: relation.slotKey } : {}),
      },
    ];
  });
}

export function partSlot(stream: PartStream, statement: RelationDraft): RelationSlot | undefined {
  const key = stream.slotKey && statement.qualifiers.find((part) => part.property.id === stream.slotKey);
  const external = statement.qualifiers.find((part) => part.property.id === 'schema:sameAs');
  const slot: RelationSlot = {
    property: statement.property.id,
    ...(statement.value.type === 'value' && typeof statement.value.content === 'string'
      ? { target: statement.value.content }
      : statement.value.type === 'somevalue' &&
          external?.value.type === 'value' &&
          typeof external.value.content === 'string'
        ? { sameAs: external.value.content }
        : {}),
    ...(key && key.value.type === 'value' && typeof key.value.content === 'string' ? { key: key.value.content } : {}),
  };
  return slot.property === stream.property && validRelationSlot(slot) ? slot : undefined;
}

function seriesEpisodeCreate(release: Definitions, type: string): boolean {
  const property = release.properties['schema:isPartOf'];
  return (
    isType(release, type, 'schema:TVSeries') &&
    !!release.types['schema:Episode']?.properties.includes('schema:isPartOf') &&
    !!property?.relation &&
    !!property.targets?.some((target) => target === type || isType(release, type, target))
  );
}

/** Clone the complete assertion; no row index, sorting or qualifier reconstruction supplies order. */
export function partCorrection(row: PartRow, stream: PartStream) {
  if (!row.statement) return;
  const statement = relationDraft(row.statement);
  const slot = partSlot(stream, statement);
  return slot ? { id: row.holder, statement, slot, positionEditable: stream.positionEditable } : undefined;
}

export async function readWorkParts(
  client: KernelClient,
  authorization: string,
  release: Definitions | Promise<Definitions>,
  id: string,
  locale: string,
  streamKey?: string,
  cursor?: string,
  session?: string,
): Promise<WorkPartsRead> {
  try {
    const headers = { authorization, ...(session ? { 'rezics-session-token': session } : {}) };
    const [current, definitions] = await Promise.all([client.subjects({ id }).get({ headers }), release]);
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id || current.data.subject.context !== candidateContext)
      return candidateFailure(400);
    const streams = partStreams(definitions, current.data.subject.type, locale);
    const stream = streamKey ? streams.find((item) => item.key === streamKey) : streams[0];
    if ((streamKey && !stream) || (cursor && !streamKey)) return candidateFailure(400);
    const episodeCreate = seriesEpisodeCreate(definitions, current.data.subject.type);
    if (!stream)
      return {
        ok: true,
        public: current.data,
        streams,
        rows: [],
        labels: {},
        next: null,
        caughtUp: true,
        episodeCreate,
      };
    const query = {
      property: stream.property,
      context: candidateContext,
      language: locale,
      limit: 20,
      ...(cursor ? { cursor } : {}),
    };
    const result =
      stream.direction === 'forward'
        ? await client.subjects({ id }).relations.get({ query, headers })
        : await client.subjects({ id }).links.get({ query, headers });
    if (result.status !== 200 || !result.data) return candidateFailure(result.status);
    const page = result.data;
    const related = (values: ForwardPage['relations'][number]['related']): SubjectRead['related'] =>
      Object.fromEntries(
        Object.entries(values ?? {}).map(([key, summary]) => [
          key,
          {
            type: summary.type,
            labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
          },
        ]),
      );
    const rows: PartRow[] =
      'relations' in page
        ? page.relations.map((row) => ({
            holder: id,
            statementId: row.statement.id,
            statement: row.statement,
            summary: row.summary,
            related: related(row.related),
          }))
        : page.links.map((row) => ({
            holder: row.subject,
            statementId: row.statement,
            ...(row.assertion ? { statement: row.assertion } : {}),
            summary: row.summary,
            related: related(row.related),
          }));
    const token = new Headers(result.headers).get('rezics-session-token');
    return {
      ok: true,
      public: current.data,
      streams,
      stream,
      rows,
      labels: partLabels(definitions, rows, locale),
      next: page.next,
      ...(page.count ? { count: page.count } : {}),
      caughtUp: page.freshness.caught_up,
      ...(token ? { session: token } : {}),
      episodeCreate,
    };
  } catch {
    return candidateFailure(503);
  }
}
