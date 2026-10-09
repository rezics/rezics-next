import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript-6';
import { GiB, waitForMemory } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const paths = ['tests/qa/fault-recovery/source-author-credit.test.ts',
  'tests/qa/fault-recovery/source-field-child.test.ts'];

/** Exercise the authored boundary without preparing its unrelated graph fixture. */
function preparationBoundary(path: string): string {
  const source = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stack = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'stack');
  let start: ts.VariableStatement | undefined, waiting: ts.VariableStatement | undefined;
  let loop: ts.ForOfStatement | undefined, assertion: ts.ExpressionStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'start'
          && declaration.initializer?.getText(source) === 'Date.now()') start = node;
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'admissionWaitMs') waiting = node;
      }
    }
    if (ts.isForOfStatement(node) && node.getText(source).includes("stack('stack:up'")) loop = node;
    if (ts.isExpressionStatement(node) && node.getText(source).startsWith('expect(Date.now() - start')) assertion = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!stack || !start || !waiting || !loop || !assertion) throw new Error(`Missing startup preparation boundary: ${path}`);
  return ts.transpileModule([stack, start, waiting, loop, assertion].map(node => node.getText(source)).join('\n')
    + '\nreturn { admissionWaitMs, elapsedMs: Date.now() - start, resetWaitMs: await stack("stack:reset", liveId) };',
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
}

for (const path of paths) {
  const boundary = preparationBoundary(path);
  const run = async (activeMs: number) => {
    let at = 0, starts = 0;
    const result = await new Script(`(async () => { ${boundary} })()`).runInNewContext({
      root, Date: { now: () => at }, expect, started: [], liveId: 'live', restoredId: 'restored',
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
      runQaAdmissionChildAsync: async () => ({ status: 0, stdout: '', stderr: '', admissionWaitMs: 0 }),
      runQaStartupChildAsync: async () => {
        starts++;
        let admissionWaitMs = 0;
        await waitForMemory({ vm: 2 * GiB, host: GiB, vmReserve: 0, hostReserve: 8 * GiB }, {
          env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 2_000_000, now: () => at, pollMs: 60_000,
          sleep: async ms => { at += ms; }, announce: () => {},
          read: async () => ({ vmTotal: 24 * GiB, vmUsed: at < 660_000 ? 24 * GiB : 0, hostAvailable: 20 * GiB }),
          onAdmissionWait: ms => { admissionWaitMs += ms; },
        });
        at += activeMs;
        return { status: 0, stdout: '', stderr: '', admissionWaitMs };
      },
    }) as { admissionWaitMs: number; elapsedMs: number; resetWaitMs: number };
    return { ...result, starts };
  };

  test(`${path}: preparation accepts eleven minutes waiting and one active minute`, async () => {
    expect(await run(30_000)).toEqual({ admissionWaitMs: 660_000, elapsedMs: 720_000, resetWaitMs: 0, starts: 2 });
  });

  test(`${path}: admission waiting does not hide active preparation over budget`, async () => {
    await expect(run(300_001)).rejects.toThrow();
  });
}
