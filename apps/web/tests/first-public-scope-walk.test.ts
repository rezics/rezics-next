import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_SCOPE_PATHS } from '../scripts/first-public-scope-paths.ts';

const capabilities = resolve(import.meta.dir, '../../../docs/goals/web.capabilities.md');
const stackHost = resolve(import.meta.dir, './native/stack.host.test.ts');
const authHost = resolve(import.meta.dir, './native/auth-stack.host.test.ts');
const identityHost = resolve(import.meta.dir, './native/native-agent-identity.host.test.ts');
const interruptHost = resolve(import.meta.dir, './native/web-publication-interrupt.host.test.ts');

test('the first-public-scope walk names each of the 35 Goal paths once', () => {
  expect(FIRST_PUBLIC_SCOPE_PATHS).toHaveLength(35);
  expect(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.id)).toEqual(
    Array.from({ length: 35 }, (_, index) => `W${String(index + 1).padStart(2, '0')}`),
  );
  expect(new Set(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.job)).size).toBe(35);
});

test('the walk retains the original native host suites and does not import Auth contract', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/first-public-scope-walk.ts'), 'utf8');
  expect(source).toContain("from './first-public-scope-paths.ts'");
  expect(source).not.toMatch(/from ['"]@rezics\/auth-contract['"]/);
  expect(readFileSync(stackHost, 'utf8')).toContain('startNativeWebStack');
  expect(readFileSync(authHost, 'utf8')).toContain('startAuthStack');
  expect(readFileSync(identityHost, 'utf8')).toContain('createNativeAgentIdentityFixture');
  expect(readFileSync(interruptHost, 'utf8')).toContain('createWebPublicationDriver');
});

test('web.capabilities records one PASS, FAIL or FAIL-unreached row for each path', () => {
  const text = readFileSync(capabilities, 'utf8');
  for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
    expect(text).toMatch(new RegExp(`\\| ${path.id} \\|`));
    expect(text).toMatch(new RegExp(`\\| ${path.id} \\|[^\\n]*\\| (PASS|FAIL-unreached|FAIL) \\|`));
  }
});
