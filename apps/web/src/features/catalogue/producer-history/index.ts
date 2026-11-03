import type { KernelClient, SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { candidateContext, candidateFailure, type CandidateFailure } from '../../../subject/candidates';
import {
  relationDraft,
  validRelationSlot,
  type RelationDraft,
  type RelationSlot,
} from '../../../subject/relation-candidates';

export const producerHistoryRequested = {
  parent: 'wdt:P749',
  predecessor: 'wdt:P1365',
  successor: 'wdt:P1366',
} as const;

export type ProducerHistoryMeaning = 'parent' | 'predecessor' | 'successor' | 'subsidiary' | 'credited-role';
export type ProducerHistoryStream = {
  key: string;
  property: string;
  direction: 'forward' | 'inverse';
  meaning: ProducerHistoryMeaning;
  label: { text: string; lang: string | null };
  requested: boolean;
};
export type ProducerHistoryRow = {
  holder: string;
  statementId: string;
  statement?: ForwardPage['relations'][number]['statement'];
  summary: ForwardPage['relations'][number]['summary'];
  related: SubjectRead['related'];
};
type Definitions = Pick<Release, 'types' | 'properties'>;
type Endpoint = ReturnType<KernelClient['subjects']>;
type ForwardPage = NonNullable<Awaited<ReturnType<Endpoint['relations']['get']>>['data']>;
export type ProducerHistoryRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      streams: ProducerHistoryStream[];
      unreleased: { id: string; meaning: Exclude<ProducerHistoryMeaning, 'subsidiary' | 'credited-role'> }[];
      stream?: ProducerHistoryStream;
      rows: ProducerHistoryRow[];
      labels: Record<string, ReturnType<typeof pickText>>;
      next: string | null;
      count?: ForwardPage['count'];
      caughtUp: boolean;
      session?: string;
    };

function isType(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => isType(release, base, target, seen));
}

export function producerOrganizationType(release: Definitions, type: string): boolean {
  return isType(release, type, 'schema:Organization');
}

function organizationTarget(release: Definitions, property: string): boolean {
  return (
    release.properties[property]?.targets?.some(
      (target) => target === 'schema:Organization' || isType(release, target, 'schema:Organization'),
    ) === true
  );
}

function meaningFor(id: string, direction: 'forward' | 'inverse'): ProducerHistoryMeaning {
  if (id === producerHistoryRequested.parent) return direction === 'inverse' ? 'subsidiary' : 'parent';
  if (id === producerHistoryRequested.predecessor) return direction === 'inverse' ? 'successor' : 'predecessor';
  if (id === producerHistoryRequested.successor) return direction === 'inverse' ? 'predecessor' : 'successor';
  return 'credited-role';
}

/** Bind exact released descriptors; requested Wikidata IDs stay configuration until admitted. */
export function producerHistoryStreams(release: Definitions, type: string, locale: string): ProducerHistoryStream[] {
  if (!producerOrganizationType(release, type)) return [];
  const streams: ProducerHistoryStream[] = [];
  const seen = new Set<string>();
  const push = (stream: ProducerHistoryStream) => {
    if (seen.has(stream.key)) return;
    seen.add(stream.key);
    streams.push(stream);
  };
  for (const [meaning, id] of Object.entries(producerHistoryRequested) as [
    Exclude<ProducerHistoryMeaning, 'subsidiary' | 'credited-role'>,
    string,
  ][]) {
    const property = release.properties[id];
    const relation = property?.relation;
    if (!property || property.datatype !== 'wikibase-item' || !relation || !organizationTarget(release, id)) continue;
    if (release.types[type]?.properties.includes(id)) {
      push({
        key: `forward:${id}`,
        property: id,
        direction: 'forward',
        meaning,
        label: pickText(property.labels, locale),
        requested: true,
      });
    }
    if (relation.inverse && relation.inverse !== 'none' && organizationTarget(release, id)) {
      const rangeMatch = property.targets?.some((target) => isType(release, type, target));
      if (rangeMatch) {
        push({
          key: `inverse:${id}`,
          property: id,
          direction: 'inverse',
          meaning: meaningFor(id, 'inverse'),
          label: pickText(relation.inverseLabels ?? {}, locale),
          requested: true,
        });
      }
    }
  }
  for (const [id, property] of Object.entries(release.properties)) {
    const relation = property.relation;
    if (
      !relation ||
      relation.group !== 'credit' ||
      property.datatype !== 'wikibase-item' ||
      !organizationTarget(release, id)
    )
      continue;
    if (release.types[type]?.properties.includes(id)) {
      push({
        key: `forward:${id}`,
        property: id,
        direction: 'forward',
        meaning: 'credited-role',
        label: pickText(property.labels, locale),
        requested: false,
      });
    }
  }
  return streams;
}

