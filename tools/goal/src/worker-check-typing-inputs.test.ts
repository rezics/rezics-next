import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  beginTypingInputReceipt,
  readTypingInputReceipt,
  typingInputsMatch,
  typingInputCommand,
  captureTypingInputs,
  qualifyTypingInputs,
  kernelClientTypingPipeline,
  isKnownTypingCompiler,
  resolveTypingCompilerCommand,
} from './worker-check-typing-inputs.ts';
import {
  admitWorkerCheckHostRun,
  recordWorkerCheckTypingInputs,
  settleWorkerCheckHostBudget,
  workerCheckHostTypingSettlement,
} from './worker-check-budget.ts';
import { KERNEL_CLIENT_OUTPUT, outputTreeDigest, restoreOutputTree } from '../../../scripts/check-output-tree.ts';

const roots: string[] = [];
const physical = 'a1a1a1a1-1111-4111-8111-111111111111';
const command = ['bun', 'scripts/typecheck.ts'];
const environment = {
  REZICS_TYPING_INPUTS_PHYSICAL: physical,
  REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(command)).toString('base64'),
};
function write(root: string, file: string, value: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), value);
}
function fixture() {
  const parent = join(import.meta.dir, '../../../.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'typing-inputs-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'typing@example.invalid');
  git('config', 'user.name', 'Typing');
  write(root, '.gitignore', '.temp/\n**/generated/\napps/web/src/paraglide/\n');
  write(root, 'apps/web/tsconfig.json', '{"include":["src/**/*.ts"]}');
  write(root, 'apps/web/src/placeholder.ts', 'export const ready = true;');
  write(root, 'package.json', '{"name":"fixture"}');
  write(root, 'bun.lock', 'dependency identity');
  write(root, 'tsconfig.base.json', '{"compilerOptions":{"strict":true}}');
  write(
    root,
    'packages/fixture/package.json',
    JSON.stringify({ scripts: { typecheck: 'bun check --no-script -p tsconfig.json' } }),
  );
  write(
    root,
    'packages/fixture/tsconfig.json',
    JSON.stringify({
      extends: '../../tsconfig.base.json',
      include: ['src/**/*.ts', 'generated/**/*.d.ts'],
    }),
  );
  write(root, 'packages/fixture/src/source.ts', 'export const source = 1;');
  write(root, 'packages/fixture/src/query.sql', 'SELECT 1;');
  write(root, 'packages/fixture/generated/binding.d.ts', 'export type Entry = string;');
  write(root, 'packages/fixture/custom.input', 'custom generator input');
  write(root, 'docs/ledger.md', '# Evidence\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return root;
}
function passed(root: string) {
  const complete = beginTypingInputReceipt(root, environment, command)!;
  complete(0);
  return readTypingInputReceipt(root, physical, command)!;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('ledger-only edits keep configured typing evidence; imported Markdown stays a compiler input', () => {
  const root = fixture();
  const complete = beginTypingInputReceipt(root, environment, command)!;
  write(root, 'apps/web/src/paraglide/runtime.d.ts', 'export type Locale = string;');
  complete(0);
  const receipt = readTypingInputReceipt(root, physical, command)!;
  expect(receipt.sourceStable).toBe(true);
  expect(receipt.completed.profile).toBe('configured-typescript');
  expect(receipt.completed.excludedDocuments).toContain('docs/ledger.md');
  write(root, 'docs/ledger.md', '# Evidence\nAn observed pass.\n');
  expect(typingInputsMatch(root, receipt)).toBe(true);
  write(root, 'packages/fixture/src/source.ts', "import note from '../../../docs/ledger.md'; export default note;");
  const imported = passed(root);
  expect(imported.completed.excludedDocuments).not.toContain('docs/ledger.md');
  write(root, 'docs/ledger.md', '# Changed imported asset\n');
  expect(typingInputsMatch(root, imported)).toBe(false);
});

test('source, compiler configuration, generated declarations, SQL, dependencies and custom inputs invalidate evidence', () => {
  const root = fixture();
  const receipt = passed(root);
  expect(typingInputsMatch(root, receipt)).toBe(true);
  for (const file of [
    'packages/fixture/src/source.ts',
    'tsconfig.base.json',
    'packages/fixture/tsconfig.json',
    'packages/fixture/generated/binding.d.ts',
    'packages/fixture/src/query.sql',
    'bun.lock',
    'packages/fixture/package.json',
    'packages/fixture/custom.input',
  ]) {
    const original = readFileSync(join(root, file), 'utf8');
    const changed = file.endsWith('.json') ? original.replace(/}$/, ', "changed":true}') : `${original}\n/* change */`;
    write(root, file, changed);
    expect(typingInputsMatch(root, receipt), file).toBe(false);
    write(root, file, original);
  }
  write(root, 'packages/fixture/src/new-source.ts', 'export const added = 1;');
  expect(typingInputsMatch(root, receipt)).toBe(false);
});

test('unknown compiler commands retain documents and source edits during execution cannot stamp a false pass', () => {
  const root = fixture();
  write(root, 'packages/fixture/package.json', '{"scripts":{"typecheck":"bun custom-compiler.ts"}}');
  const custom = passed(root);
  expect(custom.completed.profile).toBe('conservative');
  write(root, 'docs/ledger.md', '# A custom compiler might read this\n');
  expect(typingInputsMatch(root, custom)).toBe(false);
  const complete = beginTypingInputReceipt(root, environment, command)!;
  write(root, 'packages/fixture/src/source.ts', 'export const changedWhileRunning = 1;');
  complete(0);
  const changed = readTypingInputReceipt(root, physical, command)!;
  expect(changed.sourceStable).toBe(false);
  expect(typingInputsMatch(root, changed)).toBe(false);
  expect(() => readTypingInputReceipt(root, physical, [...command, '--different'])).toThrow('binding');
});

test('budget settlement consumes invocation/physical-bound compiler evidence and makes missing closure explicit', () => {
  const root = fixture();
  const budget = join(root, '.temp/budget');
  const env = { ...environment, GOAL_WORKER_CHECK_BUDGET_DIR: budget, GOAL_WORKER_CHECK_BUDGET_STAMP: '1' };
  admitWorkerCheckHostRun({ directory: budget, worktree: root, limit: 2 });
  recordWorkerCheckTypingInputs(env, root, physical, command);
  passed(root);
  settleWorkerCheckHostBudget(env, 0, true, { argv: command, worktree: root, physicalRunId: physical });
  write(root, 'docs/ledger.md', '# Recorded evidence\n');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toEqual({ ok: true });
  write(root, 'packages/fixture/src/query.sql', 'SELECT 2;');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 }).ok).toBe(false);
  // A later physical run cannot borrow the previous receipt or silently fall back to a legacy content stamp.
  const next = 'a2a2a2a2-2222-4222-8222-222222222222';
  recordWorkerCheckTypingInputs(env, root, next, command);
  settleWorkerCheckHostBudget(env, 0, true, { argv: command, worktree: root, physicalRunId: next });
  const missing = workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.result).toContain('Compiler input closure is unavailable');
});

