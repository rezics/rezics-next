import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  briefPathCloseness,
  controlPlaneReleaseBrief,
  classifyRiskAreas,
  devProductBrief,
  matchesPath,
  MAX_BRIEF_BYTES,
  parseBrief,
  pathsOverlap,
  productBriefSizeReturnReason,
  productBriefSizeViolation,
  readRiskOwnership,
  riskAreaRulesFor,
  validatePath,
} from './briefs.ts';
import { defaultPolicy } from './policy.ts';
import { workerCheckProtocol } from './launch.ts';
import { classifyTask } from './routing.ts';
import { harness, markdown } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

test('a brief over the diagnostic size budget is accepted with a lint warning', () => {
  expect(() => parseBrief(markdown, { version: 1, areas: {} })).not.toThrow();
  const big = `${markdown}\n${'x'.repeat(MAX_BRIEF_BYTES)}\n`;
  expect(parseBrief(big, { version: 1, areas: {} }).lintWarnings?.join('\n')).toContain(
    `diagnostic budget is ${MAX_BRIEF_BYTES} bytes`,
  );
});

test('authorization risk excludes local auth scripts while preserving production and overlapping ownership', () => {
  const ownership = readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));
  const authOnly = { version: 1 as const, areas: { authorization: ownership.areas.authorization! } };
  expect(classifyRiskAreas('services/auth/scripts/**', riskAreaRulesFor(authOnly), 'pattern')).toEqual([]);

  const tooling = markdown.replace('paths: [result.txt]', 'paths: [services/auth/scripts/dev-stack.ts]');
  expect(parseBrief(tooling, ownership).riskAreas).toEqual([]);

  const production = markdown.replace('paths: [result.txt]', 'paths: [services/auth/src/policy.ts]');
  expect(() => parseBrief(production, ownership)).toThrow('authorization');
  expect(parseBrief(production.replace('riskAreas: []', 'riskAreas: [authorization]'), ownership).riskAreas).toEqual([
    'authorization',
  ]);
  expect(() => parseBrief(markdown.replace('paths: [result.txt]', 'paths: [services/**]'), authOnly)).toThrow(
    'authorization',
  );

  const overlapping = {
    ...ownership,
    areas: { ...ownership.areas, disclosure: { include: ['services/auth/scripts/**'] } },
  };
  expect(classifyRiskAreas('services/auth/scripts/dev.ts', riskAreaRulesFor(overlapping), 'file')).toEqual([
    'disclosure',
  ]);
  expect(() => parseBrief(tooling, overlapping)).toThrow('disclosure');
  expect(parseBrief(tooling.replace('riskAreas: []', 'riskAreas: [disclosure]'), overlapping).riskAreas).toEqual([
    'disclosure',
  ]);

  const legacyOwnership = { version: 1 as const, areas: { authorization: ['**/auth/**'] } };
  expect(() => parseBrief(tooling, legacyOwnership)).toThrow('authorization');
});

test('acceptance placement is optional, typed, and restricts local checks to the audited command boundary', () => {
  const ownership = { version: 1 as const, areas: {} };
  const local = markdown.replace(
    '  command: [bun, test]',
    '  command: [bun, test, apps/web/tests/shell-menus.test.ts]\n  placement: local',
  );
  expect(parseBrief(local, ownership).acceptance.placement).toBe('local');
  expect(parseBrief(markdown, ownership).acceptance.placement).toBeUndefined();
  expect(
    parseBrief(markdown.replace('  command: [bun, test]', '  command: [bun, test]\n  placement: default'), ownership)
      .acceptance.placement,
  ).toBe('default');

  for (const invalid of [
    markdown.replace('  command: [bun, test]', '  command: [bun, test]\n  placement: remote'),
    markdown.replace('  command: [bun, test]', '  command: [bun, test]\n  placement: local'),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, services/kernel/scripts/check.ts]\n  placement: local',
    ),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, apps/web/tests/example.host.test.ts]\n  placement: local',
    ),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, --cwd, apps/web, test, tests/shell-menus.test.ts]\n  placement: local',
    ),
    markdown.replace(
      '  command: [bun, test]',
      '  command: [bun, test, tools/goal/src/briefs.test.ts]\n  placement: local',
    ),
  ]) {
    expect(() => parseBrief(invalid, ownership)).toThrow();
  }
});

