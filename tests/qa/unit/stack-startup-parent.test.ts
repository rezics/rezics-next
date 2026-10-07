import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-6';
import { admissionWaitDuration, runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { commandAsync } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });

test('startup parents allow admission past the child work budget and exclude that wait', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-startup-parent-'));
  try {
    mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'dev', 'cli.ts'), `
      if (process.env.REZICS_STACK_PROFILE === 'dev') {
        if (process.env.REZICS_QA_MEMORY_EVENTS !== undefined) throw new Error('Dev enabled QA events');
        console.log('Dev ready');
        process.exit(0);
      }
      if (process.env.REZICS_QA_MEMORY_EVENTS !== '1') throw new Error('Missing admission events');
      const deadline = Number(process.env.REZICS_QA_MEMORY_DEADLINE);
      if (deadline <= Date.now() + 100) throw new Error('Missing admission deadline');
      const token = process.pid + '-1';
      console.log('QA_MEMORY_WAIT_BEGIN ' + token);
      const waitStarted = Date.now();
      await Bun.sleep(150);
      console.log('QA_MEMORY_WAIT_END ' + token + ' ' + (Date.now() - waitStarted));
      await Bun.sleep(30);
      console.log('Compose ready');
    `);
    const result = await runQaStartupChildAsync(dir, ['stack:up'], 100,
      { ...process.env, REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: String(Date.now() + 2_000) });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Compose ready');
    expect(result.admissionWaitMs).toBeGreaterThanOrEqual(100);
    expect(result.activeElapsedMs).toBeGreaterThanOrEqual(30);
    expect(result.activeElapsedMs).toBeLessThan(1_000);

    const lines: string[] = [];
    const streamed = await runQaStartupChildAsync(dir, ['stack:up'], 100,
      { ...process.env, REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: String(Date.now() + 2_000) },
      line => { lines.push(line); });
    expect(streamed.ok).toBe(true);
    expect(streamed.admissionWaitMs).toBeGreaterThanOrEqual(100);
    expect(streamed.activeElapsedMs).toBeGreaterThanOrEqual(30);
    expect(lines).toContain('Compose ready');

    const bypass = await runQaStartupChildAsync(dir, ['stack:up'], 100,
      { ...process.env, REZICS_STACK_PROFILE: 'dev', REZICS_QA_MEMORY_DEADLINE: 'invalid', REZICS_QA_MEMORY_EVENTS: undefined });
    expect(bypass.ok).toBe(true);
    expect(bypass.output).toContain('Dev ready');
    expect(bypass.admissionWaitMs).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('child admission duration counts distinct startup tokens once', () => {
  expect(admissionWaitDuration('QA_MEMORY_WAIT_END 12-1 400000\nQA_MEMORY_WAIT_END 12-1 400000\n'
    + 'QA_MEMORY_WAIT_END 12-2 300000\n')).toBe(700_000);
});