test.each(['local', 'remote-return'] as const)(
  'physical %s capture covers the retained workspace command even when its compiler predates receipts',
  (placement) => {
    const root = fixture();
    const workspaceCommand = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
    write(root, 'services/kernel/package.json', JSON.stringify({ scripts: { typecheck: 'bun scripts/typecheck.ts' } }));
    write(root, 'services/kernel/scripts/typecheck.ts', 'console.log("kernel typecheck completed");');
    const request = {
      ...environment,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(workspaceCommand)).toString('base64'),
    };
    // The exact old entrypoint succeeds without producing the artifact demanded by the wrapper.
    expect(Bun.spawnSync(workspaceCommand, { cwd: root, env: { ...process.env, ...request } }).exitCode).toBe(0);
    expect(readTypingInputReceipt(root, physical, workspaceCommand)).toBeUndefined();
    const result = Bun.spawnSync([process.execPath, ...typingInputCommand(workspaceCommand).slice(1)], {
      cwd: root,
      env: { ...process.env, ...request },
    });
    expect(result.exitCode).toBe(0);
    const receipt = readTypingInputReceipt(root, physical, workspaceCommand)!;
    expect(receipt).toMatchObject({
      physicalRunId: physical,
      command: workspaceCommand,
      compilerCommand: workspaceCommand,
      exitCode: 0,
      sourceStable: true,
    });
    if (placement === 'remote-return') {
      const returned = JSON.stringify(receipt);
      rmSync(join(root, `.temp/goal/checks/typing-inputs/${physical}.json`));
      write(root, `.temp/goal/checks/typing-inputs/${physical}.json`, returned);
    }
    const current = captureTypingInputs(root, workspaceCommand);
    expect(current.runtime).toBe(receipt.completed.runtime);
    expect(current.source).toEqual(receipt.completed.source);
    expect(current.prepared).toEqual(receipt.completed.prepared);
    expect(typingInputsMatch(root, readTypingInputReceipt(root, physical, workspaceCommand)!)).toBe(true);
    write(
      root,
      'services/kernel/scripts/typecheck.ts',
      'console.error("error TS2322: invalid source"); process.exit(1);',
    );
    const failedPhysical = 'a2a2a2a2-2222-4222-8222-222222222222';
    const failed = Bun.spawnSync([process.execPath, ...typingInputCommand(workspaceCommand).slice(1)], {
      cwd: root,
      env: { ...process.env, ...request, REZICS_TYPING_INPUTS_PHYSICAL: failedPhysical },
    });
    expect(failed.exitCode).toBe(1);
    expect(new TextDecoder().decode(failed.stderr)).toContain('error TS2322');
    expect(readTypingInputReceipt(root, failedPhysical, workspaceCommand)?.exitCode).toBe(1);
  },
);