test('local placement keeps the focused Web wrapper and its audited environment prefix', () => {
  const command = [
    'env',
    '-u',
    'KERNEL_ORIGIN',
    'PUBLIC_ORIGIN=http://127.0.0.1:3000',
    'bun',
    'apps/web/scripts/focused.ts',
    '--private-network',
    '--',
    'bun',
    'test',
    'tests/account-menu.test.ts',
    '-t',
    'signed-out action',
  ];
  const local = markdown.replace(
    '  command: [bun, test]',
    `  command: [${command.map((token) => JSON.stringify(token)).join(', ')}]\n  placement: local`,
  );
  const brief = parseBrief(local, { version: 1, areas: {} });
  expect(brief.acceptance.command).toEqual(command);
  expect(brief.acceptance.placement).toBe('local');

  const unsupported = local.replace('PUBLIC_ORIGIN=http://127.0.0.1:3000', 'CI=1');
  expect(() => parseBrief(unsupported, { version: 1, areas: {} })).toThrow();
});

test('ordinary dev outcome briefs keep their body and delegate validation when estimate and command are omitted', () => {
  const outcome = markdown
    .replace('acceptance:\n  command: [bun, test]\n  tests: [acceptance]\n  failing: true\n', '')
    .replace('estimate:\n  lines: 100\n  files: 4\n', '');
  const brief = parseBrief(outcome, { version: 1, areas: {} });
  expect(brief.markdown).toBe(outcome);
  expect(brief.estimate).toEqual({ lines: 1500, files: 24 });
  expect(brief.acceptance).toMatchObject({ command: [], tests: [], failing: true, workerOwned: true });
  expect(classifyTask(brief)).toBe('implementation');
  expect(
    parseBrief(outcome.replace('goal: fixture', 'goal: control-plane'), { version: 1, areas: {} }).acceptance
      .workerOwned,
  ).toBe(true);
  for (const field of ['citesSources', 'hostileInput'])
    expect(
      classifyTask(
        parseBrief(outcome.replace('riskAreas: []', `riskAreas: []\n${field}: true`), { version: 1, areas: {} }),
      ),
    ).toBe('claim');
  expect(workerCheckProtocol('/fixture', brief)).toContain('Choose or add a focused, meaningful check');
  expect(workerCheckProtocol('/fixture', brief)).toContain('no pass is presumed');
});

test('fixed acceptance and invalid contract diagnostics keep their explicit requirements', () => {
  expect(parseBrief(markdown, { version: 1, areas: {} }).acceptance.command).toEqual(['bun', 'test']);
  const outcome = markdown
    .replace('acceptance:\n  command: [bun, test]\n  tests: [acceptance]\n  failing: true\n', '')
    .replace('estimate:\n  lines: 100\n  files: 4\n', '');
  expect(() =>
    parseBrief(outcome.replace('goal: fixture', 'goal: control-plane\ntarget: main'), { version: 1, areas: {} }),
  ).toThrow('acceptance.command is required for main/stabilize releases');
  expect(() => parseBrief(markdown.replace('lines: 100', 'lines: many'), { version: 1, areas: {} })).toThrow(
    'estimate.lines must be a positive integer',
  );
  const controlPlane = markdown
    .replace('estimate:\n  lines: 100\n  files: 4\n', '')
    .replace('goal: fixture', 'goal: control-plane\ntarget: main');
  expect(() => parseBrief(controlPlane, { version: 1, areas: {} })).toThrow(
    'estimate is required for main/stabilize releases',
  );
  for (const fence of ['```', '````', '~~~'])
    expect(() =>
      parseBrief(`${outcome}\n${fence}ts path=result.test.ts\nexport {}\n${fence}`, { version: 1, areas: {} }),
    ).toThrow('acceptance.command is required');
  expect(() =>
    parseBrief(outcome.replace('riskAreas: []', 'acceptance: { placement: local }\nriskAreas: []'), {
      version: 1,
      areas: {},
    }),
  ).toThrow('acceptance.placement requires acceptance.command');
  expect(() => parseBrief(markdown.replace('  tests: [acceptance]\n', ''), { version: 1, areas: {} })).toThrow(
    'acceptance.tests is required',
  );
  expect(() =>
    classifyTask(parseBrief(markdown.replace('failing: true', 'failing: false'), { version: 1, areas: {} })),
  ).toThrow('failing acceptance tests');
});

