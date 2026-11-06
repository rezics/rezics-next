import { createKernelClient, type SubjectRead } from '@rezics/client';
import { DATA_TYPES } from '@rezics/definitions';
import {
  candidateContext,
  readCandidates,
  selectCandidate,
  type Candidate,
  type CandidateCommand,
  type CandidateRead,
  type CandidateViewerActions,
} from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { FakeRoute } from '../fake-modules';
import recording from '../recorded/subject.json';
import definitions from '../recorded/definitions-release.json';
import { pickText } from '@rezics/composition';

export const candidateProperty = 'schema:datePublished';
export type CandidateScenario =
  | 'ready'
  | 'pending'
  | 'stale'
  | 'denied'
  | 'unavailable'
  | 'multiple'
  | 'stale-selection'
  | 'empty'
  | 'loading'
  | 'invalid'
  | 'actions-denied'
  | 'actions-unavailable'
  | 'concealed'
  | 'malformed-ack';

export function fixtureCandidateViewerActions(scenario: CandidateScenario = 'ready'): CandidateViewerActions {
  if (scenario === 'actions-unavailable')
    return {
      subject: { state: 'unavailable', reason: 'unavailable' },
      context: { state: 'unavailable', reason: 'unavailable' },
    };
  return {
    subject:
      scenario === 'concealed' ? { state: 'unavailable', reason: 'not-found' } : { state: 'available', actions: [] },
    context: {
      state: 'available',
      actions:
        scenario === 'actions-denied'
          ? [{ action: 'context:accept', operations: ['subject.accept_candidate', 'subject.reject_candidate'] }]
          : [
              { action: 'context:accept', operations: ['subject.accept_candidate', 'subject.reject_candidate'] },
              { action: 'context:adopt', operations: ['subject.adopt'] },
            ],
    },
  };
}

