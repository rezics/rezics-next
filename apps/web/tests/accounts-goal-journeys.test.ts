import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JOURNEYS, parseJourneyTable, renderJourneyTable } from '../scripts/accounts-goal-walk.ts';

const capabilities = resolve(import.meta.dir, '../../../docs/goals/accounts.capabilities.md');
const walk = resolve(import.meta.dir, '../scripts/accounts-goal-walk.ts');

test('every first-public Accounts journey has a published row with causal repair ownership', () => {
  const rows = parseJourneyTable(readFileSync(capabilities, 'utf8'));
  expect(rows.map((row) => row.id)).toEqual(JOURNEYS.map((journey) => journey.id));
  expect(rows).toHaveLength(19);
  for (const [index, row] of rows.entries()) {
    const expected = JOURNEYS[index]!;
    expect(row.journey).toBe(expected.journey);
    expect(row.owner).toBe(expected.owner);
    expect(['PASS', 'FAIL', 'unobserved']).toContain(row.result);
    expect(row.reached.length).toBeGreaterThan(0);
    expect(row.revision.length).toBeGreaterThan(0);
    expect(row.elapsed.length).toBeGreaterThan(0);
    expect(row.cause.length).toBeGreaterThan(0);
    if (row.result !== 'unobserved') {
      expect(row.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(row.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.elapsed).toMatch(/^\d+ms$/);
      expect(row.reached).not.toBe('—');
    }
  }
});

test('the journey table round-trips without dropping a repair owner', () => {
  const rows = parseJourneyTable(readFileSync(capabilities, 'utf8'));
  expect(parseJourneyTable(`## First-public journeys\n\n${renderJourneyTable(rows)}\n`)).toEqual(rows);
});

test('the Goal walk reuses inlined Auth client identities and never imports auth-contract', () => {
  const source = readFileSync(walk, 'utf8');
  expect(source).not.toMatch(/from ['"]@rezics\/auth-contract['"]/);
  expect(source).toContain("const AUTH_PAGE_OPERATION_CLIENT_ID = 'rezics-auth-account-operations'");
  expect(source).toContain("const AUTH_MANAGEMENT_CLIENT_ID = 'rezics-auth-account-management'");
  expect(source).toContain("signIn(stack, person, 'login', [], secret)");
  expect(source).toContain("grant_type: 'authorization_code'");
  expect(source).toContain("REZICS_WALK_DEFER_FRONTENDS === '1'");
});
