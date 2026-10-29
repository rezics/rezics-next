import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBunCommand } from './gate.ts';
import { runScript } from './remote-check.ts';
import { resolveTypecheckCommand } from './typecheck.ts';
import { resolveRepositoryBun } from './worker-check.ts';

const root = resolve(import.meta.dir, '..');
const bun = join(root, 'node_modules/.bin/bun');
const oxfmt = join(root, 'node_modules/.bin/oxfmt');
const oxlint = join(root, 'node_modules/.bin/oxlint');
const tsc = join(root, 'node_modules/.bin/tsc');
mkdirSync(join(root, '.temp'), { recursive: true });
const directory = mkdtempSync(join(root, '.temp/toolchain-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(command: string[], stdin?: string) {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: result.exitCode,
    output: result.stdout.toString(),
    error: result.stderr.toString(),
  };
}

function format(program: string, filename: string, source: string): string {
  const result = run(
    [program, ...(program === bun ? ['fmt', '--no-script'] : []), '--stdin-filepath', filename],
    source,
  );
  expect(result.code, result.error).toBe(0);
  return result.output;
}

test('the repository and check-host provisioner pin the tested canary build', async () => {
  const manifest = await Bun.file(join(root, 'package.json')).json();
  expect(manifest.packageManager).toBe(`bun@${manifest.devDependencies.bun}`);
  const revision = run([bun, '--eval', 'console.log(Bun.revision)']);
  expect(revision.code).toBe(0);
  expect(revision.output.trim()).toBe('a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b');
  const provision = await Bun.file(join(root, 'scripts/provision-check-host.sh')).text();
  expect(provision).toContain(`bun_version=${manifest.devDependencies.bun}`);
  expect(provision).toContain('bun_revision=a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b');
});

test('the gate invokes the installed Bun explicitly instead of Bun.spawn selecting its caller', () => {
  const result = run(resolveBunCommand(['bun', '--revision'], root));
  expect(result.code, result.error).toBe(0);
  expect(result.output.trim()).toBe('1.4.4-canary.1+a0cc096ce');
  expect(resolveBunCommand(['bun', '--revision'], directory)).toEqual(['bun', '--revision']);
  expect(resolveBunCommand(['other-tool', '--version'], root)).toEqual(['other-tool', '--version']);
});

test('worker and remote checks select and verify the pinned repository Bun', async () => {
  const manifest = await Bun.file(join(root, 'package.json')).json();
  const workerCommand = resolveRepositoryBun(['bun', '--eval', 'console.log(Bun.revision)'], root);
  const worker = run(workerCommand);
  expect(worker.code, worker.error).toBe(0);
  expect(worker.output.trim()).toBe(Bun.revision);

  const typecheckCommand = resolveTypecheckCommand(['bun', '--eval', 'console.log(Bun.revision)'], root);
  const typecheckBun = run(typecheckCommand);
  expect(typecheckBun.code, typecheckBun.error).toBe(0);
  expect(typecheckBun.output.trim()).toBe(Bun.revision);

  const remote = runScript('run-id', '/srv/rezics-check/runs/run-id', '.', ['bun', 'test'], 'host-a');
  expect(remote).toContain(`expected_bun=${manifest.packageManager.slice(4)}`);
  expect(remote).toContain('Bun.revision === process.argv[1]');
  expect(remote).toContain('https://registry.npmjs.org/@oven/bun-linux-$build/-/bun-linux-$build-$expected_bun.tgz');
  expect(remote).toContain('"$PWD/.temp/pinned-bun/package/bin/bun"');
  expect(remote).toContain('"$bun" install --frozen-lockfile');
  expect(remote).not.toContain('/usr/local/bin/bun');
});

for (const [extension, source] of [
  ['ts', 'export const value={a:"hello", b:[1,2,3]};\n'],
  ['tsx', 'export const value = <button disabled={false}>Hello</button>;\n'],
  ['json', '{"b":2,"a":[1,2,3]}\n'],
  ['css', '.value{color:red;padding:0 1px}\n'],
  ['md', '# Heading\n\nA **short** paragraph.\n'],
]) {
  test(`Bun preserves current formatting on representative ${extension} input`, () => {
    const filename = `toolchain-fixture.${extension}`;
    const current = format(oxfmt, filename, source!);
    expect(format(bun, filename, current)).toBe(current);
  });
}

