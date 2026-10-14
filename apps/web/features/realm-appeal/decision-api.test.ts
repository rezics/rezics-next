import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { appealDecisionAuthority, appealDecisionCommand, resolveRealmAppeal } from './decision-api.ts';
import { isolatedAttemptStorage } from '../manage/recovery-fixtures.ts';
import { performCommand, readCommand, retainCommand } from '../manage/safety-pending.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const basis = { caseId: '00000000-0000-4000-8000-000000000002', generation: '7' };
const command = appealDecisionCommand(basis, actor, { outcome: 'restore', rationale: ' Reviewed the statement. ', disclosure: 'parties' }, 'stable-key');

test('a sanction decision uses the exact basis and actor, with no content targets or extra representation', () => {
  expect(command).toMatchObject({ caseId: basis.caseId, expectedGeneration: '7', actingSubject: actor,
    targets: [], outcome: 'restore', rationale: 'Reviewed the statement.', disclosure: 'parties',
    reversesDecisionId: null, answersStepId: null, idempotencyKey: 'stable-key' });
  expect(appealDecisionAuthority([])).toEqual({ dismiss: false, restore: false });
  expect(appealDecisionAuthority(['platform-admin'])).toEqual({ dismiss: false, restore: false });
  expect(appealDecisionAuthority(['governance.moderate'])).toEqual({ dismiss: true, restore: false });
  expect(appealDecisionAuthority(['governance.moderate', 'realm.members.manage'])).toEqual({ dismiss: true, restore: true });
});

function client(status: number, data: unknown, inspect?: (request: Request) => Promise<void>) {
  return browserMainApi('https://contract.invalid', { fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    await inspect?.(request);
    return Response.json(data, { status });
  }) as typeof fetch });
}
const receipt = { profile: 'moderation-decision-v1', decisionId: '00000000-0000-4000-8000-000000000003',
  caseId: basis.caseId, caseGeneration: '8', outcome: 'restore', enforcement: [], replayed: false,
  operation: { operationId: 'sanction-resolution', status: 'completed' as const, items: [], continuation: null } };

test('completion uses the real receipt, and retry sends the same body key and header key', async () => {
  const inspect = async (request: Request) => {
    expect(request.url).toEndWith('/v1/moderation/decisions');
    expect(request.headers.get('idempotency-key')).toBe(command.idempotencyKey);
    expect(await request.json()).toEqual(command);
  };
  expect(await resolveRealmAppeal(client(200, receipt, inspect), command)).toEqual({ ok: true, data: receipt });
  expect(await resolveRealmAppeal(client(200, { ...receipt, replayed: true }, inspect), command))
    .toMatchObject({ ok: true, data: { replayed: true } });
});

test('an admitted HTTP 202 retains the decision; a refusal preserves its exact problem', async () => {
  expect(await resolveRealmAppeal(client(202, { ...receipt, operation: { ...receipt.operation, status: 'accepted', continuation: 'sanction-resolution' } }), command))
    .toEqual({ ok: false, failure: 'pending' });
  const problem = { status: 403, title: 'Member management permission is required', code: 'realm_management_denied' };
  expect(await resolveRealmAppeal(client(403, { type: 'https://rezics.com/problems/realm_management_denied', ...problem }), command))
    .toEqual({ ok: false, failure: 'denied', ...problem });
  expect(await resolveRealmAppeal(client(503, { ...problem, status: 503, code: 'sanction_pending' }), command))
    .toMatchObject({ ok: false, failure: 'unavailable', status: 503 });
});

test('a receipt for another case or outcome never confirms this decision', async () => {
  expect(await resolveRealmAppeal(client(200, { ...receipt, caseId: receipt.decisionId }), command))
    .toEqual({ ok: false, failure: 'unavailable' });
  expect(await resolveRealmAppeal(client(200, { ...receipt, outcome: 'dismiss' }), command))
    .toEqual({ ok: false, failure: 'unavailable' });
});

test('sanction recovery freezes the exact command and controller across a reload', async () => {
  const store = isolatedAttemptStorage('sanction-controller');
  const realm = '00000000-0000-4000-8000-000000000010';
  const operation = `sanction-appeal:${basis.caseId}`;
  const proposed = { realm, actingSubject: actor, input: command, key: command.idempotencyKey, status: 'recorded' as const };
  expect(await performCommand(operation, proposed, attempt => resolveRealmAppeal(client(202,
    { ...receipt, operation: { ...receipt.operation, status: 'accepted', continuation: 'sanction-resolution' } }), attempt.input), store))
    .toEqual({ ok: false, failure: 'pending' });
  expect(readCommand(realm, actor, operation, store)?.key).toBe(command.idempotencyKey);
  const later = { ...command, outcome: 'dismiss' as const, rationale: 'A changed intent', idempotencyKey: 'new-render-key' };
  expect(await performCommand(operation, { ...proposed, input: later, key: later.idempotencyKey }, attempt => resolveRealmAppeal(
    client(200, receipt, async request => { expect(await request.json()).toEqual(command); }), attempt.input), store))
    .toMatchObject({ ok: true, data: { caseId: basis.caseId } });
  expect(readCommand(realm, actor, operation, store)).toBeNull();
  expect(await retainCommand(operation, { ...proposed, actingSubject: 'another-subject' }, store)).toBeNull();
  expect(await retainCommand(operation, { ...proposed, principal: 'another-controller' }, store)).toBeNull();
});