/** A small native-shaped fake for the review region; it changes public facts only after adoption. */
export function candidateFixture(
  scenario: CandidateScenario = 'ready',
  locale = 'en',
  field: keyof typeof definitions.release.properties = candidateProperty,
) {
  const publicRead = structuredClone(recording) as unknown as SubjectRead;
  const id = publicRead.subject.id;
  const multiple = scenario === 'multiple' || scenario === 'stale-selection';
  const property = multiple ? 'schema:inLanguage' : field;
  const definition = definitions.release.properties[property];
  const datatype = DATA_TYPES.find((type) => type === definition.datatype);
  if (!datatype) throw new Error('Invalid candidate fixture datatype');
  const candidate: Candidate = {
    id: `${id.slice(0, -3)}888`,
    release: publicRead.subject.release,
    revision: 2,
    source: {
      source: 'wikidata',
      external_id: 'Q25338',
      record_revision: '2026-10-30',
      converter_revision: 'wikidata-1',
      digest: 'a'.repeat(64),
      field_group: 'facts',
    },
    retracted: null,
    retraction: null,
    decision: null,
    head: null,
    rank: null,
    statement: {
      id: `${id.slice(0, -3)}888`,
      rank: 'normal',
      property: { id: property, data_type: datatype },
      value: {
        type: 'value',
        content: { time: '+1946-04-06T00:00:00Z', precision: 11, calendar: 'http://www.wikidata.org/entity/Q1985727' },
      },
      qualifiers: [],
      references: [
        {
          hash: 'source',
          parts: [
            {
              property: { id: 'schema:url', data_type: 'url' },
              value: { type: 'value', content: 'https://www.wikidata.org/wiki/Q25338' },
            },
          ],
        },
      ],
      rezics: { release: publicRead.subject.release, revision: 2 },
    },
  };
  const candidates = [candidate];
  if (multiple) {
    candidate.decision = 'accepted';
    candidate.head = 2;
    candidate.statement.property = { id: property, data_type: 'string' };
    candidate.statement.value = { type: 'value', content: 'de' };
    publicRead.subject.statements[property] = ['en', 'fr'].map((language, index) => {
      const selected = structuredClone(candidate);
      selected.id = `${id.slice(0, -3)}88${index}`;
      selected.statement.id = selected.id;
      selected.statement.value = { type: 'value', content: language };
      selected.rank = 'normal';
      candidates.push(selected);
      return structuredClone(selected.statement);
    });
  }
  Object.assign(publicRead.subject, {
    sourceRecords: [
      {
        name: 'Wikidata',
        url: 'https://www.wikidata.org/wiki/Q25338',
        licence: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
        attribution: 'Wikidata contributors',
      },
    ],
  });
  const fields = [
    {
      id: property,
      label: pickText(definition.labels, locale).text,
      multivalued: definition.multivalued,
    },
  ];
  const calls: {
    method: string;
    path: string;
    authorization: string | null;
    session: string | null;
    body: unknown;
    key: string | null;
  }[] = [];
  let adoptionHead = 1;
  let staleSelection = scenario === 'stale-selection';
  const receipts = new Map<string, unknown>();
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        'rezics-session-token': 'candidate-session',
      },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : null;
    const key = request.headers.get('idempotency-key');
    calls.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      session: request.headers.get('rezics-session-token'),
      body,
      key,
    });
    if (request.method === 'POST' && url.pathname === '/v1/viewerActions') {
      if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
      if (scenario === 'actions-unavailable') return json({ code: 'dependency_unavailable' }, 503);
      const resources = body?.resources as { type: string; id: string }[];
      const actionComponents = fixtureCandidateViewerActions(scenario);
      return json({
        resources: resources.map((resource) => {
          if (scenario === 'concealed' && resource.type === 'semantic.subject')
            return { ...resource, error: 'not_found' };
          const component = resource.type === 'semantic.context' ? actionComponents.context : actionComponents.subject;
          return { ...resource, viewerActions: component.state === 'available' ? component.actions : [] };
        }),
      });
    }
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${id}` && url.searchParams.has('selectedSynopsis'))
      return json({
        ...publicRead,
        selectedSynopsis: fakeSelectedSynopsis(publicRead.subject, url.searchParams.get('selectedSynopsis')),
      });
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${id}`) return json(publicRead);
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${id}/candidates`) {
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      const continued = url.searchParams.has('cursor');
      return json({
        candidates:
          scenario === 'empty'
            ? []
            : multiple
              ? continued
                ? candidates.slice(2)
                : candidates.slice(0, 2)
              : candidates,
        adoption: { mode: 'replace', head: adoptionHead },
        next: multiple && !continued ? 'next-visible' : null,
      });
    }
    if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
    if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
    if (scenario === 'stale') return json({ code: 'stale_editorial_head' }, 409);
    if (scenario === 'invalid') return json({ code: 'invalid_request' }, 400);
    if (key && receipts.has(key)) return json(receipts.get(key));
    const decided = candidates.find(
      (item) =>
        url.pathname === `/v1/subjects/${id}/candidates/${item.id}:accept` ||
        url.pathname === `/v1/subjects/${id}/candidates/${item.id}:reject`,
    );
    if (request.method === 'POST' && decided) {
      const candidate = decided;
      const rejecting = url.pathname.endsWith(':reject');
      if (body?.expected_head !== candidate.head) return json({ code: 'stale_editorial_head' }, 409);
      candidate.decision = rejecting ? 'rejected' : 'accepted';
      if (rejecting) {
        for (const statement of publicRead.subject.statements[property] ?? [])
          if (statement.id === candidate.id) statement.rank = 'deprecated';
        candidate.rank = candidate.rank ? 'deprecated' : null;
      }
      candidate.head = (candidate.head ?? 0) + 1;
      const result = {
        acceptance: {
          context: candidateContext,
          candidate: candidate.id,
          decision: rejecting ? 'reject' : 'accept',
          head: candidate.head,
        },
        revision: 3,
      };
      if (key) receipts.set(key, result);
      return json(result);
    }
    if (request.method === 'POST' && url.pathname === `/v1/subjects/${id}:adopt`) {
      if (body?.property !== property) return json({ code: 'invalid_request' }, 400);
      if (staleSelection) {
        staleSelection = false;
        adoptionHead++;
        return json({ code: 'stale_editorial_head' }, 409);
      }
      if (body?.expected_head !== adoptionHead) return json({ code: 'stale_editorial_head' }, 409);
      const selection = body?.selection as { candidate: string; rank: 'normal' | 'preferred' }[];
      const previous = publicRead.subject.statements[property] ?? [];
      if (
        !Array.isArray(selection) ||
        selection.length > (definition.multivalued ? 32 : 1) ||
        new Set(selection.map((entry) => entry.candidate)).size !== selection.length ||
        selection.some((entry) => entry.rank !== 'normal' && entry.rank !== 'preferred')
      )
        return json({ code: 'invalid_request' }, 400);
      const statements = selection.flatMap((entry) => {
        const item = candidates.find((item) => item.id === entry.candidate);
        if (item && (item.decision !== 'accepted' || item.retracted !== null)) return [];
        const statement =
          item?.statement ??
          previous.find((statement) => statement.id === entry.candidate && statement.rank !== 'deprecated');
        return statement ? [{ ...structuredClone(statement), rank: entry.rank }] : [];
      });
      if (statements.length !== selection.length) return json({ code: 'invalid_request' }, 400);
      adoptionHead++;
      if (scenario !== 'pending') {
        publicRead.subject.statements[property] = statements;
        for (const item of candidates) item.rank = selection.find((entry) => entry.candidate === item.id)?.rank ?? null;
      }
      const result = {
        adoption: {
          context: candidateContext,
          property,
          mode: 'replace',
          selection: body.selection,
          head: adoptionHead,
        },
        revision: 4,
      };
      if (key) receipts.set(key, result);
      if (scenario === 'malformed-ack') return json({ ...result, adoption: { ...result.adoption, mode: 'suppress' } });
      return json(result);
    }
    return json({ code: 'not_found' }, 404);
  }) as typeof fetch;
  const client = createKernelClient('https://candidate.test', { fetch: fetcher });
  const transport: CandidateTransport = {
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: async (property, cursor, session): Promise<CandidateRead> => {
      const result = await readCandidates(client, 'Bearer fixture', id, property, cursor, undefined, session);
      return result.ok ? { ...result, fields, names: {}, actions: fixtureCandidateViewerActions(scenario) } : result;
    },
    confirm: (command: CandidateCommand) => selectCandidate(client, 'Bearer fixture', command),
  };
  return { id, property, candidate, candidates, client, publicRead, transport, calls, fetcher };
}

/** Released selectedSynopsis answer for a Global slot: the statement must match its exact document operands. */
function fakeSelectedSynopsis(subject: unknown, query: string | null): unknown {
  const current = subject as { context: string; release: string; statements: Record<string, FakeSnakRow[]> };
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(query ?? '') as Record<string, unknown>;
  } catch {
    return { kind: 'unsupported' };
  }
  if (input.context !== current.context) return { kind: 'unsupported' };
  if (input.release !== current.release) return { kind: 'changed' };
  const rows = current.statements['schema:abstract'] ?? [];
  const rank = rows.some((row) => row.rank === 'preferred') ? 'preferred' : 'normal';
  const found = rows.find((row) => {
    const content = row.value.content as Record<string, unknown> | undefined;
    return (
      row.id === input.statement &&
      row.rank === rank &&
      row.property.data_type === 'document' &&
      row.value.type === 'value' &&
      content?.document === input.document &&
      content?.digest === input.digest &&
      content?.language === input.language
    );
  });
  if (!found) return { kind: 'changed' };
  const { rezics: _revision, ...plain } = found;
  const redact = (snak: FakeSnakRow) =>
    snak.property.data_type === 'document' || snak.property.data_type === 'media'
      ? { ...snak, value: { type: 'somevalue' } }
      : snak;
  return {
    kind: 'matched',
    fact: {
      ...redact(plain),
      qualifiers: plain.qualifiers.map(redact),
      references: plain.references.map((reference) => ({ ...reference, parts: reference.parts.map(redact) })),
    },
    context: current.context,
    release: current.release,
  };
}

type FakeSnakRow = {
  id: string;
  rank: string;
  property: { id: string; data_type: string };
  value: { type: string; content?: unknown };
  qualifiers: FakeSnakRow[];
  references: { hash: string; parts: FakeSnakRow[] }[];
  rezics?: unknown;
};

// Component and page stories use isolated instances; this module adds no global route override.
export const routes: FakeRoute[] = [];