test('verification briefs require typed proof metadata and reject source editing, frozen inputs and priority', () => {
  const proof = markdown
    .replace('kind: implementation', 'kind: verification')
    .replace('paths: [result.txt]', 'paths: []')
    .replace('estimate:\n  lines: 100\n  files: 4\n', '')
    .replace(
      'riskAreas: []',
      `riskAreas: []\nproof:\n  journey: Original journey\n  sourceTasks: [original]\n  sourceCommit: ${'a'.repeat(40)}`,
    );
  const ownership = { version: 1 as const, areas: {} };
  expect(parseBrief(proof, ownership).proof?.sourceTasks).toEqual(['original']);
  expect(() => parseBrief(proof.replace('  command: [bun, test]\n', ''), ownership)).toThrow(
    'acceptance.command is required for main/stabilize releases, verification, and frozen acceptance briefs',
  );
  for (const invalid of [
    proof.replace('paths: []', 'paths: [product.ts]'),
    proof.replace('criticalPath: false', 'criticalPath: true'),
    `${proof}\n\`\`\`ts path=product.ts\nexport const changed = true;\n\`\`\``,
    proof.replace('  journey: Original journey', '  authorized: true\n  journey: Original journey'),
    proof.replace('kind: verification', 'kind: implementation'),
  ])
    expect(() => parseBrief(invalid, ownership)).toThrow();
});

test('untargeted control-plane work is dev work; main targeting is reserved for control-plane releases', () => {
  const ownership = { version: 1 as const, areas: {} };
  const controlPlane = markdown.replace('goal: fixture', 'goal: control-plane');
  const dev = parseBrief(controlPlane, ownership);
  expect(dev.target).toBeUndefined();
  expect(controlPlaneReleaseBrief(dev)).toBe(false);
  expect(devProductBrief(dev)).toBe(true);
  for (const target of ['main', 'stabilize'] as const) {
    const release = parseBrief(
      controlPlane.replace('goal: control-plane', `goal: control-plane\ntarget: ${target}`),
      ownership,
    );
    expect(release.target).toBe(target);
    expect(controlPlaneReleaseBrief(release)).toBe(true);
    expect(devProductBrief(release)).toBe(false);
  }
  expect(() => parseBrief(markdown.replace('goal: fixture', 'goal: fixture\ntarget: main'), ownership)).toThrow(
    'only a control-plane brief can target main',
  );
});

test('Parsing and comparing supported long path patterns completes without stack overflow while preserving path scope semantics.', () => {
  const long = `src/${'a'.repeat(20_000)}.ts`;
  const wild = `src/${'a'.repeat(20_000)}*.ts`;
  const deep = `${'d/'.repeat(10_000)}file.ts`;
  expect(pathsOverlap(long, long)).toBe(true);
  expect(pathsOverlap(long, `src/${'b'.repeat(20_000)}.ts`)).toBe(false);
  expect(pathsOverlap(wild, `src/${'a'.repeat(20_000)}xx.ts`)).toBe(true);
  expect(pathsOverlap(deep, deep)).toBe(true);
  expect(pathsOverlap(`${'d/'.repeat(10_000)}**`, deep)).toBe(true);
  expect(pathsOverlap('src/a*.ts', 'src/*b.ts')).toBe(true);
  expect(pathsOverlap('src/*.ts', 'src/auth/**')).toBe(false);
  expect(pathsOverlap('src/**', 'src/auth/token.ts')).toBe(true);
  expect(pathsOverlap('src/?at.ts', 'src/cat.ts')).toBe(true);
  expect(matchesPath('src/file.ts', ['src/*.ts'])).toBe(true);
  expect(matchesPath(long, [long])).toBe(true);
  expect(() => validatePath('/abs')).toThrow('invalid declared path');
  expect(() => validatePath('../x')).toThrow('invalid declared path');
  expect(() => validatePath('a/**b')).toThrow('invalid declared path');
  expect(() => validatePath('a'.repeat(65_537))).toThrow('keep each pattern under 65536 characters');
  expect(() => pathsOverlap(`${'*a'.repeat(1_500)}x`, `${'*a'.repeat(1_500)}y`)).toThrow('supported bound');
  expect(parseBrief(markdown.replace('[result.txt]', `[${long}]`), { version: 1, areas: {} }).paths).toEqual([long]);
  expect(() =>
    parseBrief(markdown.replace('[result.txt]', `[src/auth/${'a'.repeat(20_000)}.ts]`), {
      version: 1,
      areas: { authorization: ['**/auth/**'] },
    }),
  ).toThrow('authorization');
});

