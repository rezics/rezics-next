import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript-6';
import { admissionWaitDuration, qaStartupTestTimeout, runQaAdmissionChildAsync, runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { commandAsync } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });

test('startup case clocks allow admission until the inherited run deadline', () => {
  const deadline = Date.now() + 600_000;
  expect(qaStartupTestTimeout(180_000, { REZICS_STACK_PROFILE: 'qa',
    REZICS_QA_MEMORY_DEADLINE: String(deadline) })).toBeGreaterThan(590_000);
  expect(qaStartupTestTimeout(180_000, { REZICS_STACK_PROFILE: 'dev',
    REZICS_QA_MEMORY_DEADLINE: 'invalid' })).toBe(180_000);
  expect(qaStartupTestTimeout(180_000, { REZICS_STACK_PROFILE: 'qa',
    REZICS_QA_MEMORY_DEADLINE: String(Date.now() + 1000) })).toBe(180_000);
});

test('startup parents allow admission past the child work budget and exclude that wait', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-startup-parent-'));
  try {
    mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'dev', 'cli.ts'), `
      if (process.env.REZICS_STACK_PROFILE === 'dev') {
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
    const devEnv = { ...process.env, REZICS_STACK_PROFILE: 'dev',
      REZICS_QA_MEMORY_DEADLINE: 'invalid', REZICS_QA_MEMORY_EVENTS: '1' };
    const inheritedEvents = await runQaAdmissionChildAsync(dir, 'bun', ['scripts/dev/cli.ts', 'stack:up'], 100, devEnv);
    expect(inheritedEvents.ok).toBe(true);
    expect(inheritedEvents.admissionWaitMs).toBe(0);
    const devClone = await runQaStartupChildAsync(dir, ['stack:clone'], 100, devEnv);
    expect(devClone.ok).toBe(true);
    expect(devClone.admissionWaitMs).toBe(0);
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

test('a wrapped test startup streams a four-minute injected memory wait within its run deadline', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-startup-nested-'));
  try {
    mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'dev', 'cli.ts'), `
      import { waitForMemory } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
      let now = Date.now(), reads = 0;
      await waitForMemory({ vm: 2, host: 1, hostReserve: 0, vmReserve: 0 }, {
        env: process.env, deadline: Number(process.env.REZICS_QA_MEMORY_DEADLINE),
        now: () => now, pollMs: 240000, announce: () => {},
        read: async () => ({ vmTotal: 10, vmUsed: reads++ === 0 ? 10 : 0, hostAvailable: 10 }),
        sleep: async ms => { await Bun.sleep(600); now += ms; },
      });
      if (reads !== 2) throw new Error('Memory did not become available after four minutes');
      await Bun.sleep(20);
      console.log('grandchild ready');
    `);
    writeFileSync(join(dir, 'parent.test.ts'), `
      import { test } from 'bun:test';
      import { qaStartupTestTimeout, runQaAdmissionChildAsync, runQaStartupChildAsync } from ${JSON.stringify(join(root, 'scripts/qa/stack-startup.ts'))};
      test('wrapped startup', async () => {
        const result = process.env.STARTUP_BOUNDARY === 'indirect'
          ? await runQaAdmissionChildAsync(${JSON.stringify(dir)}, 'bun', ['scripts/dev/cli.ts', 'stack:up'], 400)
          : await runQaStartupChildAsync(${JSON.stringify(dir)}, ['stack:up'], 400);
        if (!result.ok) throw new Error(result.output);
        console.log('parent ready');
      }, qaStartupTestTimeout(400));
    `);
    const deadline = Date.now() + 300_000;
    for (const boundary of ['direct', 'indirect']) {
    const result = await commandAsync(dir, 'bun', ['test', 'parent.test.ts'], 400,
      { ...process.env, STARTUP_BOUNDARY: boundary, REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_EVENTS: '1',
        REZICS_QA_MEMORY_DEADLINE: String(deadline) }, undefined, { runDeadline: deadline });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('parent ready');
    expect(result.output).toMatch(/QA_MEMORY_WAIT_END \d+-\d+ 240000/);
    expect(result.admissionWaitMs).toBeGreaterThanOrEqual(500);
    expect(result.activeElapsedMs).toBeLessThan(400);
    }
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
        && (containsCall(parent.whenTrue, 'runQaStartupChildAsync')
          || containsCall(parent.whenTrue, 'runQaAdmissionChildAsync'))) return true;
    }
    return false;
  };
  const unsafe: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (!['runQaStartupChildAsync', 'runQaAdmissionChildAsync', 'commandAsync'].includes(name)) {
        const values = node.arguments.flatMap(argument => strings(argument));
        const indirectStartup = path.startsWith('tests/qa/') && (values.some(value => [
          'scripts/load/search-probe.ts', 'scripts/load/practical.ts', 'scripts/load/restore.ts',
          'scripts/load/clone-probe.ts', 'scripts/load/catalogue-backup.ts', 'scripts/fixture/cli.ts',
          'scripts/operations/rebuild-content-search.ts',
        ].includes(value)) || values.includes('scripts/dev/release-artifact.ts') && values.includes('install'));
        const dynamic = node.arguments.some(argument => containsCall(argument, 'scriptCommand'));
        const inline = values.some(value => /\bbun\s+\S*scripts\/dev\/cli\.ts\s+stack:(up|clone)\b/.test(value));
        const actions = dynamic || inline ? ['stack:up', 'stack:clone'] : startup(values);
        const child = dynamic || inline || values.includes('bun') && values.some(value => value.endsWith('scripts/dev/cli.ts'));
        if (values.includes('bun') && indirectStartup
          || child && actions.length && !safeFallback(node, actions)) unsafe.push(node.getText(source));
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
    `spawnSync('bun',['scripts/load/search-probe.ts'],{timeout:145000})`,
  ]) expect(unsafeStartupWraps('tests/qa/unsafe.ts', text).length).toBeGreaterThan(0);
  expect(unsafeStartupWraps('safe.ts', `function start(action:'stack:up'|'stack:down') {
    const args=['scripts/dev/cli.ts',action];
    return action==='stack:up' ? runQaStartupChildAsync(root,args,180000) : spawnSync('bun',args);
  }`)).toEqual([]);
  expect(unsafeStartupWraps('safe.ts', `runQaAdmissionChildAsync(root,...scriptCommand(args),180000)`)).toEqual([]);
  expect(unsafeStartupWraps('tests/qa/safe.ts',
    `spawnSync('bun',['scripts/dev/release-artifact.ts','build'])`)).toEqual([]);
});

test('indirect startup entry points use a streaming parent in QA tests', () => {
  for (const path of ['tests/qa/integration/fresh-install.test.ts',
    'tests/qa/load/search-phase-d.test.ts', 'tests/qa/load/ops-phase-d.test.ts']) {
    const text = readFileSync(join(root, path), 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const unsafe: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ['spawnSync', 'execFileSync'].includes(node.expression.getText(source))) {
        if (node.arguments.some(argument => /scripts\/(?:load|fixture|ops)\/|scriptCommand/.test(argument.getText(source))))
          unsafe.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(unsafe).toEqual([]);
    expect(text).toContain('qaStartupTestTimeout');
  }
});

test('all authored scripts and QA tests route dev startup children through the admission-aware parent', () => {
  const unsafe: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !['scripts/qa/stack-startup.ts',
        'tests/qa/unit/stack-startup-parent.test.ts'].includes(path)) {
        for (const call of unsafeStartupWraps(path, readFileSync(join(root, path), 'utf8'))) unsafe.push(`${path}: ${call}`);
      }
    }
  };
  walk('scripts');
  walk('tests/qa');
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
