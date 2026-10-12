import { describe, expect, test } from 'bun:test';
import { decideReport, decideSubmission, decisionStatus } from '../features/manage/commands.ts';
import { basisFor, queue, realm, acting } from '../features/manage/fixtures.ts';
import { commonActions, initialTriage, targetIds, triage, visibleIds, type Decision } from '../features/manage/queue-state.ts';
import { decisionReceipt, isolatedAttemptStorage as isolatedStorage, recoveryReasons } from '../features/manage/recovery-fixtures.ts';
import { performCommand, readCommand, readReportAttempt, reportAttempts, type CommandAttempt } from '../features/manage/safety-pending.ts';
import type { MainClient } from '../features/manage/types.ts';

const reasons = recoveryReasons;
const report = queue.find(item => item.kind === 'content_report')!;
const receipt = decisionReceipt;
describe('one recoverable Realm decision', () => {
  for (const action of ['remove', 'interim-restrict', 'final-restrict'] as const) {
    test(`${action}: a lost response and changed live basis replay the original request after reload`, async () => {
      const store = isolatedStorage();
      const item = { ...report, kind: action === 'remove' ? 'content_report' as const : 'rights_complaint' as const };
      const decision: Decision = { action, reason: reasons.facts, note: null, reasons };
      let basisReads = 0;
      const calls: { body: unknown; options: unknown }[] = [];
      const post = async (body: unknown, options: unknown) => {
        // The request must already be recoverable before the network call starts.
        expect(body).toEqual(readReportAttempt(realm, acting.iri, item.id, store)?.input);
        calls.push({ body, options });
        if (calls.length === 1) throw new Error('receipt lost after commit');
        expect(calls[1]).toEqual(calls[0]);
        return { data: receipt(item, 'completed'), error: null };
      };
      const main = { v1: { realms: () => ({ moderation: () => ({ get: async () => {
        basisReads++;
        return { data: { ...basisFor(item), generation: String(basisReads) }, error: null };
      } }) }), moderation: { decisions: { post } }, rights: { restrictions: { post } } } } as unknown as MainClient;
      expect(await decideReport(main, realm, item, decision, acting.iri, 'original-key', store))
        .toEqual({ ok: false, failure: 'unavailable' });
      expect(reportAttempts(realm, acting.iri, store)).toHaveLength(1);
      expect(reportAttempts(realm, 'another-actor', store)).toEqual([]);
      expect(reportAttempts('another-realm', acting.iri, store)).toEqual([]);
      // A new mounted consumer has a different key, rationale and generation: none may replace the committed intent.
      expect(await decideReport(main, realm, { ...item, generation: '99' }, { ...decision, details: 'changed' },
        acting.iri, 'new-key', store)).toMatchObject({ ok: true, data: { replayed: true } });
      expect(basisReads).toBe(1);
      expect(calls).toHaveLength(2);
      expect((calls[0]!.body as { profile: string }).profile)
        .toBe(action === 'remove' ? 'moderation-decision-v1' : 'rights-restriction-v1');
      expect(reportAttempts(realm, acting.iri, store)).toEqual([]);
    });
  }

  test('a deferred receipt remains pending, including a later denied replay', async () => {
    const store = isolatedStorage();
    let calls = 0;
    const main = { v1: { realms: () => ({ moderation: () => ({ get: async () => ({ data: basisFor(report), error: null }) }) }),
      moderation: { decisions: { post: async () => ++calls === 1 ? { data: receipt(report, 'accepted'), error: null }
        : { data: null, error: { status: 403, value: { code: 'denied' } } } } } } } as unknown as MainClient;
    await decideReport(main, realm, report, { action: 'remove', reason: null, note: null, reasons }, acting.iri, 'key', store);
    expect(readReportAttempt(realm, acting.iri, report.id, store)?.status).toBe('pending');
    await decideReport(main, realm, report, { action: 'remove', reason: null, note: null, reasons }, acting.iri, 'key', store);
    expect(readReportAttempt(realm, acting.iri, report.id, store)?.status).toBe('pending');
  });

  test('an authoritative stale refusal permits a new basis; unavailable storage prevents dispatch', async () => {
    const store = isolatedStorage();
    let reads = 0;
    let sends = 0;
    const main = { v1: { realms: () => ({ moderation: () => ({ get: async () => {
      reads++; return { data: basisFor(report), error: null };
    } }) }), moderation: { decisions: { post: async () => {
      sends++; return { data: null, error: { status: 409, value: { code: 'stale_case' } } };
    } } } } } as unknown as MainClient;
    const decision: Decision = { action: 'remove', reason: null, note: null, reasons };
    await decideReport(main, realm, report, decision, acting.iri, 'first', store);
    expect(readReportAttempt(realm, acting.iri, report.id, store)).toBeNull();
    await decideReport(main, realm, report, decision, acting.iri, 'second', store);
    expect(reads).toBe(2);
    const unavailable = { ...isolatedStorage(), setItem: () => { throw new Error('storage full'); } };
    expect(await decideReport(main, realm, report, decision, acting.iri, 'third', unavailable))
      .toEqual({ ok: false, failure: 'unavailable' });
    expect(sends).toBe(2);
  });

  test('only typed receipt statuses confirm completion', () => {
    expect(decisionStatus({ saved: true })).toBeNull();
    expect(decisionStatus(receipt(report, 'accepted'))).toBe('accepted');
    expect(decisionStatus(receipt(report, 'partial'))).toBe('partial');
    expect(decisionStatus(receipt(report, 'completed'))).toBe('completed');
  });

  test('pending and recorded requests stay visible across refresh but cannot be decided or dismissed', () => {
    let state = triage(initialTriage([]), { type: 'recover', items: [{ item: report, status: 'pending' }] });
    state = triage(state, { type: 'load', items: [] });
    expect(visibleIds(state)).toEqual([report.id]);
    expect(targetIds(state)).toEqual([]);
    expect(commonActions(state, [report.id]).size).toBe(0);
    expect(triage(state, { type: 'dismiss', id: report.id })).toBe(state);
    state = triage(state, { type: 'settle', id: report.id, outcome: { kind: 'done' } });
    expect(visibleIds(state)).toEqual([]);
  });
});