test('the normal controller launches a short outcome and hands focused validation to its worker in minimal mode', async () => {
  const h = harness(`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('.temp/launched-prompt', process.argv.join('\\n'));
writeFileSync('result.txt', 'accepted');
const argv = ['bun', '-e', "if (await Bun.file('result.txt').text() !== 'accepted') process.exit(1)"];
const result = spawnSync(argv[0], argv.slice(1));
if (result.status !== 0) process.exit(1);
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete outcome']);
console.log(JSON.stringify({type:'thread.started',thread_id:'outcome-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:JSON.stringify({status:'success',summary:'Focused result validation exited 0: '+JSON.stringify(argv),blocker:null,checks:[],approaches:[]})}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
  try {
    const outcome =
      markdown.replace(/acceptance:[\s\S]*?criticalPath:/, 'criticalPath:') +
      '\nOwner: tools/goal/README.md. Done: result.txt contains accepted.\n';
    writeFileSync(h.briefFile, outcome);
    writeFileSync(join(h.settings.stateDirectory, 'verification-mode'), 'minimal\n');
    const landed: unknown[] = [];
    let id = '';
    expect(
      await runWorkerCommand('dispatch', [h.briefFile], {
        tasks: h.tasks,
        store: h.store,
        settings: h.settings,
        env: {},
        print: (value) => {
          id = value;
        },
        landing: {
          enqueue: (request) => {
            landed.push(request);
          },
        },
      }),
    ).toBe(0);
    const task = h.store.task(id);
    const prompt = readFileSync(join(task.worktree, '.temp/launched-prompt'), 'utf8');
    expect(task.brief.markdown).toBe(outcome);
    expect(prompt).toContain('Done: result.txt contains accepted.');
    expect(prompt).toContain('Choose or add focused tests that exercise the stated outcome');
    expect(prompt).toContain('missing acceptance command is not a pass');
    expect(landed).toHaveLength(1);
  } finally {
    await h.disposeAsync();
  }
});

test('product brief size returns use policy floors and exempt urgent research mechanical specification and continuation', () => {
  const policy = defaultPolicy.brief;
  expect(policy.minimumEstimateLines).toBe(1200);
  expect(policy.maximumBodyCharacters).toBe(4000);
  expect(productBriefSizeViolation(markdown)).toEqual({ estimateLines: 100 });
  expect(productBriefSizeReturnReason({ estimateLines: 100 }, policy)).toContain('brief.minimumEstimateLines is 1200');
  const complete = markdown.replace('lines: 100', `lines: ${policy.minimumEstimateLines}`);
  expect(productBriefSizeViolation(complete)).toBeUndefined();
  const omitted = markdown.replace('estimate:\n  lines: 100\n  files: 4\n', '');
  expect(productBriefSizeViolation(omitted)).toBeUndefined();
  const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(complete)![0];
  const atLimit = header + 'x'.repeat(policy.maximumBodyCharacters);
  expect(productBriefSizeViolation(atLimit)).toBeUndefined();
  const over = atLimit + 'y';
  expect(productBriefSizeViolation(over)).toEqual({ bodyCharacters: policy.maximumBodyCharacters + 1 });
  expect(productBriefSizeReturnReason({ bodyCharacters: policy.maximumBodyCharacters + 1 }, policy)).toContain(
    'brief.maximumBodyCharacters is 4000',
  );
  expect(
    productBriefSizeViolation(complete.replace('criticalPath: false', 'urgent: true\ncriticalPath: false')),
  ).toBeUndefined();
  for (const kind of ['research', 'mechanical', 'specification'] as const)
    expect(productBriefSizeViolation(markdown.replace('kind: implementation', `kind: ${kind}`))).toBeUndefined();
  expect(
    productBriefSizeViolation(
      markdown.replace('goal: fixture', 'goal: fixture\ncontinuation:\n  taskId: retained\n  expectedAttempt: 1'),
    ),
  ).toBeUndefined();
  expect(productBriefSizeViolation(markdown, policy, 'continuation-abcd-1-rest.md')).toBeUndefined();
  expect(
    productBriefSizeViolation(
      markdown.replace('kind: implementation', 'kind: verification').replace('paths: [result.txt]', 'paths: []'),
    ),
  ).toBeUndefined();
  expect(
    productBriefSizeViolation(markdown.replace('goal: fixture', 'goal: control-plane\ntarget: main')),
  ).toBeUndefined();
  expect(productBriefSizeViolation(complete, { ...policy, minimumEstimateLines: 2000 })).toEqual({
    estimateLines: 1200,
  });
  expect(briefPathCloseness(['tools/goal/src/backlog.ts'], ['tools/goal/src/briefs.ts'])).toBeGreaterThan(
    briefPathCloseness(['tools/goal/src/backlog.ts'], ['apps/web/src/page.ts']),
  );
});