test('clone keeps its active copying budget after a longer admission wait', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-clone-active-'));
  try {
    mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'dev', 'cli.ts'), `
      const token = process.pid + '-1';
      console.log('QA_MEMORY_WAIT_BEGIN ' + token);
      await Bun.sleep(400);
      console.log('QA_MEMORY_WAIT_END ' + token + ' 400');
      await Bun.sleep(1000);
    `);
    const result = await runQaStartupChildAsync(dir, ['stack:clone'], 200,
      { ...process.env, REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: String(Date.now() + 2000) });
    expect(result.timedOut).toBe(true);
    expect(result.admissionWaitMs).toBeGreaterThanOrEqual(350);
    expect(result.activeElapsedMs).toBeLessThan(350);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a bounded outer runner sees a grandchild admission begin before the wait finishes', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-startup-nested-'));
  try {
    mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'dev', 'cli.ts'), `
      const token = process.pid + '-1';
      console.log('QA_MEMORY_WAIT_BEGIN ' + token);
      const started = Date.now();
      await Bun.sleep(600);
      console.log('QA_MEMORY_WAIT_END ' + token + ' ' + (Date.now() - started));
      await Bun.sleep(20);
      console.log('grandchild ready');
    `);
    writeFileSync(join(dir, 'parent.ts'), `
      import { runQaStartupChildAsync } from ${JSON.stringify(join(root, 'scripts/qa/stack-startup.ts'))};
      const result = await runQaStartupChildAsync(${JSON.stringify(dir)}, ['stack:up'], 400);
      if (!result.ok) throw new Error(result.output);
      console.log('parent ready');
    `);
    const deadline = Date.now() + 4_000;
    const result = await commandAsync(dir, 'bun', ['parent.ts'], 400,
      { ...process.env, REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_EVENTS: '1',
        REZICS_QA_MEMORY_DEADLINE: String(deadline) }, undefined, { runDeadline: deadline });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('parent ready');
    expect(result.admissionWaitMs).toBeGreaterThanOrEqual(500);
    expect(result.activeElapsedMs).toBeLessThan(400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function unsafeStartupWraps(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scopes = new Map<ts.Node, Map<string, ts.Node[]>>();
  const scope = (node: ts.Node): ts.Node => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (ts.isBlock(parent) || ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return parent;
    return source;
  };
  const bind = (node: ts.Node, name: ts.BindingName, value?: ts.Node) => {
    if (!value || !ts.isIdentifier(name)) return;
    const owner = scope(node), bindings = scopes.get(owner) ?? new Map<string, ts.Node[]>();
    bindings.set(name.text, [...bindings.get(name.text) ?? [], value]);
    scopes.set(owner, bindings);
  };
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const loop = node.parent.parent;
      bind(node, node.name, node.initializer ?? (ts.isForOfStatement(loop) ? loop.expression : undefined));
    }
    if (ts.isParameter(node)) bind(node, node.name, node.type);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const strings = (node: ts.Node, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) return [];
    seen.add(node);
    // Process results are output data; only argument/path builders propagate
    // launch strings through their return values.
    if (ts.isCallExpression(node) && !['scriptCommand', 'join', 'resolve'].includes(node.expression.getText(source))) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node)) {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        const values = scopes.get(parent)?.get(node.text);
        if (values) return values.flatMap(value => strings(value, seen));
      }
    }
    return node.getChildren(source).flatMap(child => strings(child, seen));
  };
  const startup = (values: string[]) => values.filter(value => value === 'stack:up' || value === 'stack:clone');
  const containsCall = (node: ts.Node, name: string): boolean => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) return true;
    return node.getChildren(source).some(child => containsCall(child, name));
  };
  const safeFallback = (node: ts.Node, actions: string[]): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isConditionalExpression(parent) || node.pos < parent.whenFalse.pos || node.end > parent.whenFalse.end) continue;
      const conditionValues = [...strings(parent.condition), ...parent.condition.getChildren(source).flatMap(child => strings(child))];
      if (actions.every(action => conditionValues.includes(action))
        && containsCall(parent.whenTrue, 'runQaStartupChildAsync')) return true;
    }
    return false;
  };
  const unsafe: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (name !== 'runQaStartupChildAsync') {
        const values = node.arguments.flatMap(argument => strings(argument));
        const dynamic = node.arguments.some(argument => containsCall(argument, 'scriptCommand'));
        const inline = values.some(value => /\bbun\s+\S*scripts\/dev\/cli\.ts\s+stack:(up|clone)\b/.test(value));
        const actions = dynamic || inline ? ['stack:up', 'stack:clone'] : startup(values);
        const child = dynamic || inline || values.includes('bun') && values.some(value => value.endsWith('scripts/dev/cli.ts'));
        if (child && actions.length && !safeFallback(node, actions)) unsafe.push(node.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return unsafe;
}

test('the startup guard resolves direct arguments, local arrays, typed actions and dynamic root commands', () => {
  for (const text of [
    `spawnSync('bun', ['scripts/dev/cli.ts', 'stack:up'], {timeout:180000})`,
    `const program='bun', args=['scripts/dev/cli.ts','stack:clone']; launch(program,args,180000)`,
    `function start(action:'stack:up'|'stack:down') { const args=['scripts/dev/cli.ts',action]; spawn('bun',args); }`,
    `function start(args:string[]) { spawnSync(...scriptCommand(args),{timeout:180000}); }`,
    `spawnSync('sh',['-c','bun scripts/dev/cli.ts stack:up'],{timeout:180000})`,
  ]) expect(unsafeStartupWraps('unsafe.ts', text).length).toBeGreaterThan(0);
  expect(unsafeStartupWraps('safe.ts', `function start(action:'stack:up'|'stack:down') {
    const args=['scripts/dev/cli.ts',action];
    return action==='stack:up' ? runQaStartupChildAsync(root,args,180000) : spawnSync('bun',args);
  }`)).toEqual([]);
});

test('all authored scripts route dev startup children through the admission-aware parent', () => {
  const unsafe: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && path !== 'scripts/qa/stack-startup.ts') {
        for (const call of unsafeStartupWraps(path, readFileSync(join(root, path), 'utf8'))) unsafe.push(`${path}: ${call}`);
      }
    }
  };
  walk('scripts');
  expect(unsafe).toEqual([]);
});

/** An architectural guard: admission-capable children use the shared parent boundary. */
for (const path of ['scripts/qa/api-fuzz.ts', 'scripts/load/cli.ts', 'scripts/load/search-probe.ts',
  'scripts/load/restore.ts', 'scripts/load/practical.ts', 'scripts/load/clone-probe.ts', 'scripts/dev/install.ts',
  'scripts/load/catalogue-backup.ts']) {
  test(`${path} routes admission-capable startup children through the parent boundary`, () => {
    const source = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let sharedCalls = 0;
    const unsafe: string[] = [];
    const startupLiteral = (node: ts.Node): boolean => {
      if (ts.isStringLiteral(node) && ['stack:up', 'stack:clone'].includes(node.text)) return true;
      return node.getChildren(source).some(startupLiteral);
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'runQaStartupChildAsync') sharedCalls++;
        if (node.expression.text === 'runQaStartupChild') unsafe.push(node.getText(source));
        if (node.expression.text === 'spawnSync' && node.arguments.some(startupLiteral)) unsafe.push(node.getText(source));
        if (node.expression.text === 'command' && node.arguments.some(startupLiteral)
          && path !== 'scripts/dev/install.ts') unsafe.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(sharedCalls).toBeGreaterThan(0);
    expect(unsafe).toEqual([]);
  });
}