test('the formatter swap remains deferred for the two measured output differences', async () => {
  for (const filename of ['docs/research/throughput-audit-high.md', 'specs/imported-field-driver.ts']) {
    const current = format(oxfmt, filename, await Bun.file(join(root, filename)).text());
    expect(format(bun, filename, current)).not.toBe(current);
  }
});

type LintDiagnostic = {
  code: string;
  severity: string;
  labels: { span: { line: number; column: number } }[];
};
function diagnostics(output: string) {
  const parsed = JSON.parse(output) as { diagnostics: LintDiagnostic[] };
  return parsed.diagnostics.map(({ code, severity, labels }) => [code, severity, labels[0]?.span]).sort();
}

const lintCases = [
  ['no-debugger', 'export function witness() { debugger; }'],
  ['no-dupe-keys', 'export const witness = { a: 1, a: 2 };'],
  ['no-fallthrough', 'export function witness(x: number) { switch (x) { case 1: console.log(x); case 2: return x; } }'],
  ['no-unreachable', 'export function witness() { return; console.log("unreachable"); }'],
  ['eqeqeq', 'export function witness(x: unknown) { return x == 1; }'],
  ['no-unused-vars', 'export const witness = 1; const unused = 2;'],
  [
    'options',
    'export function witness(unused: unknown, value: { taken: number; kept: number }) { ' +
      'const { taken, ...rest } = value; const _ignored = 1; return [rest, value == null]; }',
  ],
];
for (const [rule, source] of lintCases) {
  test(`Bun lint preserves ${rule} and its configured options`, () => {
    const file = join(directory, `${rule}.ts`);
    writeFileSync(file, `${source}\n`);
    const args = ['--config', join(root, '.oxlintrc.json'), '--no-ignore', '--format', 'json', file];
    const current = run([oxlint, ...args]);
    const candidate = run([bun, 'lint', '--no-script', ...args]);
    const expected = rule === 'options' ? 0 : 1;
    expect(current.code, current.error).toBe(expected);
    expect(candidate.code, candidate.error).toBe(expected);
    expect(diagnostics(candidate.output)).toEqual(diagnostics(current.output));
    if (rule !== 'options') expect(current.output).toContain(`eslint(${rule})`);
  });
}

test('bun check preserves TypeScript diagnostics, strict options and imported types', () => {
  const project = join(directory, 'tsconfig.json');
  const source = join(directory, 'witness.ts');
  writeFileSync(
    project,
    JSON.stringify({ extends: join(root, 'tsconfig.base.json'), files: ['witness.ts', 'types.ts'] }),
  );
  writeFileSync(join(directory, 'types.ts'), 'export type Value = { label: string; optional?: string };\n');
  writeFileSync(
    source,
    "import type { Value } from './types.ts';\n" +
      'const invalid: Value = { label: 1 };\n' +
      'const exact: Value = { label: "ok", optional: undefined };\n' +
      'const indexed: string = ["ok"][1];\n' +
      'export { invalid, exact, indexed };\n',
  );
  const check = (program: string) =>
    run([
      program,
      ...(program === bun ? ['check', '--no-script', '--all', '--no-pretty'] : ['--noEmit', '--pretty', 'false']),
      '-p',
      project,
    ]);
  const current = check(tsc);
  const candidate = check(bun);
  const errors = (text: string) =>
    text
      .split('\n')
      .filter((line) => /: error TS\d+:/.test(line))
      .sort();
  expect(current.code, current.error).toBe(2);
  expect(candidate.code, candidate.error).not.toBe(0);
  expect(errors(candidate.output + candidate.error)).toEqual(errors(current.output + current.error));
  expect(errors(current.output)).toHaveLength(3);
  writeFileSync(source, "import type { Value } from './types.ts';\nexport const value: Value = { label: 'ok' };\n");
  expect(check(tsc).code).toBe(0);
  expect(check(bun).code).toBe(0);
});

for (const workspace of ['services/kernel', 'services/auth']) {
  test(`${workspace} retains tsc because Bun cannot run its SQL content mapper`, async () => {
    const manifest = await Bun.file(join(root, workspace, 'package.json')).json();
    expect(manifest.scripts.typecheck).toContain('tsc --noEmit --runExternalCode');
    const result = run([
      bun,
      'check',
      '--no-script',
      '--runExternalCode',
      '-p',
      join(root, workspace, 'tsconfig.json'),
    ]);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain('Unknown flag "--runExternalCode"');
  });
}
