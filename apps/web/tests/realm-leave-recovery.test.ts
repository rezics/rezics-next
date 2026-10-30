import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RealmLeaveRecovery } from '../src/community/realm-leave-recovery.tsx';
import { classifyRealmLeaveFailure, realmLeaveReadResolves } from '../src/community/realm-leave-recovery';
import { refreshRealmMembership } from '../src/community/realm-membership-queries';
import { loadRealmMembership, requestRealmMembership } from '../src/community/space';
import { loadAccess } from '../src/accounts/resource-access/data';

const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const authorization = 'Bearer current-member';
const auth = { headers: { authorization } };
const problem = (effect = 'not_applied') => ({
  type: 'https://rezics.com/problems/forbidden',
  title: 'Forbidden',
  status: 403,
  code: 'forbidden',
  retryable: false,
  effect_status: effect,
  request_id: 'native-request',
  detail: 'An internal explanation must not become an ownership assertion.',
});

test('A native refused Realm leave preserves membership and gives current-authorized ownership recovery without inferring owner role or replaying an uncertain action', async () => {
  let response: 'refused' | 'lost' | 'accepted' = 'refused';
  let member: 'member' | 'none' = 'member';
  const commands: Request[] = [];
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get('authorization')).toBe(authorization);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/membership')) {
        commands.push(request);
        expect(request.method).toBe('DELETE');
        expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
        if (response === 'lost') throw new Error('Response lost after submission');
        return response === 'accepted'
          ? Response.json({ workflowId: 'native-workflow' }, { status: 202 })
          : Response.json(problem(), { status: 403 });
      }
      if (path === '/v1/grants') return Response.json(problem(), { status: 403 });
      reads++;
      if (path.endsWith('/members/me')) return Response.json({ state: member, since: null });
      expect(path).toBe(`/v1/realms/${realmId}/participation`);
      return new Response(null, { status: 204 });
    },
  });
  const leave = () =>
    requestRealmMembership(
      client,
      new Request('https://site.example/action', { method: 'POST', ...auth }),
      {},
      { realmId, action: 'leave', idempotencyKey },
    );
  const read = () => loadRealmMembership(client, realmId, auth);
  const refused = await leave();
  if (refused.outcome === 'accepted') throw new Error('Expected a native refusal');
  const recovery = classifyRealmLeaveFailure(refused);
  expect(recovery).toEqual({ kind: 'refused', ownerReason: 'unavailable' });
  expect((await read()).state).toBe('member');
  expect(commands).toHaveLength(1);
  const markup = renderToStaticMarkup(
    createElement(RealmLeaveRecovery, {
      realmId,
      recovery,
      check: null,
      busy: false,
      ready: true,
      onCheck() {},
      onRetry() {},
    }),
  );
  expect(markup).toContain('If you are the last explicit owner');
  expect(markup).not.toContain(problem().detail);
  expect(markup).not.toContain('href='); // Private Access reads wait for an explicit review interaction and hydration.
  expect(markup).not.toContain('Retry the same leave request');
  expect(await loadAccess(client, authorization, realmId)).toEqual({ status: 'denied' });
  // A refused request is never replayed automatically. A later fresh membership/admission read releases it.
  expect(realmLeaveReadResolves(recovery, (await read()).state)).toBe(true);
  expect(commands).toHaveLength(1);

  response = 'lost';
  const uncertain = classifyRealmLeaveFailure(
    (await leave().catch(() => ({ outcome: 'refused' as const }))) as Exclude<typeof refused, { outcome: 'accepted' }>,
  );
  expect(uncertain.kind).toBe('uncertain');
  const stillMember = await read();
  expect(realmLeaveReadResolves(uncertain, stillMember.state)).toBe(false);
  expect(realmLeaveReadResolves(uncertain, 'pending')).toBe(false);
  expect(realmLeaveReadResolves(uncertain, 'banned')).toBe(false);
  // A manual retry sends the retained intent and key, then acceptance still waits for native settlement.
  response = 'accepted';
  expect(await leave()).toEqual({ outcome: 'accepted', workflowId: 'native-workflow' });
  const before = reads;
  expect(await refreshRealmMembership(read, 'none', { pause: async () => {} })).toEqual({ kind: 'pending' });
  expect(reads - before).toBe(8); // Four membership + participation refreshes, no command retries.
  expect(commands).toHaveLength(3);
  member = 'none';
  expect((await refreshRealmMembership(read, 'none')).kind).toBe('settled');
  expect(realmLeaveReadResolves(uncertain, (await read()).state)).toBe(true);
  expect(commands).toHaveLength(3);
});

