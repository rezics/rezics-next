import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthorityWitness } from '../src/modules/access/authority-witness.ts';
import { admissionPolicyAllowed } from '../src/modules/access/policy-decisions.ts';
import { PolicyUnavailable } from '../src/modules/access/policy-errors.ts';

async function judgement(
  table: 'role_binding' | 'permission_grant',
  permissions: string[],
  unavailable = false,
) {
  const source: AuthorityWitness = { table, id: randomUUID(), generation: '7' };
  const reads: string[] = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      reads.push(sql);
      if (sql.includes('FROM access.policy p'))
        return {
          rows: [
            {
              id: randomUUID(),
              head_revision: '1',
              max_states: 64,
              max_input_rows: 64,
              deadline_ms: 1000,
              now: new Date(),
            },
          ],
        };
      if (sql.includes('FROM access.policy_rule_set_reference')) return { rows: [] };
      if (sql.includes('FROM access.policy_rule\n'))
        return {
          rows: [
            {
              tier: 'mandatory',
              position: 1,
              rule_id: randomUUID(),
              effect: 'require',
              actions: ['work.create'],
              condition: { op: 'has-grant', action: 'work.edit' },
            },
            {
              tier: 'ordered',
              position: 1,
              rule_id: randomUUID(),
              effect: 'allow',
              actions: ['work.create'],
              condition: { op: 'has-grant', action: 'work.create' },
            },
          ],
        };
      if (sql.includes('FROM access.role_binding b')) {
        expect(values).toEqual([source.id, '7', 'work.edit']);
        if (unavailable) throw new Error('role revision read unavailable');
        return { rows: permissions.includes('work.edit') ? [{ id: source.id }] : [] };
      }
      throw new Error(`Unexpected authority read: ${sql}`);
    },
  } as unknown as PoolClient;
  const allowed = await admissionPolicyAllowed(
    client,
    randomUUID(),
    'actor',
    'work:create:root',
    'work.create',
    { witness: [source], eligible: true },
  );
  return { allowed, reads };
}

test('C1: one pinned role can satisfy several grant conditions from its own revision', async () => {
  expect((await judgement('role_binding', ['work.create', 'work.edit'])).allowed).toBe(true);
  expect((await judgement('role_binding', ['work.create'])).allowed).toBe(false);
});

test('C1: a second independent grant cannot complete a policy condition for the selected path', async () => {
  const decision = await judgement('permission_grant', ['work.create', 'work.edit']);
  expect(decision.allowed).toBe(false);
  expect(decision.reads.some((sql) => sql.includes('FROM access.permission_grant'))).toBe(false);
});

test('C1: an unreadable selected role revision makes the policy judgement unavailable', async () => {
  await expect(
    judgement('role_binding', ['work.create', 'work.edit'], true),
  ).rejects.toBeInstanceOf(PolicyUnavailable);
});
