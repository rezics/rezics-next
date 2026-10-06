import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../src/modules/access/admission.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const admin: VerifiedPrincipal = { issuer: 'https://account.test', subject: 'admin', emailVerified: true };
const useGrant = { id: '00000000-0000-4000-8000-000000000011', action: 'platform:use:platform-admin',
  scope_id: 'platform:access', generation: '1', valid_until: null, witness: 'use' };
const resourceGrant = { id: '00000000-0000-4000-8000-000000000012', action: 'platform:resource:work.create',
  scope_id: 'work:create:root', generation: '1', valid_until: null, witness: 'resource' };

function rows(items: Record<string, unknown>[]) {
  return { rows: items, rowCount: items.length };
}

/** A platform administrator with a live controller, and the resource grant only when asked. */
function pool(resource: boolean) {
  const query = async (sql: string) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') return rows([]);
    if (sql.includes('access.recovery_fence')) return rows([{ open: true, generation: '1' }]);
    if (sql.includes('FROM access.policy')) return rows([]);
    if (sql.includes("id = 'work:create:root'")) return rows([{ open: true, dispatch_open: true, authority_epoch: '0' }]);
    if (sql.includes('access:representation-topology')) return rows([]);
    if (sql.includes('FROM access.scope_gate')) return rows([{ id: 'platform:access' }]);
    if (sql.includes('account_issuer')) return rows([{ id: 'principal' }]);
    if (sql.includes('read_platform_permissions')) return rows(resource ? [useGrant, resourceGrant] : [useGrant]);
    if (sql.includes('AS receipt')) return rows([{ receipt: 'urn:rezics:access-receipt:preview',
      representation_id: 'rep', representation_generation: '1', subject_generation: '1', principal_epoch: '0' }]);
    if (sql.includes('FROM access.representation')) return rows([]);
    throw new Error(`Unexpected eligibility query: ${sql}`);
  };
  return { connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

test('a platform administrator without the work.create resource grant cannot preview Work creation', async () => {
  expect(await new AccessAdmissionRegistry(pool(false)).hasNonBaselineWorkCreateAuthority(admin, actor)).toBe(false);
});

test('a platform administrator with the work:create:root grant can preview Work creation', async () => {
  expect(await new AccessAdmissionRegistry(pool(true)).hasNonBaselineWorkCreateAuthority(admin, actor)).toBe(true);
});