test('legacy missing workspace receipt reuses only the exact successful full tree and prepared dependencies', () => {
  const root = fixture();
  write(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { fixture: '1' } }));
  write(root, 'node_modules/fixture/package.json', '{"version":"1"}');
  const budget = join(root, '.temp/budget');
  const workspaceCommand = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
  const env = { GOAL_WORKER_CHECK_BUDGET_DIR: budget, GOAL_WORKER_CHECK_BUDGET_STAMP: '1' };
  admitWorkerCheckHostRun({ directory: budget, worktree: root, limit: 2 });
  recordWorkerCheckTypingInputs(env, root, physical, workspaceCommand);
  const stampFile = join(budget, '1');
  const legacy = JSON.parse(readFileSync(stampFile, 'utf8'));
  delete legacy.typingRequest.capture;
  writeFileSync(stampFile, JSON.stringify(legacy));
  settleWorkerCheckHostBudget(env, 0, true, { argv: workspaceCommand, worktree: root, physicalRunId: physical });
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toEqual({ ok: true });
  write(root, 'node_modules/fixture/package.json', '{"version":"2"}');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toMatchObject({
    ok: false,
    kind: 'evidence-unavailable',
  });
  write(root, 'node_modules/fixture/package.json', '{"version":"1"}');
  write(root, 'packages/fixture/src/source.ts', 'export const changed = true;');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toMatchObject({
    ok: false,
    kind: 'evidence-unavailable',
  });
});

test('shared capture preserves the owning compiler verdict when a later check fails', () => {
  const root = fixture();
  write(
    root,
    'tools/goal/src/worker-check-typing-inputs.ts',
    readFileSync(join(import.meta.dir, 'worker-check-typing-inputs.ts'), 'utf8'),
  );
  write(
    root,
    'scripts/typecheck.ts',
    `import { beginTypingInputReceipt } from '../tools/goal/src/worker-check-typing-inputs.ts';
    beginTypingInputReceipt(process.cwd(), process.env, ['bun', 'scripts/typecheck.ts'])?.(0);`,
  );
  const composite = ['sh', '-c', `${process.execPath} scripts/typecheck.ts; exit 1`];
  const run = Bun.spawnSync([process.execPath, ...typingInputCommand(composite).slice(1)], {
    cwd: root,
    env: {
      ...process.env,
      ...environment,
      REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(composite)).toString('base64'),
    },
  });
  expect(run.exitCode).toBe(1);
  const receipt = readTypingInputReceipt(root, physical, composite)!;
  expect(receipt.exitCode).toBe(0);
  expect(receipt.compilerCommand).toEqual(['bun', 'scripts/typecheck.ts']);
});

