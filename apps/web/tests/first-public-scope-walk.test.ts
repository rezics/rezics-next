import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_SCOPE_PATHS } from '../scripts/first-public-scope-paths.ts';

const capabilities = resolve(import.meta.dir, '../../../docs/goals/web.capabilities.md');
const stackHost = resolve(import.meta.dir, './native/stack.host.test.ts');
const authHost = resolve(import.meta.dir, './native/auth-stack.host.test.ts');
const identityHost = resolve(import.meta.dir, './native/native-agent-identity.host.test.ts');
const interruptHost = resolve(import.meta.dir, './native/web-publication-interrupt.host.test.ts');

test('the first-public-scope walk retains in-scope IDs and names the required Book and knowledge journeys', () => {
  expect(FIRST_PUBLIC_SCOPE_PATHS).toHaveLength(36);
  expect(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.id)).toEqual(
    Array.from({ length: 38 }, (_, index) => `W${String(index + 1).padStart(2, '0')}`).filter(
      (id) => id !== 'W27' && id !== 'W28',
    ),
  );
  expect(new Set(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.job)).size).toBe(36);
  expect(FIRST_PUBLIC_SCOPE_PATHS.map((path) => path.job).join(' ')).not.toMatch(
    /checkout|payment|Orders or entitlements/,
  );
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

test('historical web.capabilities evidence retains every original active path', () => {
  const text = readFileSync(capabilities, 'utf8');
  for (const path of FIRST_PUBLIC_SCOPE_PATHS) {
    if ('nativeHost' in path) continue;
    expect(text).toMatch(new RegExp(`\\| ${path.id} \\|`));
    expect(text).toMatch(new RegExp(`\\| ${path.id} \\|[^\\n]*\\| (PASS|FAIL-unreached|FAIL) \\|`));
  }
});

test('required Book and knowledge paths identify real separate native/browser suites without claiming a seeded-walk pass', () => {
  const paths = FIRST_PUBLIC_SCOPE_PATHS.flatMap((path) => ('nativeHost' in path ? [path] : []));
  expect(paths.map(({ id, nativeHost }) => [id, nativeHost])).toEqual([
    ['W36', 'tests/native/book-catalogue-journey.host.test.ts'],
    ['W37', 'tests/native/hosted-book-journey.host.test.ts'],
    ['W38', 'tests/native/knowledge-journey.host.test.ts'],
  ]);
  for (const path of paths) {
    const source = readFileSync(resolve(import.meta.dir, '..', path.nativeHost), 'utf8');
    expect(source).toContain('nativeTest(');
    expect(source).toContain('nativeBeforeAll(');
  }
  const walk = readFileSync(resolve(import.meta.dir, '../scripts/first-public-scope-walk.ts'), 'utf8');
  expect(walk).toContain("if ('nativeHost' in path)");
  expect(walk).toContain('acceptanceCommand');
  expect(walk).toContain('This seeded walk has no walker for this required journey');
  expect(walk).toContain("results.some((row) => row.status !== 'PASS')");
  expect(walk).not.toContain('${passing}/35');
});