export function producerHistoryUnreleased(release: Definitions, type: string) {
  if (!producerOrganizationType(release, type)) return [];
  return (Object.entries(producerHistoryRequested) as [Exclude<ProducerHistoryMeaning, 'subsidiary' | 'credited-role'>, string][])
    .filter(([, id]) => {
      const property = release.properties[id];
      const admitted =
        !!property &&
        property.datatype === 'wikibase-item' &&
        !!property.relation &&
        organizationTarget(release, id) &&
        (release.types[type]?.properties.includes(id) ||
          property.targets?.some((target) => isType(release, type, target)));
      return !admitted;
    })
    .map(([meaning, id]) => ({ id, meaning }));
}

export function producerHistoryLabels(
  release: Definitions,
  rows: ProducerHistoryRow[],
  locale: string,
): Record<string, ReturnType<typeof pickText>> {
  const labels: Record<string, ReturnType<typeof pickText>> = {};
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

export function producerHistorySlot(stream: ProducerHistoryStream, statement: RelationDraft): RelationSlot | undefined {
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
  };
  return slot.property === stream.property && validRelationSlot(slot) ? slot : undefined;
}

export function producerHistoryCorrection(row: ProducerHistoryRow, stream: ProducerHistoryStream) {
  if (!row.statement) return;
  const statement = relationDraft(row.statement);
  const slot = producerHistorySlot(stream, statement);
  return slot ? { id: row.holder, statement, slot, positionEditable: false as const } : undefined;
}

function relatedMap(values: ForwardPage['relations'][number]['related']): SubjectRead['related'] {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, summary]) => [
      key,
      {
        type: summary.type,
        labels: summary.label ? { [summary.label.language]: summary.label.value } : {},
      },
    ]),
  );
}

export async function readProducerHistory(
  client: KernelClient,
  authorization: string,
  release: Definitions | Promise<Definitions>,
  id: string,
  locale: string,
  streamKey?: string,
  cursor?: string,
  session?: string,
): Promise<ProducerHistoryRead> {
  try {
    const headers = { authorization, ...(session ? { 'rezics-session-token': session } : {}) };
    const [current, definitions] = await Promise.all([client.subjects({ id }).get({ headers }), release]);
    if (current.status !== 200 || !current.data) return candidateFailure(current.status);
    if (current.data.subject.id !== id || current.data.subject.context !== candidateContext)
      return candidateFailure(400);
    if (!producerOrganizationType(definitions, current.data.subject.type)) return candidateFailure(400);
    const streams = producerHistoryStreams(definitions, current.data.subject.type, locale);
    const unreleased = producerHistoryUnreleased(definitions, current.data.subject.type);
    const stream = streamKey ? streams.find((item) => item.key === streamKey) : streams[0];
    if ((streamKey && !stream) || (cursor && !streamKey)) return candidateFailure(400);
    if (!stream)
      return {
        ok: true,
        public: current.data,
        streams,
        unreleased,
        rows: [],
        labels: {},
        next: null,
        caughtUp: true,
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
    const rows: ProducerHistoryRow[] =
      'relations' in page
        ? page.relations.map((row) => ({
            holder: id,
            statementId: row.statement.id,
            statement: row.statement,
            summary: row.summary,
            related: relatedMap(row.related),
          }))
        : page.links.map((row) => ({
            holder: row.subject,
            statementId: row.statement,
            ...(row.assertion ? { statement: row.assertion } : {}),
            summary: row.summary,
            related: relatedMap(row.related),
          }));
    const token = new Headers(result.headers).get('rezics-session-token');
    return {
      ok: true,
      public: current.data,
      streams,
      unreleased,
      stream,
      rows,
      labels: producerHistoryLabels(definitions, rows, locale),
      next: page.next,
      ...(page.count ? { count: page.count } : {}),
      caughtUp: page.freshness.caught_up,
      ...(token ? { session: token } : {}),
    };
  } catch {
    return candidateFailure(503);
  }
}