test('a rejected artifact cannot borrow legacy compatibility and malformed evidence is distinct from source failure', () => {
  const root = fixture();
  const budget = join(root, '.temp/budget');
  const env = { ...environment, GOAL_WORKER_CHECK_BUDGET_DIR: budget, GOAL_WORKER_CHECK_BUDGET_STAMP: '1' };
  admitWorkerCheckHostRun({ directory: budget, worktree: root, limit: 2 });
  recordWorkerCheckTypingInputs(env, root, physical, command);
  const stampFile = join(budget, '1');
  const legacy = JSON.parse(readFileSync(stampFile, 'utf8'));
  delete legacy.typingRequest.capture;
  writeFileSync(stampFile, JSON.stringify(legacy));
  const receipt = passed(root);
  write(
    root,
    `.temp/goal/checks/typing-inputs/${physical}.json`,
    JSON.stringify({ ...receipt, command: ['wrong-command'] }),
  );
  settleWorkerCheckHostBudget(env, 0, true, { argv: command, worktree: root, physicalRunId: physical });
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toMatchObject({
    ok: false,
    kind: 'evidence-unavailable',
  });
  writeFileSync(stampFile, 'unreadable receipt record');
  expect(workerCheckHostTypingSettlement({ directory: budget, worktree: root, limit: 2 })).toMatchObject({
    ok: false,
    kind: 'evidence-unavailable',
  });
});
const clientPipeline = [
  'sh',
  '-c',
  'bun run --cwd services/kernel typecheck --emit-client && bun run --cwd packages/client typecheck',
];
function pipelineFixture() {
  const root = fixture();
  write(root, '.gitignore', readFileSync(join(root, '.gitignore'), 'utf8') + '\n**/node_modules/\n');
  write(root, 'services/kernel/package.json', JSON.stringify({ scripts: { typecheck: 'bun scripts/typecheck.ts' } }));
  write(
    root,
    'packages/client/package.json',
    JSON.stringify({
      scripts: { typecheck: 'bun check --no-script -p tsconfig.json' },
      dependencies: { fixture: '1' },
    }),
  );
  write(root, 'packages/client/node_modules/fixture/package.json', '{"version":"1"}');
  write(
    root,
    'packages/client/tsconfig.json',
    '{"compilerOptions":{"strict":true,"noEmit":true,"types":[],"skipLibCheck":true},"include":["src"]}',
  );
  write(root, 'packages/client/src/kernel/current.d.ts', 'export type Current = "old";');
  write(
    root,
    'packages/client/src/index.ts',
    'import type {Current} from "./kernel/current"; const value: Current = "current";',
  );
  const owner = join(import.meta.dir, '../../../scripts/check-output-tree.ts');
  write(
    root,
    'services/kernel/scripts/typecheck.ts',
    `import {rmSync,mkdirSync,writeFileSync} from 'node:fs';
    import {resolve} from 'node:path'; import {withKernelClientOutput} from ${JSON.stringify(owner)};
    const root=resolve(process.cwd(),'../..');
    process.exit(await withKernelClientOutput(root,async()=>{
      rmSync(root+'/packages/client/src/kernel',{recursive:true,force:true});
      mkdirSync(root+'/packages/client/src/kernel',{recursive:true});
      writeFileSync(root+'/packages/client/src/kernel/current.d.ts','export type Current = "current";');
      return 0;
    },{recognize:()=>({outcome:'admitted',runId:'pipeline-owner-run',scope:'fixture.scope',supervisor:{pid:1,started:'1',group:1}}),
      prepared:()=>({host:'c',run:'pipeline-owner-run',sourceSha256:'a'.repeat(64)})}));`,
  );
  mkdirSync(join(root, '.temp/bin'), { recursive: true });
  // Keep the exact owner command chain while using a tiny compiler fixture, without the product Kernel stack.
  const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');
  write(
    root,
    '.temp/bin/bun',
    `#!${process.execPath}
    import {spawnSync} from 'node:child_process';
    const args=process.argv.slice(2);
    const kernel=JSON.stringify(args)===JSON.stringify(['run','--cwd','services/kernel','typecheck','--emit-client']);
    const client=JSON.stringify(args)===JSON.stringify(['run','--cwd','packages/client','typecheck']);
    if(!kernel&&!client) throw new Error('Unexpected fixture command');
    const result=spawnSync(${JSON.stringify(process.execPath)},kernel?['scripts/typecheck.ts','--emit-client']:[${JSON.stringify(compiler)},'-p','tsconfig.json'],
      {cwd:process.cwd()+(kernel?'/services/kernel':'/packages/client'),stdio:'inherit',env:process.env});
    process.exit(result.status??1);
  `,
  );
  chmodSync(join(root, '.temp/bin/bun'), 0o755);
  return root;
}

