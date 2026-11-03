import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { candidateContext } from '../../subject/candidates';
import {
  producerHistoryLabels,
  producerHistoryStreams,
  readProducerHistory,
  type ProducerHistoryRead,
  type ProducerHistoryRow,
} from '../../features/catalogue/producer-history';
import type { ProducerHistoryTransport } from '../../features/pages/producer-history';
import definitions from '../recorded/definitions-release.json';

export const producerStudioId = '00000000-0000-4000-8000-00000000e101';
export const producerParentId = '00000000-0000-4000-8000-00000000e102';
export const producerSimilarId = '00000000-0000-4000-8000-00000000e103';
export type ProducerHistoryScenario = 'current' | 'partial' | 'empty' | 'denied' | 'unavailable' | 'concealed';

function relationProperty(
  id: string,
  label: string,
  inverse: string,
  inverseLabel: string,
): PropertyDefinition {
  const labels = { en: label, ja: label };
  return {
    iri: `http://www.wikidata.org/prop/direct/${id.slice(4)}`,
    value: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    labels,
    descriptions: { en: label },
    datatype: 'wikibase-item',
    targets: ['schema:Organization'],
    mappings: [],
    qualifiers: [],
    multivalued: true,
    relation: {
      group: 'derivation',
      order: 'name',
      inverse,
      inverseLabels: { en: inverseLabel, ja: inverseLabel },
    },
  };
}

export function admitProducerHistory(release: Release) {
  const properties: Record<string, PropertyDefinition> = {
    'wdt:P749': relationProperty('wdt:P749', 'parent organization', 'rezics:hasSubsidiary', 'has subsidiary'),
    'wdt:P1365': relationProperty('wdt:P1365', 'replaces', 'rezics:replacedBy', 'replaced by'),
    'wdt:P1366': relationProperty('wdt:P1366', 'replaced by', 'rezics:replaces', 'replaces'),
  };
  Object.assign(release.properties, properties);
  const type = release.types['schema:Organization'];
  if (type) {
    for (const id of Object.keys(properties)) if (!type.properties.includes(id)) type.properties.push(id);
  }
  return release;
}

/** Typed HTTP seam for bounded producer history; no native authority. */
export function producerHistoryFixture(scenario: ProducerHistoryScenario = 'current', locale = 'en') {
  const release = admitProducerHistory(structuredClone(definitions.release) as Release);
  const calls: { path: string; method: string; query: Record<string, string>; authorization: string | null; session: string | null }[] =
    [];
  const subject = (id: string, labels: Record<string, string>): SubjectRead => ({
    subject: {
      id,
      type: 'schema:Organization',
      revision: 1,
      release: definitions.digest,
      context: candidateContext,
      labels,
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  });
  const studio = subject(producerStudioId, { en: 'Lantern Studio', ja: '灯籠スタジオ' });
  const parent = subject(producerParentId, { en: 'Lantern Studio', ja: '灯籠' });
  const similar = subject(producerSimilarId, { en: 'Lantern Studio Inc', ja: '灯籠スタジオ株式会社' });
  const statement = (id: string, target: string) => ({
    id,
    rank: 'normal' as const,
    property: { id: 'wdt:P749', data_type: 'wikibase-item' as const },
    value: { type: 'value' as const, content: target },
    qualifiers: [
      { property: { id: 'schema:startDate', data_type: 'time' as const }, value: { type: 'value' as const, content: '1999' } },
    ],
    references: [
      {
        hash: 'parent-source',
        parts: [{ property: { id: 'schema:url', data_type: 'url' as const }, value: { type: 'value' as const, content: 'https://example.org/history' } }],
      },
    ],
    rezics: { release: definitions.digest, revision: 1 },
  });
  const parentStatement = statement('00000000-0000-4000-8000-00000000e201', producerParentId);
  const similarStatement = statement('00000000-0000-4000-8000-00000000e202', producerSimilarId);
  studio.subject.statements['wdt:P749'] = [parentStatement, similarStatement];
  studio.related = {
    [producerParentId]: { type: 'schema:Organization', labels: parent.subject.labels },
    [producerSimilarId]: { type: 'schema:Organization', labels: similar.subject.labels },
  };
  const summary = (read: SubjectRead) => ({
    id: read.subject.id,
    type: read.subject.type,
    types: [read.subject.type],
    label: { value: read.subject.labels.en ?? '', language: 'en' },
    creativeWork: false,
    cover: null,
  });
  function rows(): ProducerHistoryRow[] {
    if (scenario === 'empty') return [];
    return [
      {
        holder: producerStudioId,
        statementId: parentStatement.id,
        ...(scenario === 'concealed' ? {} : { statement: parentStatement }),
        summary: summary(parent),
        related: studio.related,
      },
      {
        holder: producerStudioId,
        statementId: similarStatement.id,
        statement: similarStatement,
        summary: summary(similar),
        related: studio.related,
      },
    ];
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'producer-session' },
    });
  const client = createKernelClient('https://producer.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        method: request.method,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${producerStudioId}`) return json(studio);
      const freshness = { consistency: 'eventual', target_seconds: 10, caught_up: scenario !== 'partial' };
      if (url.pathname.endsWith('/relations')) {
        const second = url.searchParams.get('cursor') === 'native-next';
        const page = second ? [rows()[1]!] : scenario === 'partial' ? [rows()[0]!] : rows();
        return json({
          relations: page.map((row) => ({
            statement: row.statement ?? parentStatement,
            summary: row.summary,
            related: {
              [producerParentId]: { ...summary(parent), type: parent.subject.type, types: [parent.subject.type] },
              [producerSimilarId]: { ...summary(similar), type: similar.subject.type, types: [similar.subject.type] },
            },
          })),
          next: scenario === 'partial' && !second ? 'native-next' : null,
          count: { value: 2, exact: scenario !== 'partial' },
          freshness,
        });
      }
      if (url.pathname.endsWith('/links')) {
        return json({
          links: [
            {
              subject: producerSimilarId,
              property: url.searchParams.get('property'),
              statement: similarStatement.id,
              assertion: similarStatement,
              summary: summary(similar),
              related: { [producerStudioId]: { ...summary(studio), type: studio.subject.type, types: [studio.subject.type] } },
            },
          ],
          next: null,
          freshness: { ...freshness, caught_up: true },
        });
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const transport: ProducerHistoryTransport = {
    read: (stream, cursor, session) =>
      readProducerHistory(client, 'Bearer contributor', release, producerStudioId, locale, stream, cursor, session),
    relation: () => ({
      read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      propose: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      confirm: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    }),
  };
  function snapshot(): ProducerHistoryRead {
    if (scenario === 'denied' || scenario === 'unavailable') return { ok: false, reason: scenario };
    const streams = producerHistoryStreams(release, 'schema:Organization', locale);
    const listed = rows();
    return {
      ok: true,
      public: studio,
      streams,
      unreleased: [],
      stream: streams[0],
      rows: listed,
      labels: producerHistoryLabels(release, listed, locale),
      next: scenario === 'partial' ? 'native-next' : null,
      count: { value: 2, exact: scenario !== 'partial' },
      caughtUp: scenario !== 'partial',
      session: 'producer-session',
    };
  }
  return { id: producerStudioId, release, studio, parent, similar, client, calls, transport, snapshot, search: async () => [] };
}
