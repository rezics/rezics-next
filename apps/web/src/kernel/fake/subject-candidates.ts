import { createKernelClient, type SubjectRead } from '@rezics/client';
import {
  candidateContext,
  readCandidates,
  selectCandidate,
  type Candidate,
  type CandidateCommand,
  type CandidateRead,
} from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { FakeRoute } from '../fake-modules';
import recording from '../recorded/subject.json';
import definitions from '../recorded/definitions-release.json';
import { pickText } from '@rezics/composition';

export const candidateProperty = 'schema:datePublished';
export type CandidateScenario = 'ready' | 'pending' | 'stale' | 'denied' | 'unavailable';

/** A small native-shaped fake for the review region; it changes public facts only after adoption. */
export function candidateFixture(scenario: CandidateScenario = 'ready', locale = 'en') {
  const publicRead = structuredClone(recording) as unknown as SubjectRead;
  const id = publicRead.subject.id;
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
      property: { id: candidateProperty, data_type: 'time' },
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
    { id: candidateProperty, label: pickText(definitions.release.properties[candidateProperty].labels, locale).text },
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
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${id}`) return json(publicRead);
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${id}/candidates`) {
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      return json({ candidates: [candidate], adoption: { mode: 'replace', head: adoptionHead }, next: null });
    }
    if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
    if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
    if (scenario === 'stale') return json({ code: 'stale_editorial_head' }, 409);
    if (key && receipts.has(key)) return json(receipts.get(key));
    if (request.method === 'POST' && url.pathname === `/v1/subjects/${id}/candidates/${candidate.id}:accept`) {
      if (body?.expected_head !== candidate.head) return json({ code: 'stale_editorial_head' }, 409);
      candidate.decision = 'accepted';
      candidate.head = (candidate.head ?? 0) + 1;
      const result = {
        acceptance: { context: candidateContext, candidate: candidate.id, decision: 'accept', head: candidate.head },
        revision: 3,
      };
      if (key) receipts.set(key, result);
      return json(result);
    }
    if (request.method === 'POST' && url.pathname === `/v1/subjects/${id}:adopt`) {
      if (candidate.decision !== 'accepted' || body?.expected_head !== adoptionHead)
        return json({ code: 'conflict' }, 409);
      adoptionHead++;
      if (scenario !== 'pending')
        publicRead.subject.statements[candidateProperty] = [structuredClone(candidate.statement)];
      const result = {
        adoption: {
          context: candidateContext,
          property: candidateProperty,
          mode: 'replace',
          selection: body.selection,
          head: adoptionHead,
        },
        revision: 4,
      };
      if (key) receipts.set(key, result);
      return json(result);
    }
    return json({ code: 'not_found' }, 404);
  }) as typeof fetch;
  const client = createKernelClient('https://candidate.test', { fetch: fetcher });
  const transport: CandidateTransport = {
    read: async (property, cursor): Promise<CandidateRead> => {
      const result = await readCandidates(client, 'Bearer fixture', id, property, cursor);
      return result.ok ? { ...result, fields, names: {} } : result;
    },
    confirm: (command: CandidateCommand) => selectCandidate(client, 'Bearer fixture', command),
  };
  return { id, candidate, client, publicRead, transport, calls };
}

// Component and page stories use isolated instances; this module adds no global route override.
export const routes: FakeRoute[] = [];