test('known Kernel emission followed by consumer typing qualifies only the received atomic output tree', () => {
  const root = pipelineFixture();
  expect(kernelClientTypingPipeline(root, clientPipeline)).toBe(true);
  const env = {
    ...environment,
    PATH: `${join(root, '.temp/bin')}:${process.env.PATH}`,
    REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(clientPipeline)).toString('base64'),
  };
  const result = Bun.spawnSync([process.execPath, ...typingInputCommand(clientPipeline).slice(1)], {
    cwd: root,
    env: { ...process.env, ...env },
  });
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr));
  expect(result.exitCode).toBe(0);
  const receipt = readTypingInputReceipt(root, physical, clientPipeline)!;
  expect(receipt.outputs).toEqual(['kernel-client-v1']);
  expect(receipt.sourceStable).toBe(true);
  expect(qualifyTypingInputs(root, receipt)).toBe('evidence-unavailable');
  const bytes = readFileSync(join(root, KERNEL_CLIENT_OUTPUT.transport));
  restoreOutputTree(root, bytes, {
    host: 'c',
    run: 'pipeline-owner-run',
    sourceSha256: 'a'.repeat(64),
    exitCode: 0,
    bundleSha256: outputTreeDigest(bytes),
  });
  expect(qualifyTypingInputs(root, receipt)).toBe('matched');
  write(root, 'packages/client/node_modules/fixture/package.json', '{"version":"2"}');
  expect(qualifyTypingInputs(root, receipt)).toBe('prepared-changed');
  write(root, 'packages/client/node_modules/fixture/package.json', '{"version":"1"}');

  expect(
    qualifyTypingInputs(root, {
      ...receipt,
      completed: { ...receipt.completed, runtime: 'another evaluator' },
    }),
  ).toBe('evidence-unavailable');
  write(root, 'packages/client/src/kernel/current.d.ts', 'export type Current = "tampered";');
  expect(qualifyTypingInputs(root, receipt)).toBe('evidence-unavailable');
});

test('legacy pipeline generation is missing proof, while unknown compilers and real input changes never qualify', () => {
  const root = pipelineFixture();
  const env = {
    ...environment,
    REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(clientPipeline)).toString('base64'),
  };
  const complete = beginTypingInputReceipt(root, env, clientPipeline)!;
  write(root, 'packages/client/src/kernel/current.d.ts', 'export type Current = "current";');
  complete(0);
  const receipt = readTypingInputReceipt(root, physical, clientPipeline)!;
  const legacy = { ...receipt, sourceStable: false };
  delete legacy.outputs;
  expect(qualifyTypingInputs(root, legacy)).toBe('evidence-unavailable');
  const budget = join(root, '.temp/budget');
  admitWorkerCheckHostRun({ directory: budget, worktree: root, limit: 2 });
  write(
    root,
    '.temp/budget/1',
    JSON.stringify({
      exitCode: 0,
      includedTypecheck: true,
      typingRequest: {
        physicalRunId: physical,
        command: clientPipeline,
        localPrepared: [],
        capture: 'physical-command',
      },
      typingInputs: legacy,
    }),
  );
  expect(
    workerCheckHostTypingSettlement({
      directory: budget,
      worktree: root,
      limit: 2,
    }),
  ).toMatchObject({
    ok: false,
    kind: 'evidence-unavailable',
  });
  for (const file of ['packages/client/src/index.ts', 'tsconfig.base.json', 'bun.lock']) {
    const old = readFileSync(join(root, file), 'utf8');
    write(root, file, old + '\nchanged');
    expect(qualifyTypingInputs(root, receipt)).toBe('source-changed');
    write(root, file, old);
  }
  const custom = ['sh', '-c', 'bun arbitrary-generator.ts && bun run --cwd packages/client typecheck'];
  expect(kernelClientTypingPipeline(root, custom)).toBe(false);
  const customComplete = beginTypingInputReceipt(root, env, custom)!;
  write(root, 'packages/client/src/kernel/current.d.ts', 'export type Current = "custom";');
  customComplete(0);
  const customReceipt = readTypingInputReceipt(root, physical, clientPipeline)!;
  expect(customReceipt.sourceStable).toBe(false);
  expect(qualifyTypingInputs(root, customReceipt)).toBe('source-changed');
});

