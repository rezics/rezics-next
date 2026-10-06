import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionControllerContinuity,
  type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { WorkMaintainers } from '../src/modules/work/maintainers.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { workMaintainerRoutes } from '../src/routes/work-maintainers.ts';
import { commandError } from '../src/routes/problems.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const principalId = '00000000-0000-4000-8000-000000000010';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const member: VerifiedPrincipal = { issuer: 'https://account.test', subject: 'member', emailVerified: true };
const continuity = { status: 409, code: 'controller_continuity',
  type: 'https://rezics.com/problems/controller_continuity',
  title: 'This change would leave a resource without a controller' };
const idempotency = { status: 409, code: 'idempotency_conflict',
  type: 'https://rezics.com/problems/idempotency_conflict',
  title: 'Idempotency key conflicts with an earlier request' };

function rows(items: Record<string, unknown>[]) {
  return { rows: items, rowCount: items.length };
}

/** Reaches the last-controller check, or an earlier epoch clash, and no further. */
function deactivationPool(options: { allowed: boolean; epoch?: string }) {
  const query = async (sql: string) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') return rows([]);
    if (sql.includes('access.recovery_fence')) return rows([{ open: true, generation: '1' }]);
    if (sql.includes('FROM access.principal')) return rows([{ active: true, enforcement_epoch: options.epoch ?? '0' }]);
    if (sql.includes('FROM access.representation')) return rows([{ subject_id: actor }]);
    if (sql.includes('pg_advisory_xact_lock')) return rows([]);
    if (sql.startsWith('UPDATE')) return rows([{ enforcement_epoch: '1' }]);
    if (sql.includes('agent_controller_count')) return rows([{ allowed: options.allowed }]);
    throw new Error(`Unexpected deactivation query: ${sql}`);
  };
  return { connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

/** Reaches the target's controller check, or an earlier maintainer-key clash. */
function maintainerPool(options: { clash?: boolean }) {
  const query = async (sql: string) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') return rows([]);
    if (sql.includes('access.recovery_fence')) return rows([{ open: true }]);
    if (sql.includes('FROM access.work_maintainer_set')) return rows([{ main_version: work, generation: '0' }]);
    if (sql.startsWith('INSERT INTO access.scope_gate')) return rows([]);
    if (sql.includes('FROM access.scope_gate')) return rows([{}]);
    if (sql.includes('FROM access.principal')) return rows([{ id: principalId }]);
    if (sql.includes('access.work_maintainer_receipt')) {
      return options.clash ? rows([{ id: 'prior', request_digest: 'other', generation: '0', maintainers: [] }]) : rows([]);
    }
    if (sql.includes('pg_advisory_xact_lock')) return rows([]);
    if (sql.includes('agent_controller_count')) return rows([{ allowed: false }]);
    throw new Error(`Unexpected maintainer query: ${sql}`);
  };
  return { connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

const env = { fuseki: { query: async () => ({ boolean: true }) },
  lineage: { dataEpoch: 'fixture', routingEpoch: 'fixture' } } as unknown as WorkActivationEnvironment;

function post(database: Pool) {
  const app = workMaintainerRoutes({ account: { verify: async () => member },
    maintainers: new WorkMaintainers(database, env) } as unknown as MainWorkDependencies);
  return app.handle(new Request('http://main.local/v1/work-maintainer-changes', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'transfer-1' },
    body: JSON.stringify({ profile: 'work-maintainer-change-v1', work, actingSubject: actor, target,
      action: 'transfer', expectedGeneration: '0' }) }));
}

test('principal deactivation that removes the last controller answers controller_continuity', async () => {
  try {
    await new AccessAdmissionRegistry(deactivationPool({ allowed: false })).strongDeactivatePrincipal(principalId, '0');
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AdmissionControllerContinuity);
    expect(error).not.toBeInstanceOf(AdmissionConflict);
    expect(error instanceof Error ? error.message : '').toContain('continuity');
    const response = commandError(error);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject(continuity);
  }
});

test('a principal epoch clash still answers idempotency_conflict', async () => {
  await expect(new AccessAdmissionRegistry(deactivationPool({ allowed: true, epoch: '1' }))
    .strongDeactivatePrincipal(principalId, '0')).rejects.toBeInstanceOf(AdmissionConflict);
  try {
    await new AccessAdmissionRegistry(deactivationPool({ allowed: true, epoch: '1' })).strongDeactivatePrincipal(principalId, '0');
    expect.unreachable();
  } catch (error) {
    expect(error).not.toBeInstanceOf(AdmissionControllerContinuity);
    expect(await commandError(error).json()).toMatchObject(idempotency);
  }
});

test('a maintainer change that breaks controller continuity answers controller_continuity', async () => {
  const database = maintainerPool({});
  await expect(new WorkMaintainers(database, env).change(member, { work, actingSubject: actor, target,
    action: 'transfer', expectedGeneration: '0' }, 'transfer-1')).rejects.toBeInstanceOf(AdmissionControllerContinuity);
  const response = await post(maintainerPool({}));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject(continuity);
});

test('a maintainer idempotency clash still answers idempotency_conflict', async () => {
  await expect(new WorkMaintainers(maintainerPool({ clash: true }), env).change(member, { work,
    actingSubject: actor, target, action: 'transfer', expectedGeneration: '0' }, 'transfer-1'))
    .rejects.toBeInstanceOf(AdmissionConflict);
  const response = await post(maintainerPool({ clash: true }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject(idempotency);
});
