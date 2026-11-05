import { createKernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { candidateFixture } from './subject-candidates';
import type { FakeRoute } from '../fake-modules';
import {
  decideProviderCandidate,
  providerRowKey,
  type ProviderDecision,
  type ProviderDecisionResult,
} from '../../features/import-review/provider-review-actions';
import type { ProviderQueuePage, ProviderQueueRead } from '../../features/import-review/provider-queue';
import type { ProviderReviewTransport } from '../../features/import-review/provider-review-actions-view';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import definitions from '../recorded/definitions-release.json';

export type ProviderReviewScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'unavailable'
  | 'partial'
  | 'success'
  | 'scope-change';

/** Declared queue samples for stories only. No fake review-candidates or successful runtime mutation is registered. */
export function providerReviewFixture(scenario: ProviderReviewScenario = 'ready', locale = 'en') {
  const fixture = candidateFixture('ready', locale);
  const label = pickText(fixture.publicRead.subject.labels, locale).text;
  const page: ProviderQueuePage = {
    scope: { source: 'wikidata', context: fixture.publicRead.subject.context, status: 'unreviewed' },
    sourceLabel: 'Wikidata',
    contextLabel: 'Global',
    statusLabel: m.candidate_unresolved({}, { locale: locale as never }),
    rows: Array.from({ length: scenario === 'partial' ? 5 : 2 }, (_, index) => {
      const candidate = structuredClone(fixture.candidate);
      candidate.id = `${candidate.id.slice(0, -3)}9${String(index).padStart(2, '0')}`;
      candidate.statement.id = candidate.id;
      candidate.head = index ? index + 3 : null;
      return {
        subject: fixture.id,
        candidate,
        label,
        href: subjectHref({ id: fixture.id, label }, locale).href,
        propertyLabel: pickText(definitions.release.properties['schema:datePublished'].labels, locale).text,
        related: fixture.publicRead.related,
        operations: ['subject.accept_candidate', 'subject.reject_candidate'],
        reading: { ok: true as const, current: fixture.publicRead },
      };
    }),
  };
  const calls: ProviderDecision[] = [];
  const results = new Map<string, ProviderDecisionResult>();
  const seen = new Map<string, number>();
  const client = createKernelClient('https://provider-story.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const candidate = new URL(request.url).pathname.split('/').at(-1)!.split(':')[0]!;
      const row = page.rows.find((entry) => entry.candidate.id === candidate)!;
      const count = seen.get(candidate) ?? 0;
      seen.set(candidate, count + 1);
      const index = page.rows.indexOf(row);
      const status =
        scenario === 'partial' && (count === 0 || index === 1 || index === 2) ? [200, 409, 403, 429, 503][index]! : 200;
      const body = (await request.json()) as { context: string };
      const decision = request.url.endsWith(':reject') ? 'reject' : 'accept';
      return new Response(
        JSON.stringify(
          status === 200
            ? { acceptance: { context: body.context, candidate, decision, head: 8 }, revision: 9 }
            : { code: status === 409 ? 'stale_editorial_head' : 'unavailable' },
        ),
        { status, headers: { 'content-type': 'application/json', 'rezics-session-token': 'story-session' } },
      );
    }) as typeof fetch,
  });
  const result: ProviderQueueRead | { ok: false; reason: 'loading' } =
    scenario === 'loading'
      ? { ok: false, reason: 'loading' }
      : scenario === 'denied' || scenario === 'invalid' || scenario === 'unavailable'
        ? { ok: false, reason: scenario }
        : { ok: true, page: { ...page, rows: scenario === 'empty' ? [] : page.rows } };
  const transport: ProviderReviewTransport = {
    confirm: async (command) => {
      calls.push(structuredClone(command));
      const next = await decideProviderCandidate(client, 'Bearer story-viewer', command);
      const row = page.rows.find((row) => row.candidate.id === command.candidate)!;
      results.set(providerRowKey(row), next);
      return next;
    },
    refresh: async () => ({
      queue: { ok: true, page: { ...page, rows: page.rows.filter((row) => !results.get(providerRowKey(row))?.ok) } },
      readings: [{ subject: fixture.id, result: { ok: true, current: fixture.publicRead } }],
    }),
  };
  return { page, result, transport, calls };
}

export const routes: FakeRoute[] = [];