function standardFixture() {
  const root = fixture();
  for (const workspace of ['services/kernel', 'services/auth', 'apps/web']) {
    write(
      root,
      `${workspace}/package.json`,
      JSON.stringify({
        scripts: { typecheck: 'bun scripts/typecheck.ts' },
        dependencies: { fixture: '1' },
      }),
    );
    write(root, `${workspace}/node_modules/fixture/package.json`, '{"version":"1"}');
    write(
      root,
      `${workspace}/tsconfig.json`,
      `{
      // The installed compiler expands this real mapper-bearing owner config without executing the mapper.
      "extends":"../../tsconfig.base.json", "contentMappers":[{"package":"reylo","extensions":[".sql"]}],
      "compilerOptions":{"resolveJsonModule":true}, "include":["src","scripts"]
    }`,
    );
    write(root, `${workspace}/src/index.ts`, 'export const ready = true;');
    write(root, `${workspace}/src/query.sql`, 'SELECT 1;');
    write(root, `${workspace}/scripts/typecheck.ts`, 'export const compiler = true;');
  }
  write(root, 'tools/unrelated.ts', 'const glob = "**/*.md";');
  for (const file of [
    '.temp/continuation/owner.md',
    '.temp/search-walk/persona.log',
    '.temp/search-walk/census.json',
  ]) {
    write(root, file, file.endsWith('.json') ? '{"phase":"remote"}' : 'remote operational artifact');
    execFileSync('git', ['add', '-f', file], { cwd: root });
  }
  return root;
}

test('typing recovery canonicalizes only a recognized misordered workspace compiler intent', () => {
  const root = standardFixture();
  const misordered = ['bun', '--cwd', 'services/kernel', 'run', 'typecheck'];
  expect(isKnownTypingCompiler(root, misordered)).toBe(false);
  expect(resolveTypingCompilerCommand(root, misordered)).toEqual([
    'bun',
    'run',
    '--cwd',
    'services/kernel',
    'typecheck',
  ]);
  expect(resolveTypingCompilerCommand(root, ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'])).toEqual([
    'bun',
    'run',
    '--cwd',
    'services/kernel',
    'typecheck',
  ]);
  expect(resolveTypingCompilerCommand(root, ['bun', '--cwd', 'unknown', 'run', 'typecheck'])).toBeUndefined();
});

test.each(['services/kernel', 'services/auth', 'apps/web', 'chain'])(
  'standard %s typing ignores only unconsumed operational state and retains real inputs',
  (workspace) => {
    const root = standardFixture();
    const command =
      workspace === 'chain'
        ? [
            'sh',
            '-c',
            'bun run --cwd services/kernel typecheck && bun run --cwd services/auth typecheck && bun run --cwd apps/web typecheck',
          ]
        : ['bun', 'run', '--cwd', workspace, 'typecheck'];
    for (const file of ['.preparation-started', '.remote-check-supervisor', 'preparation-install.json'])
      write(root, file, 'remote identity');
    const complete = beginTypingInputReceipt(
      root,
      {
        ...environment,
        REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(command)).toString('base64'),
      },
      command,
    )!;
    for (const file of ['.preparation-started', '.remote-check-supervisor', 'preparation-install.json'])
      rmSync(join(root, file));
    rmSync(join(root, '.temp/search-walk/persona.log'));
    write(root, '.temp/search-walk/census.json', '{"phase":"controller"}');
    write(root, '.temp/continuation/owner.md', 'controller operational artifact');
    write(root, 'docs/ledger.md', 'unrelated decision');
    complete(0);
    const receipt = readTypingInputReceipt(root, physical, command)!;
    expect(receipt.completed.profile).toBe('configured-typescript');
    expect(receipt.sourceStable).toBe(true);
    expect(typingInputsMatch(root, receipt)).toBe(true);
    const owner = workspace === 'chain' ? 'services/kernel' : workspace;
    for (const file of [
      `${owner}/src/index.ts`,
      `${owner}/src/query.sql`,
      `${owner}/tsconfig.json`,
      'bun.lock',
      `${owner}/node_modules/fixture/package.json`,
    ]) {
      const prior = readFileSync(join(root, file), 'utf8');
      write(root, file, prior + '\n ');
      expect(typingInputsMatch(root, receipt), file).toBe(false);
      write(root, file, prior);
    }
    expect(
      qualifyTypingInputs(root, {
        ...receipt,
        completed: { ...receipt.completed, runtime: 'another compiler runtime' },
      }),
    ).toBe('evidence-unavailable');
  },
);

