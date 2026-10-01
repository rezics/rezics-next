import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import {
  platformAdministratorAction,
  platformAdministratorProofCurrent,
  type PlatformAdministratorProof,
} from '../../../services/main/src/modules/access/platform-administrator.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-a000-000000000001';
const principal = '00000000-0000-4000-a000-000000000002';
test('G-724 platform role has closed actions and exact controller/principal fences', async () => {
  expect(platformAdministratorAction('semantic.change', 'semantic:create:root')).toBe(true);
  expect(platformAdministratorAction('lexicon.presentation.review', `semantic:edit:${actor}`)).toBe(
    true,
  );
  expect(platformAdministratorAction('catalogue.verify', 'catalogue:verify:root')).toBe(true);
  expect(platformAdministratorAction('zone.edit', `zone:edit:${actor}`)).toBe(true);
  expect(platformAdministratorAction('content.draft', `content:draft:${actor}`)).toBe(false);
  expect(platformAdministratorAction('work.create', `work:edit:${actor}`)).toBe(false);
  expect(platformAdministratorAction('semantic.change', 'semantic:edit:anything')).toBe(false);
  expect(platformAdministratorAction('toString', 'work:create:root')).toBe(false);
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
    query: async () => {
      statements++;
      return { rows: current ? [current] : [] };
    },
  } as unknown as PoolClient;
  expect(await platformAdministratorProofCurrent(client, saved, principal, actor)).toBe(true);
  expect(statements).toBe(1);
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
