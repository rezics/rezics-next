import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJUnit } from '../qa/acceptance.ts';
import { assertionReached, reviewProof } from './review-proof.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(source: string, support: Record<string, string> = {}) {
  const scratch = join(import.meta.dir, '../../.temp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'review-proof-'));
  directories.push(directory);
  const file = 'fixture.test.ts';
  writeFileSync(join(directory, file), source);
  for (const [name, text] of Object.entries(support)) writeFileSync(join(directory, name), text);
  const result = spawnSync(process.execPath, ['test', `./${file}`, '--reporter=junit', '--reporter-outfile=tests.xml'],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1' }, timeout: 10_000 });
  expect(result.status, result.stderr).toBe(1);
  const tests = parseJUnit(readFileSync(join(directory, 'tests.xml'), 'utf8'), 'unit');
  writeFileSync(join(directory, 'test-result.json'), JSON.stringify({ artifactPaths: [directory] }));
  const report = (sourceStable = true, head = 'reviewed-head') => writeFileSync(join(directory, 'acceptance.json'),
    JSON.stringify({ sourceStable, source: { head }, tests }));
  report();
  return { directory, file, tests, report, proof: () => reviewProof(directory, [file], 'reviewed-head', directory) };
}

test('Bun stacks distinguish an outcome assertion from same-file helpers and setup throws', () => {
  const source = `import { expect, test } from 'bun:test';
function setup() { expect(403).toBe(201); }
test('setup helper', () => { setup(); expect(true).toBe(true); });
test('outcome assertion', () => { expect(200).toBe(403); });
test('setup request', async () => { await Promise.reject(new Error('authority_denied')); expect(true).toBe(true); });
test('nested setup helper', () => { const setup = () => { expect(403).toBe(201); }; setup(); });
`;
  const f = fixture(source);
  expect(f.tests).toHaveLength(4);
  expect(f.tests.map(test => assertionReached(test, source, f.directory))).toEqual(['no', 'yes', 'no', 'no']);
  expect(f.proof().results[f.file]).toBe('failed');
  expect(f.proof().failures.filter(test => test.assertionReached === 'yes').map(test => test.name)).toEqual(['outcome assertion']);
});

test('an imported setup helper cannot borrow its caller test body as assertion evidence', () => {
  const source = `import { expect, test } from 'bun:test';
import { setup } from './support.ts';
test('outcome', () => { setup(); expect(true).toBe(true); });`;
  const f = fixture(source, { 'support.ts': "import { expect } from 'bun:test'; export function setup() { expect(403).toBe(201); }" });
  expect(f.proof().results[f.file]).toBe('setup-failed');
  expect(f.proof().failures[0]?.assertionReached).toBe('no');
});

test('beforeEach assertions are setup; aliased parameterized outcome assertions still block', () => {
  const source = `import { expect as check, test as scenario, beforeEach } from 'bun:test';
beforeEach(() => { check(403).toBe(201); });
scenario('outcome', () => { check(true).toBe(true); });`;
  const setup = fixture(source);
  expect(setup.proof().results[setup.file]).toBe('setup-failed');
  const body = fixture(`import { expect as check, test as scenario } from 'bun:test';
scenario.each([200])('outcome %s', status => { check(status).toBe(403); });`);
  expect(body.proof().results[body.file]).toBe('failed');
});

test('missing locations, timeouts, unstable sources and another head stay unconfirmed', () => {
  const source = "import { expect, test } from 'bun:test'; test('outcome', () => { expect(200).toBe(403); });";
  const f = fixture(source);
  expect(assertionReached({ file: f.file, detail: 'Expected: 403 Received: 200' }, source, f.directory)).toBe('unknown');
  expect(assertionReached({ ...f.tests[0]!, timeout: true }, source, f.directory)).toBe('unknown');
  expect(assertionReached({ ...f.tests[0]!, stack: `at ${f.file}:1:99999` }, source, f.directory)).toBe('unknown');
  f.report(false);
  expect(f.proof().results[f.file]).toBe('unavailable');
  f.report(true, 'different-head');
  expect(f.proof().results[f.file]).toBe('unavailable');
});

test.each(['beforeEach', 'beforeAll', 'describe', 'step'])('test.%s does not turn a hook or helper into a test body', method => {
  const source = `import { test, expect } from '@playwright/test'; test.${method}('setup', () => { expect(403).toBe(201); });`;
  const column = source.indexOf('expect(403)') + 1;
  expect(assertionReached({ file: 'fixture.test.ts', detail: 'Expected: 201 Received: 403',
    stack: `at fixture.test.ts:1:${column}` }, source, '/tmp')).toBe('no');
});

test('the first admission review returns for publication setup on its recorded 403 response', () => {
  // Original review commit 286a027623; replay the observed HTTP response without needing the historical stack.
  const original = readFileSync(join(import.meta.dir, 'fixtures/search-placement-admission.ts.txt'), 'utf8');
  const source = original.replace('../../support/personas.ts', './personas.ts')
    .replace('../../support/persona-fixture-authority.ts', './authority.ts');
  const f = fixture(source, {
    'personas.ts': `export async function personaSessions() {
      return { owner: { actingSubject: 'fixture-owner', main: async (_method, path) => {
        if (path === '/v1/works') return Response.json({ work: 'fixture-work', mainVersion: 'fixture-main' }, { status: 201 });
        if (path === '/v1/contributions') return Response.json({ contribution: 'fixture-contribution', draftRevision: 'fixture-draft' }, { status: 201 });
        if (path === '/v1/contribution-publications') return Response.json({ error: 'authority_denied' }, { status: 403 });
        throw new Error('Unexpected request: ' + path);
      } }, visitor: {}, close: async () => {} };
    }`,
    'authority.ts': 'export async function grantPersonaFixtureAuthority() {}',
  });
  expect(f.tests).toHaveLength(1);
  expect(f.tests[0]?.detail).toContain('authority_denied');
  expect(f.tests[0]?.stack).toContain('at answer ');
  expect(f.proof().results[f.file]).toBe('setup-failed');
  expect(f.proof().failures[0]?.assertionReached).toBe('no');
});