test('standard owner graph retains imported operational fixtures and static generator assets', () => {
  const root = standardFixture();
  const command = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
  write(
    root,
    'services/kernel/tsconfig.json',
    JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { resolveJsonModule: true, paths: { '@fixture/*': ['../../.temp/search-walk/*'] } },
      include: ['src', 'scripts'],
    }),
  );
  write(root, '.temp/search-walk/alias.json', '{"compiled":true}');
  execFileSync('git', ['add', '-f', '.temp/search-walk/alias.json'], { cwd: root });
  write(root, 'services/kernel/src/alias.ts', 'import state from "@fixture/alias.json"; export default state;');
  write(
    root,
    'services/kernel/src/index.ts',
    'import state from "../../../.temp/search-walk/census.json"; export default state;',
  );
  write(
    root,
    'services/kernel/scripts/typecheck.ts',
    'import {readFileSync} from "node:fs"; readFileSync(".temp/search-walk/persona.log");',
  );
  const complete = beginTypingInputReceipt(
    root,
    { ...environment, REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(command)).toString('base64') },
    command,
  )!;
  complete(0);
  const receipt = readTypingInputReceipt(root, physical, command)!;
  expect(receipt.completed.source.map((entry) => entry.path)).toEqual(
    expect.arrayContaining(['.temp/search-walk/census.json', '.temp/search-walk/persona.log']),
  );
  for (const file of [
    '.temp/search-walk/census.json',
    '.temp/search-walk/persona.log',
    '.temp/search-walk/alias.json',
  ]) {
    const before = readFileSync(join(root, file), 'utf8');
    write(root, file, before + ' ');
    expect(typingInputsMatch(root, receipt)).toBe(false);
    write(root, file, before);
  }
});

test('custom shells, undeclared generators and custom mappers retain conservative operational inputs', () => {
  const root = standardFixture();
  const standard = ['bun', 'run', '--cwd', 'services/kernel', 'typecheck'];
  for (const command of [
    ['sh', '-c', 'bun run --cwd services/kernel typecheck; bun run --cwd apps/web typecheck'],
    ['sh', '-c', 'bun custom-generator.ts && bun run --cwd services/kernel typecheck'],
    ['sh', '-c', 'bun scripts/typecheck.ts ; bun custom-generator.ts'],
    [...standard, '--emit-client'],
  ]) {
    const inputs = captureTypingInputs(root, command);
    expect(inputs.profile).toBe('conservative');
    expect(inputs.source.some((entry) => entry.path === '.temp/search-walk/persona.log')).toBe(true);
  }
  write(root, 'services/kernel/package.json', '{"scripts":{"typecheck":"bun custom-generator.ts"}}');
  expect(captureTypingInputs(root, standard).profile).toBe('conservative');
  write(
    root,
    'services/kernel/package.json',
    '{"scripts":{"typecheck":"bun scripts/typecheck.ts","generate":"bun undeclared-generator.ts"}}',
  );
  expect(captureTypingInputs(root, standard).profile).toBe('conservative');
  write(root, 'services/kernel/package.json', '{"scripts":{"typecheck":"bun scripts/typecheck.ts"}}');
  write(root, 'tsconfig.base.json', '{"contentMappers":[{"package":"custom","extensions":[".md"]}]}');
  const unknownMapper = captureTypingInputs(root, standard);
  expect(unknownMapper.profile).toBe('conservative');
  expect(unknownMapper.source.some((entry) => entry.path === '.temp/search-walk/persona.log')).toBe(true);
});
