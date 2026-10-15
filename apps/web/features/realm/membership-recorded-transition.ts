import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedSample } from './realm-membership-recorded-page.ts';

export interface MembershipReplayPhase {
  selections: readonly RecordedSelection[];
  /** Advance only once this exact recorded response has completed. */
  advanceOn?: string;
}

/** Membership commands repeat reads at the same address. Each phase still uses
 * the strict recorded transport; neither a receipt nor call count invents a read. */
export function membershipRecordedTransition(record: AnswerRecord, persona: AnswerPersona,
  phases: readonly MembershipReplayPhase[], locale = 'en') {
  if (!phases.length) throw new Error('Membership replay needs a phase');
  for (const [index, selected] of phases.entries()) {
    if (selected.advanceOn && (index + 1 === phases.length || !selected.selections.some(item => item.label === selected.advanceOn))) {
      throw new Error(`Membership phase has no recorded continuation: ${selected.advanceOn}`);
    }
  }
  const playbacks = phases.map(phase => recordedFetch(record, persona, phase.selections, { pathPrefix: BFF_PREFIX, locale }));
  let phase = 0;
  const calls: { method: string; path: string; body: unknown; key: string | null; credentials: RequestCredentials }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.clone() : new URL(String(input), 'https://recorded.invalid'), init);
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${BFF_PREFIX}/`) ? url.pathname.slice(BFF_PREFIX.length) + url.search : url.pathname + url.search;
    const wire = await request.clone().text();
    const body: unknown = wire ? JSON.parse(wire) : undefined;
    calls.push({ method: request.method, path, body, key: request.headers.get('idempotency-key'), credentials: init?.credentials ?? (input instanceof Request ? input.credentials : 'same-origin') });
    const current = phase;
    const response = await playbacks[current]!.fetcher(request);
    const trigger = phases[current]!.advanceOn;
    if (trigger && current === phase) {
      const sample = recordedSample(record, persona, trigger);
      const expected = new URL(sample.path, url);
      const actual = new URL(path, url);
      expected.searchParams.sort(); actual.searchParams.sort();
      if ([200, 201, 204].includes(response.status) && request.method === sample.method && expected.pathname + expected.search === actual.pathname + actual.search) {
        phase++;
      }
    }
    return response;
  }) as typeof fetch;
  return { fetcher, calls, phase: () => phase, dispose: () => playbacks.forEach(playback => playback.dispose()) };
}
