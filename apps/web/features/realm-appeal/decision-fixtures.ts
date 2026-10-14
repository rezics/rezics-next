import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recordFile from '../../../../tests/qa/fixtures/outcomes/realm/moderation-and-appeal.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ModerationItem, ModerationPage, ModerationDecisionCommand } from '../manage/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';

const record = recordFile as AnswerRecord;
const sample = (label: string) => {
  const found = record.personas.owner.find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded owner/${label}`);
  return found;
};
const queue = sample('moderation-queue-appeal');
export const appealItem = (queue.answer as ModerationPage).items[0]! satisfies ModerationItem;
export const appealRealm = new URL(queue.path, 'https://recorded.invalid').pathname.split('/')[3]!;
export const appealActor = new URL(queue.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
export type DecisionState = 'open' | 'loading' | 'error' | 'pending' | 'denied' | 'stale' | 'lost-response';

// POST decision and follow-up reads are contract-derived, not recorded. Original fixture sanction and statement retain their credit.
export const appealDecisionRequests = { basis: sample('appeal-decision-basis').path, receipt: sample('manager-appeal-open').path,
  decision: '/v1/moderation/decisions', caseId: appealItem.id, actor: appealActor,
  states: [200, 202, 403, 409, 'lost acknowledgement then 200 replay'] };

export function appealDecisionFixture(state: DecisionState) {
  const replay = recordedFetch(record, 'owner', [
    { label: 'appeal-decision-basis', state: 'populated' }, { label: 'manager-appeal-open', state: 'populated' },
  ], { pathPrefix: BFF_PREFIX });
  const writes: ModerationDecisionCommand[] = [];
  let saved: ModerationDecisionCommand | null = null;
  let dropped = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (state === 'loading') return new Promise<Response>(() => {});
    if (request.method === 'GET') {
      if (state === 'error') return Response.json({ type: 'https://rezics.com/problems/governance_unavailable',
        status: 503, title: 'Appeal is temporarily unavailable', code: 'governance_unavailable' }, { status: 503 });
      if (saved) {
        if (url.pathname.endsWith('/appeal')) {
          const reading = sample('manager-appeal-open').answer as { appeal: { statement: string } };
          return Response.json({ ...reading, appeal: { ...reading.appeal, state: 'decided', caseId: appealItem.id,
            outcome: saved.outcome === 'restore' ? 'reversed' : 'dismiss', rationale: saved.disclosure === 'parties' ? saved.rationale : null,
            decidedAt: '2026-10-14T08:00:00.000Z', ...saved.outcome === 'restore' ? { liftedAt: '2026-10-14T08:00:00.000Z' } : {} } });
        }
        return Response.json({ ...(sample('appeal-decision-basis').answer as object), state: 'closed', generation: '1', decisionHead: '00000000-0000-4000-8000-000000000003' });
      }
      return replay.fetcher(request);
    }
    const command = await request.json() as ModerationDecisionCommand;
    if (request.headers.get('idempotency-key') !== command.idempotencyKey) throw new Error('Decision keys disagree');
    writes.push(command);
    if (state === 'denied' || state === 'stale') {
      const status = state === 'denied' ? 403 : 409;
      return Response.json({ type: `https://rezics.com/problems/${state === 'denied' ? 'governance_denied' : 'stale_case'}`,
        status, code: state === 'denied' ? 'governance_denied' : 'stale_case',
        title: state === 'denied' ? 'Member management permission is required' : 'Case changed since review' }, { status });
    }
    if (state !== 'pending') saved = command;
    if (state === 'lost-response' && !dropped) { dropped = true; throw new Error('Lost acknowledgement after the decision'); }
    return Response.json({ profile: 'moderation-decision-v1', decisionId: '00000000-0000-4000-8000-000000000003',
      caseId: command.caseId, caseGeneration: '1', outcome: command.outcome, replayed: dropped, enforcement: [],
      operation: { operationId: 'sanction-resolution', status: state === 'pending' ? 'accepted' : 'completed',
        items: [], continuation: state === 'pending' ? 'sanction-resolution' : null } }, { status: state === 'pending' ? 202 : 200 });
  }) as typeof fetch;
  return { writes, client: browserMainApi('https://recorded.invalid', { fetcher }), dispose: replay.dispose };
}