test('status, detail, unknown effects and erased applied results never identify an owner or prove non-application', async () => {
  for (const body of [
    { code: 'forbidden', detail: 'sole owner must transfer' },
    problem('unknown'),
    { ...problem(), effect_status: undefined },
    {
      ...problem('applied'),
      type: 'https://rezics.com/problems/command_result_erased',
      code: 'command_result_erased',
      status: 410,
    },
  ]) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async () => Response.json(body, { status: body.status ?? 403 }),
    });
    const result = await requestRealmMembership(
      client,
      new Request('https://site.example/action', { method: 'POST', ...auth }),
      {},
      { realmId, action: 'leave', idempotencyKey },
    );
    if (result.outcome === 'accepted') throw new Error('Unexpected acceptance');
    expect(classifyRealmLeaveFailure(result)).toEqual({ kind: 'uncertain', ownerReason: 'unavailable' });
  }
});

test('only the declared closed last-owner problem on leave offers specific ownership recovery', async () => {
  const ownerProblem = {
    type: 'https://rezics.com/problems/realm_last_owner',
    title: 'Realm Ownership Transfer Required',
    status: 409,
    code: 'realm_last_owner',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'native-owner-request',
  };
  async function failure(body: Record<string, unknown>, action: 'join' | 'leave' = 'leave', status = 409) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async () => Response.json(body, { status }),
    });
    const result = await requestRealmMembership(
      client,
      new Request('https://site.example/action', { method: 'POST', ...auth }),
      {},
      { realmId, action, idempotencyKey },
    );
    if (result.outcome === 'accepted') throw new Error('Unexpected acceptance');
    return classifyRealmLeaveFailure(result);
  }
  const recovery = await failure(ownerProblem);
  expect(recovery).toEqual({ kind: 'refused', ownerReason: 'last-owner' });
  const markup = renderToStaticMarkup(
    createElement(RealmLeaveRecovery, {
      realmId,
      recovery,
      check: 'checking',
      busy: true,
      ready: true,
      onCheck() {},
      onRetry() {},
    }),
  );
  expect(markup).toContain('Another eligible explicit owner is required');
  expect(markup).not.toContain('If you are');
  expect(markup).not.toContain('href=');
  expect(markup).not.toContain('Your request was accepted');
  expect(markup).not.toContain('Retry the same leave request');
  // No nearby generic denial, malformed envelope or join result can identify a last owner.
  for (const body of [
    { ...ownerProblem, code: 'forbidden', type: 'https://rezics.com/problems/forbidden' },
    { ...ownerProblem, title: 'Conflict' },
    { ...ownerProblem, retryable: true },
    { ...ownerProblem, effect_status: 'unknown' },
    { ...ownerProblem, effect_status: 'applied' },
    { ...ownerProblem, type: 'https://other.example/realm_last_owner' },
    { ...ownerProblem, request_id: undefined },
    { ...ownerProblem, status: 403 },
  ])
    expect((await failure(body)).ownerReason).toBe('unavailable');
  expect((await failure(ownerProblem, 'leave', 403)).ownerReason).toBe('unavailable');
  expect(await failure(ownerProblem, 'join')).toEqual({ kind: 'uncertain', ownerReason: 'unavailable' });
});
