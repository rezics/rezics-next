import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { PolicyConflict, PolicyControllerContinuity } from '../src/modules/access/policy-errors.ts';
import { AccessRevocations, type RevocationRequest } from '../src/modules/access/revocation-requests.ts';
import { accessPolicyRoutes } from '../src/routes/access-policy.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revocationId = '00000000-0000-4000-8000-000000000002';
const targetId = '00000000-0000-4000-8000-000000000003';
const principal = { issuer: 'https://account.test', subject: 'member' };

/** Reaches the last-controller check, or an earlier revocation, and no further. */
function pool(options: { allowed: boolean; earlier?: boolean }) {
  const query = async (sql: string) => {
    const rows = (items: Record<string, unknown>[]) => ({ rows: items, rowCount: items.length });
    if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') return rows([]);
    if (sql.includes('access.recovery_fence')) return rows([{ open: true, generation: '1' }]);
    if (sql.includes('FROM access.principal')) return rows([{ id: 'principal', enforcement_epoch: '0', active: true }]);
    if (sql.includes('FROM access.scope_gate')) return rows([{ authority_epoch: '0' }]);
    if (sql.includes('pg_advisory_xact_lock')) return rows([]);
    if (sql.includes('FROM access.representation r')) return rows([{ id: 'mandate', generation: '1' }]);
    if (sql.includes('access.revocation_receipt')) return rows([]);
    if (sql.includes('FROM access.representation WHERE')) return rows([{
      active: true, generation: '1', action: 'agent.control', issuer: agent, scope: null }]);
    if (sql.includes('FROM access.revocation WHERE')) return rows(options.earlier ? [{ present: 1 }] : []);
    if (sql.startsWith('UPDATE')) return rows([{ generation: '1' }]);
    if (sql.includes('agent_controller_count')) return rows([{ allowed: options.allowed }]);
    throw new Error(`Unexpected revocation query: ${sql}`);
  };
  return { connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

const request: RevocationRequest = { revocationId, issuerSubject: agent, mode: 'strong',
  scopeId: 'work:create:root', expectedAuthorityEpoch: '0',
  target: { kind: 'representation', id: targetId, expectedGeneration: '1' } };
const receipt = { idempotencyKey: 'revoke-last', requestDigest: 'a'.repeat(64) };

function app(database: Pool) {
  return accessPolicyRoutes({ account: { verify: async () => principal },
    accessPolicy: { revocations: new AccessRevocations(database) } } as unknown as MainWorkDependencies);
}

function post(database: Pool) {
  return app(database).handle(new Request('http://main.local/v1/access/revocations', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': receipt.idempotencyKey },
    body: JSON.stringify({ profile: 'access-revocation-v1', ...request }) }));
}

test('a last-controller revocation is controller_continuity, not an idempotency conflict', async () => {
  try {
    await new AccessRevocations(pool({ allowed: false })).revoke(principal, request, receipt);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyControllerContinuity);
    expect(error).not.toBeInstanceOf(PolicyConflict);
    expect(error instanceof Error ? error.message : '').toContain('continuity');
  }
  const response = await post(pool({ allowed: false }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ status: 409, code: 'controller_continuity',
    type: 'https://rezics.com/problems/controller_continuity',
    title: 'This change would leave a resource without a controller' });
});

test('a revocation that clashes with an existing one stays an idempotency conflict', async () => {
  await expect(new AccessRevocations(pool({ allowed: true, earlier: true })).revoke(principal, request, receipt))
    .rejects.toBeInstanceOf(PolicyConflict);
  const response = await post(pool({ allowed: true, earlier: true }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'policy_key_conflict',
    title: 'Idempotency key binds another intent' });
});
