import { createKernelClient, type SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { candidateContext, type Candidate } from '../../subject/candidates';
import { relationDescriptorReader } from './relation-descriptor';
import {
  confirmRelation,
  proposeRelation,
  readRelationEditor,
  type RelationStatementInput,
} from '../../subject/relation-candidates';
import {
  partLabels,
  partStreams,
  readWorkParts,
  type WorkPartsRead,
  type PartRow,
} from '../../features/catalogue/work-parts';
import type { WorkPartsTransport } from '../../features/catalogue/work-parts-page';
import recording from '../recorded/subject.json';
import type { FakeRoute } from '../fake-modules';

export type WorkPartsScenario =
  | 'current'
  | 'partial'
  | 'empty'
  | 'denied'
  | 'stale'
  | 'unavailable'
  | 'no-position'
  | 'missing-assertion'
  | 'uncertain'
  | 'pending';
export const workPartsId = '00000000-0000-4000-8000-000000000801';
export const workPartId = '00000000-0000-4000-8000-000000000802';
const otherPart = '00000000-0000-4000-8000-000000000803';
const candidateId = '00000000-0000-4000-8000-000000000804';

/** Typed HTTP seam only: these fixtures exercise the same emitted definitions and native client as the page. */
export function workPartsFixture(initialScenario: WorkPartsScenario = 'current', locale = 'en') {
  let scenario = initialScenario;
  const noPosition = scenario === 'no-position';
  const property = noPosition ? 'schema:isPartOf' : 'wdt:P179';
  const release = bundledRelease;
  const anchor: SubjectRead = structuredClone({
    ...recording,
    summary: null,
    subject: {
      ...recording.subject,
      id: workPartsId,
      type: noPosition ? 'schema:TVSeries' : 'schema:BookSeries',
      context: candidateContext,
      labels: { en: 'The Traveller', ja: '旅人' },
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
  });
  const snak = (id: string, value: string, datatype: Candidate['statement']['property']['data_type'] = 'string') => ({
    property: { id, data_type: datatype },
    value: { type: 'value' as const, content: value },
  });
  const original: Candidate['statement'] = {
    ...snak(property, workPartsId, 'wikibase-item'),
    id: '00000000-0000-4000-8000-000000000805',
    rank: 'normal',
    qualifiers: noPosition ? [] : [snak('schema:position', '2')],
    references: [{ hash: 'original', parts: [snak('schema:url', 'https://example.org/contents', 'url')] }],
    rezics: { release: anchor.subject.release, revision: 1 },
  };
  const holder: SubjectRead = {
    ...structuredClone(anchor),
    subject: {
      ...structuredClone(anchor.subject),
      id: workPartId,
      type: noPosition ? 'schema:Episode' : 'schema:Book',
      labels: { en: 'Volume Two' },
      statements: { [property]: [structuredClone(original)] },
    },
    related: { [workPartsId]: { type: anchor.subject.type, labels: anchor.subject.labels } },
  };
  let candidate: Candidate | undefined;
  let adoptionHead = 3;
  let lost = false;
  const receipts = new Map<string, unknown>();
  const calls: {
    path: string;
    method: string;
    query: Record<string, string>;
    body: unknown;
    authorization: string | null;
    session: string | null;
    key: string | null;
  }[] = [];
  const summary = (id: string, title: string) => ({
    id,
    type: holder.subject.type,
    types: [holder.subject.type],
    label: { value: title, language: 'en' },
    creativeWork: true,
    cover: null,
  });
  function rows(second = false): PartRow[] {
    if (scenario === 'empty') return [];
    return [
      {
        holder: second ? otherPart : workPartId,
        statementId: holder.subject.statements[property]![0]!.id,
        ...(scenario === 'missing-assertion' ? {} : { statement: holder.subject.statements[property]![0]! }),
        summary: summary(second ? otherPart : workPartId, second ? 'Volume Ten' : 'Volume Two'),
        related: holder.related,
      },
    ];
  }
  function snapshot(): WorkPartsRead {
    if (scenario === 'denied' || scenario === 'stale' || scenario === 'unavailable')
      return { ok: false, reason: scenario };
    const streams = partStreams(release, anchor.subject.type, locale);
    const stream = streams.find((stream) => stream.property === property)!;
    return {
      ok: true,
      public: anchor,
      streams,
      stream,
      rows: rows(),
      labels: partLabels(release, rows(), locale),
      next: scenario === 'partial' ? 'native-next' : null,
      count: { value: scenario === 'partial' ? 2 : rows().length, exact: scenario !== 'partial' },
      caughtUp: scenario !== 'pending',
      session: 'parts-session',
    };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'parts-session' },
    });
  const client = createKernelClient('https://parts.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : undefined;
      const key = request.headers.get('idempotency-key');
      calls.push({
        path: url.pathname,
        method: request.method,
        body,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
        key,
      });
      if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${workPartsId}`) return json(anchor);
      if (request.method === 'GET' && url.pathname === `/v1/subjects/${workPartId}`) return json(holder);
      if (url.pathname.endsWith('/links')) {
        if (url.searchParams.get('property') !== property)
          return json({
            links: [],
            next: null,
            freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
          });
        const second = url.searchParams.get('cursor') === 'native-next';
        return json({
          links: rows(second).map((row) => ({
            subject: row.holder,
            property,
            statement: row.statementId,
            assertion: row.statement,
            related: {
              [workPartsId]: {
                ...summary(workPartsId, anchor.subject.labels.en!),
                type: anchor.subject.type,
                types: [anchor.subject.type],
              },
            },
            summary: row.summary,
            type: holder.subject.type,
            label: row.summary?.label?.value ?? '',
          })),
          next: scenario === 'partial' && !second ? 'native-next' : null,
          count: { value: scenario === 'partial' ? 2 : rows().length, exact: scenario !== 'partial' },
          freshness: { consistency: 'eventual', target_seconds: 10, caught_up: scenario !== 'pending' },
        });
      }
      if (url.pathname.endsWith('/candidates') && request.method === 'GET')
        return json({
          candidates: candidate ? [candidate] : [],
          adoption: { mode: 'replace', head: adoptionHead },
          next: null,
        });
      if (request.method !== 'POST' || !body) return json({ code: 'not_found' }, 404);
      if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
      if (key && receipts.has(key)) return json(receipts.get(key), url.pathname.endsWith('/candidates') ? 201 : 200);
      if (scenario === 'stale') return json({ code: 'stale_editorial_head' }, 409);
      if (url.pathname.endsWith('/candidates')) {
        const statement = body.statement as RelationStatementInput;
        const readSnak = (part: RelationStatementInput['qualifiers'][number]) => ({
          ...part,
          property: { ...part.property, data_type: release.properties[part.property.id]!.datatype },
        });
        candidate = {
          id: candidateId,
          source: null,
          retracted: null,
          retraction: null,
          release: anchor.subject.release,
          revision: 2,
          head: null,
          decision: null,
          rank: null,
          statement: {
            ...readSnak(statement),
            id: candidateId,
            qualifiers: statement.qualifiers.map(readSnak),
            references: statement.references.map(({ parts }) => ({
              hash: 'native-reference',
              parts: parts.map(readSnak),
            })),
            rank: 'normal',
            rezics: { release: anchor.subject.release, revision: 2 },
          },
        };
        const receipt = { candidate: candidateId, revision: 2 };
        if (key) receipts.set(key, receipt);
        if (scenario === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json(receipt, 201);
      }
      if (candidate && url.pathname.endsWith(':accept')) {
        if (body.expected_head !== candidate.head) return json({ code: 'stale_editorial_head' }, 409);
        candidate.head = 1;
        candidate.decision = 'accepted';
        return json({
          acceptance: { context: candidateContext, candidate: candidateId, head: 1, decision: 'accept' },
          revision: 3,
        });
      }
      if (candidate && url.pathname.endsWith(':adopt')) {
        if (candidate.decision !== 'accepted' || body.expected_head !== adoptionHead)
          return json({ code: 'stale_editorial_head' }, 409);
        if (scenario !== 'pending') holder.subject.statements[property] = [structuredClone(candidate.statement)];
        return json({ adoption: { ...body, head: ++adoptionHead }, revision: 4 });
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  const transport: WorkPartsTransport = {
    read: (stream = `inverse:${property}`, cursor, session) =>
      readWorkParts(client, 'Bearer contributor', release, workPartsId, locale, stream, cursor, session),
    relation: (id) => ({
      read: (slot, cursor, session) =>
        readRelationEditor(
          client,
          'Bearer contributor',
          relationDescriptorReader(release),
          id,
          locale,
          slot,
          cursor,
          session,
        ),
      propose: (input) => proposeRelation(client, 'Bearer contributor', relationDescriptorReader(release), input),
      confirm: (input) => confirmRelation(client, 'Bearer contributor', input),
    }),
  };
  const search: EntityPickerSearch = async () => [
    { id: workPartId, title: 'Volume Two', types: [holder.subject.type], typeLabel: 'Book', cover: null },
    { id: workPartsId, title: 'The Traveller', types: [anchor.subject.type], typeLabel: 'Series', cover: null },
  ];
  return {
    id: workPartsId,
    property,
    original,
    anchor,
    holder,
    client,
    release,
    calls,
    receipts,
    transport,
    search,
    snapshot,
    setScenario: (value: WorkPartsScenario) => {
      scenario = value;
    },
  };
}

export const routes: FakeRoute[] = [];
