import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { Pool } from 'pg';
import {
  platformAdministratorAction,
  platformAdministratorTargetAllowed,
  AccessPlatformAdministrators,
  platformAdministratorProofCurrent,
  type PlatformAdministratorProof,
} from '../../../services/main/src/modules/access/platform-administrator.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-a000-000000000001';
const principal = '00000000-0000-4000-a000-000000000002';
test('platform action candidates are syntactic; grant proofs retain exact controller/principal fences', async () => {
  expect(platformAdministratorAction('semantic.change', 'semantic:create:root')).toBe(true);
  expect(platformAdministratorAction('lexicon.presentation.review', `semantic:edit:${actor}`)).toBe(
    true,
  );
  expect(platformAdministratorAction('catalogue.verify', 'catalogue:verify:root')).toBe(true);
  expect(
    platformAdministratorAction(
      'classification.proposition.define',
      'classification:define:global',
    ),
  ).toBe(true);
  expect(
    platformAdministratorAction(
      'classification.proposition.define',
      `classification:define:${actor}`,
    ),
  ).toBe(true);
  expect(platformAdministratorAction('statement.decide', 'classification:decide:global')).toBe(
    true,
  );
  expect(platformAdministratorAction('zone.edit', `zone:edit:${actor}`)).toBe(true);
  expect(platformAdministratorAction('content.draft', `content:draft:${actor}`)).toBe(true);
  for (const action of ['work.read', 'work.edit', 'collection.edit']) {
    expect(platformAdministratorAction(action, `${action.replace('.', ':')}:${actor}`)).toBe(true);
  }
  expect(platformAdministratorAction('work.create', `work:edit:${actor}`)).toBe(true);
  expect(platformAdministratorAction('semantic.change', 'semantic:edit:anything')).toBe(true);
  expect(platformAdministratorAction('toString', 'work:create:root')).toBe(false);
  expect(platformAdministratorAction('work.create', 'invalid scope')).toBe(false);
  const saved: PlatformAdministratorProof = {
    receipt: `urn:rezics:access-receipt:${'a'.repeat(64)}`,
    representation_id: principal,
    representation_generation: '0',
    subject_generation: '0',
    principal_epoch: '0',
  };
  let current: PlatformAdministratorProof | null = saved;
  let statements = 0;
  const client = {
    query: async (sql: string) => {
      statements++;
      if (sql.includes('FROM access.scope_gate')) return { rows: [] };
      if (sql.includes('access.read_platform_permissions'))
        return {
          rows: [
            {
              id: principal,
              action: 'platform:use:platform-admin',
              scope_id: 'platform:access',
              generation: '0',
              valid_until: null,
              witness: 'live-grant',
            },
          ],
        };
      return { rows: current ? [current] : [] };
    },
  } as unknown as PoolClient;
  expect(await platformAdministratorProofCurrent(client, saved, principal, actor)).toBe(true);
  expect(statements).toBe(3);
  for (const key of [
    'receipt',
    'representation_id',
    'representation_generation',
    'subject_generation',
    'principal_epoch',
  ] as const) {
    current = { ...saved, [key]: 'changed' };
    expect(await platformAdministratorProofCurrent(client, saved, principal, actor)).toBe(false);
  }
  current = null;
  expect(await platformAdministratorProofCurrent(client, saved, principal, actor)).toBe(false);
});

test('first designation refuses missing or inactive principals without creating one', async () => {
  for (const principal of [undefined, { id: actor, active: false }]) {
    const statements: string[] = [];
    const client = {
      release() {},
      query: async (sql: string) => {
        statements.push(sql);
        return {
          rows: sql.includes('FROM access.recovery_fence')
            ? [{ open: true }]
            : sql.includes('FROM access.principal') && principal
              ? [principal]
              : [],
        };
      },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    await expect(
      new AccessPlatformAdministrators(pool).designateFirst(
        'https://account.example',
        'typo-or-inactive',
      ),
    ).rejects.toThrow('existing active');
    expect(statements.some((sql) => sql.includes('INSERT'))).toBe(false);
    expect(statements.at(-1)).toBe('ROLLBACK');
  }
});

test('administrator resource authority requires grants before checking owned targets', async () => {
  const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
  let calls = 0;
  const graph = {
    query: async () => {
      calls++;
      return { boolean: false };
    },
  };
  for (const [action, scope] of [
    ['semantic.read', `semantic:read:${actor}`],
    ['zone.edit', `zone:edit:${actor}`],
    ['zone.official', `zone:official:${actor}`],
  ]) {
    expect(
      await platformAdministratorTargetAllowed(client, graph, principal, actor, action!, scope!),
    ).toBe(false);
  }
  expect(calls).toBe(0);
  expect(
    await platformAdministratorTargetAllowed(
      client,
      undefined,
      principal,
      actor,
      'semantic.read',
      `semantic:read:${actor}`,
    ),
  ).toBe(false);
  expect(
    await platformAdministratorTargetAllowed(
      client,
      graph,
      principal,
      actor,
      'semantic.change',
      'semantic:create:root',
    ),
  ).toBe(false);
});
