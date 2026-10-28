import { expect, test } from 'bun:test';
import { coveredByRootGate, promotionCommand, PROMOTION_GATE_TIMEOUT_MS } from './promotion.ts';

test('acceptance commands inside workspace and control-plane trees are covered by the root gate', () => {
  expect(coveredByRootGate(['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/a.test.ts'])).toBe(true);
  expect(
    coveredByRootGate(['bun', 'test', 'packages/conversion/tests/a.test.ts', 'services/importer/tests/b.test.ts']),
  ).toBe(true);
  expect(coveredByRootGate(['bun', 'apps/web/scripts/isolated.ts', 'bun', 'test', 'apps/web/tests/a.test.ts'])).toBe(
    true,
  );
  expect(coveredByRootGate(['bun', 'test', 'tools/goal/src/promotion-flake.test.ts'])).toBe(true);
  expect(
    coveredByRootGate([
      'sh',
      '-c',
      'cd services/importer && bunx oxfmt --check tests/a.test.ts && bun test tests/a.test.ts',
    ]),
  ).toBe(true);
});

test('root specs, root scripts and commands that leave a workspace still run at promotion', () => {
  expect(coveredByRootGate(['bun', 'specs/support/verify-outcome-suite.ts', 'specs/imports-api.test.ts'])).toBe(false);
  expect(coveredByRootGate(['bun', 'test', 'scripts/typecheck.test.ts'])).toBe(false);
  expect(coveredByRootGate(['bun', 'test', 'services/kernel/test/a.test.ts', 'specs/b.test.ts'])).toBe(false);
  expect(coveredByRootGate(['env', 'SPEC_STRICT=1', 'bun', 'test', 'services/auth/test/a.test.ts'])).toBe(false);
  expect(coveredByRootGate(['bun', 'run', '--cwd', 'services/kernel/test', 'check'])).toBe(false);
  expect(coveredByRootGate(['sh', '-c', 'cd apps/web && bun test; cd ../.. && bun test specs'])).toBe(false);
});

test('a bare bun test that mixes workspace and outside files runs only the outside files at promotion', () => {
  // A bare run of services/kernel/test/client.test.ts had no database and blocked a promotion whose root gate passed.
  expect(
    promotionCommand([
      'bun',
      'test',
      'services/kernel/test/client.test.ts',
      'services/kernel/test/auth-contract-imports.test.ts',
      'scripts/workspace-imports.test.ts',
    ]),
  ).toEqual(['bun', 'test', 'scripts/workspace-imports.test.ts']);
  expect(
    promotionCommand(['bun', 'test', '--timeout', '60000', 'services/kernel/test/a.test.ts', 'specs/b.test.ts']),
  ).toEqual(['bun', 'test', '--timeout', '60000', 'specs/b.test.ts']);
  expect(promotionCommand(['bun', 'test', 'services/kernel/test/a.test.ts'])).toBeNull();
  expect(promotionCommand(['env', 'SPEC_STRICT=1', 'bun', 'test', 'services/auth/test/a.test.ts'])).toEqual([
    'env',
    'SPEC_STRICT=1',
    'bun',
    'test',
    'services/auth/test/a.test.ts',
  ]);
});

test('a promotion gate may run as long as a full root gate takes', () => {
  // The full kernel check alone measured 44 minutes on 2026-10-26.
  expect(PROMOTION_GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 60 * 60_000);
});