for (const operation of ['role:assignment', 'role:definition', 'settings']) {
  test(`${operation}: retry retains body, key, actor and Realm until its receipt is recovered`, async () => {
    const store = isolatedStorage();
    const original = { realm, actingSubject: acting.iri, key: 'first-key', status: 'recorded' as const,
      input: { expectedGeneration: '12', reason: 'Original intent', payload: ['original'] } };
    const calls: CommandAttempt<typeof original.input>[] = [];
    const dispatch = async (attempt: CommandAttempt<typeof original.input>) => {
      expect(readCommand(realm, acting.iri, operation, store)?.key).toBe('first-key');
      calls.push({ ...attempt, uncertain: undefined });
      return calls.length === 1 ? { ok: false as const, failure: 'unavailable' as const }
        : { ok: true as const, data: { receiptId: 'original-receipt', replayed: true } };
    };
    await performCommand(operation, original, dispatch, store);
    expect(await performCommand(operation, { ...original, key: 'different-key', input: {
      expectedGeneration: '99', reason: 'Changed reason', payload: ['different'] } }, dispatch, store))
      .toEqual({ ok: true, data: { receiptId: 'original-receipt', replayed: true } });
    expect(calls[1]).toEqual(calls[0]);
    expect(readCommand(realm, acting.iri, operation, store)).toBeNull();
  });
}

test('submission acceptance also retains its selection basis after a lost response', async () => {
  const store = isolatedStorage();
  const item = queue.find(entry => entry.kind === 'work_submission')!;
  let basisReads = 0;
  const requests: unknown[] = [];
  const main = { v1: { realms: () => ({
    'submitted-publications': { get: async () => {
      basisReads++; return { data: { items: [], nextCursor: null }, error: null };
    } },
    submissions: () => ({ decisions: { post: async (input: unknown, options: unknown) => {
      requests.push({ input, options });
      if (requests.length === 1) throw new Error('receipt lost');
      return { data: { replayed: true }, error: null };
    } } }),
  }) } } as unknown as MainClient;
  const decision: Decision = { action: 'approve', reason: null, note: null };
  await decideSubmission(main, realm, item, decision, acting.iri, 'accept-key', store);
  await decideSubmission(main, realm, { ...item, generation: '99' }, decision, acting.iri, 'new-key', store);
  expect(basisReads).toBe(1);
  expect(requests[1]).toEqual(requests[0]);
});

test('an access refusal after a lost decision response does not erase the committed intent', async () => {
  const store = isolatedStorage();
  let sends = 0;
  const main = { v1: { realms: () => ({ moderation: () => ({ get: async () => ({ data: basisFor(report), error: null }) }) }),
    moderation: { decisions: { post: async () => {
      sends++;
      if (sends === 1) throw new Error('receipt lost after commit');
      if (sends === 2) return { data: null, error: { status: 403, value: { code: 'denied' } } };
      return { data: receipt(report, 'completed'), error: null };
    } } } } } as unknown as MainClient;
  const decision: Decision = { action: 'remove', reason: null, note: null, reasons };
  await decideReport(main, realm, report, decision, acting.iri, 'original', store);
  await decideReport(main, realm, report, decision, acting.iri, 'different', store);
  expect(readReportAttempt(realm, acting.iri, report.id, store)?.key).toBe('original');
  await decideReport(main, realm, report, decision, acting.iri, 'third', store);
  expect(readReportAttempt(realm, acting.iri, report.id, store)).toBeNull();
});

test('reload during an in-flight dispatch retains uncertainty before any response handler runs', async () => {
  const store = isolatedStorage();
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const answer = new Promise<{ data: ReturnType<typeof receipt>; error: null }>(resolve => {
    finish = () => resolve({ data: receipt(report, 'completed'), error: null });
  });
  const firstMain = { v1: { realms: () => ({ moderation: () => ({ get: async () => ({ data: basisFor(report), error: null }) }) }),
    moderation: { decisions: { post: () => { started(); return answer; } } } } } as unknown as MainClient;
  const decision: Decision = { action: 'remove', reason: null, note: null, reasons };
  const first = decideReport(firstMain, realm, report, decision, acting.iri, 'in-flight-key', store);
  await dispatched;
  expect(readReportAttempt(realm, acting.iri, report.id, store)?.uncertain).toBe(true);
  const afterReload = { v1: { moderation: { decisions: { post: async () => ({ data: null,
    error: { status: 403, value: { code: 'denied' } } }) } } } } as unknown as MainClient;
  await decideReport(afterReload, realm, report, decision, acting.iri, 'new-key', store);
  expect(readReportAttempt(realm, acting.iri, report.id, store)?.key).toBe('in-flight-key');
  finish();
  await first;
  expect(readReportAttempt(realm, acting.iri, report.id, store)).toBeNull();
});
