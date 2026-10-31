import { createKernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { candidateFixture } from './subject-candidates';
import definitions from '../recorded/definitions-release.json';
import { readProviderDecisionSubjects } from '../../features/import-review/provider-review-actions';
import {
  globalReviewContext,
  readProviderQueue,
  prepareProviderQueue,
  decideProviderCandidate,
  type QueueScope,
  type QueueState,
  type QueueTransport,
} from '../../features/import-review/provider-queue';

export type ProviderQueueScenario =
  | 'loaded'
  | 'comparison'
  | 'preparing'
  | 'empty'
  | 'denied'
  | 'unavailable'
  | 'invalid'
  | 'loading'
  | 'deleted'
  | 'deleted-more'
  | 'mixed'
  | 'empty-more'
  | 'empty-lagging';
/** Isolated stories use the existing native candidate recording and the real generated-client transport. */
export function providerQueueFixture(scenario: ProviderQueueScenario = 'loaded') {
  const native = candidateFixture();
  const suggestions = [native.candidate];
  if (scenario === 'comparison') {
    native.candidate.statement.qualifiers = [
      structuredClone(native.publicRead.subject.statements['schema:author']![0]!),
    ];
    const language = structuredClone(native.candidate);
    language.id = `${native.id.slice(0, -3)}887`;
    language.statement.id = language.id;
    language.statement.property = { id: 'schema:inLanguage', data_type: 'string' };
    language.statement.value = { type: 'value', content: 'de' };
    language.statement.qualifiers = [];
    if (language.source && 'source' in language.source) {
      language.source.record_revision = '2026-10-31';
      language.source.converter_revision = 'wikidata-2';
    }
    suggestions.push(language);
    const english = structuredClone(native.publicRead.subject.statements['schema:inLanguage']![0]!);
    english.id = `${native.id.slice(0, -3)}886`;
    english.value = { type: 'value', content: 'en' };
    native.publicRead.subject.statements['schema:inLanguage']!.push(english);
  }
  const scope: QueueScope = { source: 'wikidata', context: globalReviewContext, status: 'pending' };
  const names = Object.fromEntries(
    Object.entries(definitions.release.properties).map(([id, value]) => [id, value.labels]),
  );
  const page = {
    candidates: suggestions.map((candidate) => ({ subject: native.id, candidate, adoption: null })),
    next: null,
    freshness: { consistency: 'eventual' as const, target_seconds: 10 as const, caught_up: true },
  };
  const deleted = {
    subject: native.id,
    candidate: { id: `${native.id.slice(0, -3)}889`, deleted: true },
    adoption: null,
  };
  const next = 'opaque+/continuation==';
  const calls: {
    path: string;
    method: string;
    body: unknown;
    authorization: string | null;
    session: string | null;
    key: string | null;
  }[] = [];
  let current = scenario;
  let readingStatus = 200;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
        'rezics-session-token': 'queue-session',
      },
    });
  const fetcher = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body: unknown = request.method === 'POST' ? await request.clone().json() : undefined;
    calls.push({
      path: url.pathname + url.search,
      method: request.method,
      body,
      authorization: request.headers.get('authorization'),
      session: request.headers.get('rezics-session-token'),
      key: request.headers.get('idempotency-key'),
    });
    if (url.pathname === '/v1/review-candidates:prepare') {
      current = 'preparing';
      return json({ preparing: true }, 202);
    }
    if (url.pathname === `/v1/subjects/${native.id}` && request.method === 'GET')
      return readingStatus === 200 ? json(native.publicRead) : json({ code: 'unavailable' }, readingStatus);
    const decision = suggestions.find(
      (candidate) =>
        url.pathname === `/v1/subjects/${native.id}/candidates/${candidate.id}:accept` ||
        url.pathname === `/v1/subjects/${native.id}/candidates/${candidate.id}:reject`,
    );
    if (scenario === 'comparison' && request.method === 'POST' && decision) {
      const command = body as { context: string; expected_head: number | null };
      if (command.expected_head !== decision.head) return json({ code: 'stale_editorial_head' }, 409);
      return json({
        acceptance: {
          context: command.context,
          candidate: decision.id,
          decision: url.pathname.endsWith(':accept') ? 'accept' : 'reject',
          head: (decision.head ?? 0) + 1,
        },
        revision: 3,
      });
    }
    if (url.pathname !== '/v1/review-candidates') return native.fetcher(request);
    if (current === 'denied') return json({ code: 'forbidden' }, 403);
    if (current === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
    if (current === 'invalid') return json({ code: 'invalid_request' }, 400);
    if (current === 'preparing') {
      current = 'loaded';
      return json({ next: 'opaque-continuation' }, 202);
    }
    if (current === 'empty') return json({ ...page, candidates: [] });
    if (current === 'empty-more') return json({ ...page, candidates: [], next });
    if (current === 'empty-lagging')
      return json({ ...page, candidates: [], freshness: { ...page.freshness, caught_up: false } });
    if (current === 'deleted') return json({ ...page, candidates: [deleted] });
    if (current === 'deleted-more' && !url.searchParams.has('cursor'))
      return json({ ...page, candidates: [deleted], next });
    const candidates = suggestions.map((original) => {
      const candidate = structuredClone(original);
      if (url.searchParams.get('status') === 'accepted_unselected') {
        candidate.decision = 'accepted';
        candidate.head = 1;
      }
      return { subject: native.id, candidate, adoption: null };
    });
    return json({
      ...page,
      candidates: current === 'mixed' ? [deleted, ...candidates] : candidates,
      next: current === 'mixed' ? next : null,
    });
  }) as typeof fetch;
  const client = createKernelClient('https://queue.test', { fetch: fetcher });
  const transport: QueueTransport = {
    read: (scope, cursor, session) =>
      readProviderQueue(
        client,
        'Bearer fixture',
        Promise.resolve(definitions.release as unknown as Release),
        scope,
        cursor,
        session,
      ),
    prepare: (scope) => prepareProviderQueue(client, 'Bearer fixture', scope),
    decide: (command) => decideProviderCandidate(client, 'Bearer fixture', command),
    readings: (commands) => readProviderDecisionSubjects(client, 'Bearer fixture', commands),
  };
  const initial: QueueState =
    scenario === 'loaded' || scenario === 'comparison' || scenario === 'empty'
      ? {
          state: 'ready',
          page: scenario === 'empty' ? { ...page, candidates: [] } : page,
          names,
          readings:
            scenario === 'empty' ? [] : [{ subject: native.id, result: { ok: true, current: native.publicRead } }],
        }
      : scenario === 'deleted' ||
          scenario === 'deleted-more' ||
          scenario === 'mixed' ||
          scenario === 'empty-more' ||
          scenario === 'empty-lagging'
        ? { state: 'idle' }
        : { state: scenario };
  return {
    scope,
    initial,
    transport,
    calls,
    native,
    client,
    deleted,
    next,
    suggestions,
    setReadingStatus: (status: number) => {
      readingStatus = status;
    },
    setScenario: (scenario: ProviderQueueScenario) => {
      current = scenario;
    },
  };
}
