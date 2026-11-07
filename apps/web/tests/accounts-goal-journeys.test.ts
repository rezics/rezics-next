import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  JOURNEYS,
  finishUnobservedJourneys,
  KERNEL_BEARER_JOURNEYS,
  parseJourneyTable,
  renderJourneyTable,
  renderWalkCensus,
  replaceWalkCensus,
} from '../scripts/accounts-goal-walk.ts';
import { commandNeedsSharedDevServer } from '../scripts/with-dev-server.ts';

const capabilities = resolve(import.meta.dir, '../../../docs/goals/accounts.capabilities.md');
const walk = resolve(import.meta.dir, '../scripts/accounts-goal-walk.ts');

test('every first-public Accounts journey has a published row with causal repair ownership', () => {
  const rows = parseJourneyTable(readFileSync(capabilities, 'utf8'));
  expect(rows.map((row) => row.id)).toEqual(JOURNEYS.map((journey) => journey.id));
  expect(rows).toHaveLength(19);
  for (const [index, row] of rows.entries()) {
    const expected = JOURNEYS[index]!;
    expect(row.journey).toBe(expected.journey);
    expect([expected.owner, 'Performance (shared walk admission)', 'Content (walk stack startup)']).toContain(
      row.owner,
    );
    expect(row.persona.length).toBeGreaterThan(0);
    expect(row.evidence).toMatch(/^\.temp\/accounts\//);
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

test('a website-bearer Kernel 401 fails only dependent Kernel journeys and keeps anonymous public reads', () => {
  expect([...KERNEL_BEARER_JOURNEYS]).toEqual(['J05', 'J10', 'J11', 'J15', 'J16', 'J17', 'J19']);
  const source = readFileSync(walk, 'utf8');
  expect(source).toContain('failDependents([...KERNEL_BEARER_JOURNEYS], kernelBearerCause, label)');
  expect(source).toContain("failRemaining('walk ended before every journey ran', 'walk ended')");
  expect(source).toContain('person public HTTP 200 without private fields; not reached:');
  expect(source).toContain('anonymous outgoing HTTP');
  expect(source).toContain('exited ${child.exitCode} before becoming ready');
});

test('the table-shape check does not boot Storybook, and follow writes the public agent subject without a body', () => {
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/accounts-goal-journeys.test.ts'])).toBe(false);
  expect(
    commandNeedsSharedDevServer([
      'bun',
      'test',
      'tests/accounts-goal-journeys.test.ts',
      'tests/with-dev-server.test.ts',
    ]),
  ).toBe(false);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/server-custody.test.ts'])).toBe(false);
  expect(
    commandNeedsSharedDevServer(['bun', 'test', 'tests/server-custody.test.ts', 'tests/session.test.ts']),
  ).toBe(true);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/session.test.ts'])).toBe(true);
  const source = readFileSync(walk, 'utf8');
  expect(source).toContain("const session = await signIn(stack, person, 'login', []);");
  expect(source).toContain(
    "followTargetId = await waitForPublicAgentSubject(stack, followTarget.handle, 'follow target')",
  );
  expect(source).toContain("kernel(stack, 'PUT', `/v1/follows/${followTargetId}`, { bearer: token.bearer })");
  expect(source).not.toMatch(/follows\/\$\{followTargetId\}.*body:/);
  expect(source).toContain('`${stack.native}/revoke`');
  expect(source).toContain("visibility: 'protected'");
  expect(source).toContain("join(root, '.temp/local-stack/recovery'");
  expect(source).toContain('delete rest.confirmation');
  expect(source).toContain("operation.kind === 'organization' || operation.kind === 'delete'");
  expect(source).toContain('`/v1/realms/${realmId}/members`');
  expect(source).toContain('outsider opened the software session');
  expect(source).toContain('/operator-sessions/open');
  expect(source).toMatch(/\/account-operations\/execute[\s\S]{0,220}30_000/);
  expect(source).toMatch(/credential-effects\/stage[\s\S]{0,240}30_000/);
  const rows = parseJourneyTable(readFileSync(capabilities, 'utf8'));
  const census = renderWalkCensus(rows, rows[0]!.revision, rows[0]!.observedAt, '2026-11-07T03:42:43Z', true);
  expect(census).toMatch(/^Round .+ Causal repairs: `\.temp\/continuation\/accounts-walk-admission.md`/);
  expect(replaceWalkCensus(readFileSync(capabilities, 'utf8'), census)).toContain(census);
  const withProse = `## First-public journeys\n\nCensus refresh locates the dated census line. Round 2026-11-07T00:00:00Z on \`abc\`. The table-shape check does not start Storybook.\n`;
  expect(replaceWalkCensus(withProse, 'Round 2026-11-07T01:00:00Z on `def`.')).toContain('dated census line');
  expect(replaceWalkCensus(withProse, 'Round 2026-11-07T01:00:00Z on `def`.')).toContain(
    'Round 2026-11-07T01:00:00Z on `def`.',
  );
});

test('admission EACCES replaces only unobserved rows with the exact first cause and infrastructure owner', () => {
  const rows = parseJourneyTable(readFileSync(capabilities, 'utf8'));
  const pending = rows.map((row) => ({ ...row, result: 'unobserved' as const }));
  const passed = { ...rows[0]!, result: 'PASS' as const, cause: 'native callback completed' };
  const cause = "EACCES: permission denied, open '/tmp/rezics-walk-stacks/sequence.next'";
  const finished = finishUnobservedJourneys(
    [passed, ...pending.slice(1)],
    `215 | writeFileSync(...)\n${cause}\n at acquireStackSlot`,
    1,
    '2026-11-07T09:15:00Z',
    317,
  );
  expect(finished[0]).toEqual(passed);
  expect(finished.slice(1)).toHaveLength(18);
  for (const row of finished.slice(1)) {
    expect(row.result).toBe('FAIL');
    expect(row.reached).toBe('not reached: dev-stack walk admission/startup');
    expect(row.cause).toBe(cause);
    expect(row.owner).toBe('Performance (shared walk admission)');
    expect(row.persona).toBe('not reached: no persona provisioned');
    expect(row.elapsed).toBe('317ms');
    expect(row.evidence).toBe('.temp/accounts/launcher.log');
  }
});
