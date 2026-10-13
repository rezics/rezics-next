import { expect, test } from 'bun:test';
import { commandInstance, commandLane } from './command.ts';
import { commandFailure, send, type Outcome } from '../manage/commands.ts';
import { isolatedAttemptStorage } from '../manage/recovery-fixtures.ts';
import { performCommand, readCommand } from '../manage/safety-pending.ts';
import { initialTriage, triage, visibleIds } from '../manage/queue-state.ts';
import { queue } from '../manage/fixtures.ts';
import { send as sendProposal } from '../proposals/commands.ts';

const pending = { ok: false, failure: 'pending' } as const;
test('HTTP admission and pending bodies cannot become completed commands', async () => {
  expect(commandFailure(202, undefined)).toBe('pending');
  for (const data of [{ receipt: 'not-confirmed' }, { status: 'reconciling', result: null }]) {
    expect(await send(async () => ({ data, error: null, status: 202 }))).toEqual(pending);
  }
  expect(await send(async () => ({ data: { status: 'reconciling' }, error: null }))).toEqual(pending);
  expect(await send(async () => ({ data: { receipt: 'confirmed' }, error: null, status: 200 })))
    .toEqual({ ok: true, data: { receipt: 'confirmed' } });
});

test('proposal admission keeps the action pending instead of reporting it sent', async () => {
  expect(await sendProposal(async () => ({ data: { outcome: 'apply_pending' }, error: null, status: 202 }))).toEqual(pending);
  expect(await sendProposal(async () => ({ data: { outcome: 'apply_pending' }, error: null }))).toEqual(pending);
});

test('receipt consumers retain decision discriminants and require contractual completion', async () => {
  for (const status of ['accepted', 'partial']) {
    const data = { operation: { status, items: [{ state: 'pending', receipt: null }] } };
    const call = async () => ({ data, error: null, status: 202 });
    expect(await send(call)).toEqual(pending);
    expect(await send(call, { receipt: true })).toEqual({ ok: true, data });
  }
  expect(await send(async () => ({ data: { operation: { status: 'completed' } }, error: null, status: 202 }),
    { receipt: true })).toEqual(pending);
  expect(await send(async () => ({ data: { status: 'reconciling' }, error: null, status: 202 }),
    { receipt: true })).toEqual(pending);
  const cancelled = { operation: { status: 'cancelled' } };
  expect(await send(async () => ({ data: cancelled, error: null, status: 202 }), { receipt: true }))
    .toEqual({ ok: true, data: cancelled });
});

test('admitted instances and lanes keep their key through refusals until confirmation', async () => {
  const command = commandInstance();
  const key = command.id();
  command.finish(pending);
  command.finish({ ok: false, failure: 'denied' });
  expect(command.id()).toBe(key);
  command.finish({ ok: true });
  expect(command.id()).not.toBe(key);
  const lane = commandLane<string, Outcome<string>>({ ok: false, failure: 'unavailable' });
  const keys: string[] = [];
  for (const result of [pending, { ok: false, failure: 'denied' } as const, { ok: true, data: 'receipt' } as const]) {
    await lane.submit('same-intent', async (_choice, round) => { keys.push(round.key); return result; });
  }
  expect(new Set(keys).size).toBe(1);
  await lane.submit('same-intent', async (_choice, round) => { expect(round.key).not.toBe(keys[0]); return pending; });
});

test('durable recovery keeps admitted payloads and queue rows after refresh', async () => {
  const store = isolatedAttemptStorage();
  const attempt = { realm: 'realm', actingSubject: 'actor', key: 'same-key', status: 'recorded' as const,
    input: { actingSubject: 'actor', expectedGeneration: '1', reason: 'Update settings', expectedRulesRevision: null,
      settings: { visibility: 'public', reviewRequired: false, whoMaySubmit: 'members', rules: [] } } };
  const keys: string[] = [];
  const dispatch = async (kept: { key: string }): Promise<Outcome<unknown>> => {
    keys.push(kept.key);
    return { ok: true, data: { status: 'reconciling', result: null } };
  };
  expect(await performCommand('settings', attempt, dispatch, store)).toEqual(pending);
  const retained = readCommand<typeof attempt.input>('realm', 'actor', 'settings', store)!;
  expect(retained).toMatchObject({ key: 'same-key', status: 'pending', input: attempt.input });
  expect(await performCommand('settings', retained, async kept => {
    keys.push(kept.key); return { ok: false, failure: 'denied' };
  }, store)).toEqual({ ok: false, failure: 'denied' });
  expect(readCommand('realm', 'actor', 'settings', store)).not.toBeNull();
  expect(keys).toEqual(['same-key', 'same-key']);
  await performCommand('settings', retained, async () => ({ ok: true, data: 'confirmed' }), store);
  expect(readCommand('realm', 'actor', 'settings', store)).toBeNull();
  const item = queue[0]!;
  let state = triage(initialTriage([item]), { type: 'settle', id: item.id, outcome: { kind: 'pending' } });
  state = triage(state, { type: 'load', items: [] });
  state = triage(state, { type: 'dismiss', id: item.id });
  expect(state.settled[item.id]).toEqual({ kind: 'pending' });
  expect(visibleIds(state)).toContain(item.id);
});
