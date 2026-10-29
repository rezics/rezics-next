import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

function commitFixture(h: ReturnType<typeof integrationHarness>, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(h.root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  git(h.root, 'add', '.');
  git(h.root, 'commit', '-m', 'Add generated file fixtures');
}

const source = 'services/kernel/src/fixture.ts';
const declaration = 'packages/client/src/kernel/fixture.d.ts';
const openapi = 'contracts/openapi.json';

test('a dev landing regenerates declared outputs from changed inputs in its landing commit', async () => {
  const h = integrationHarness();
  try {
    commitFixture(h, {
      [source]: 'initial',
      [declaration]: 'stale declaration',
      [openapi]: 'stale contract',
    });
    h.ensureDev();
    const generator = join(h.settings.stateDirectory, 'regenerate.mjs');
    writeFileSync(
      generator,
      `import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync(${JSON.stringify(source)}, 'utf8');
writeFileSync(${JSON.stringify(declaration)}, 'declaration: ' + source);
writeFileSync(${JSON.stringify(openapi)}, 'contract: ' + source);
`,
    );
    h.settings.derivedFiles = [
      { path: declaration, stage: 'promotion', command: [process.execPath, generator], inputs: ['services/kernel/**'] },
      { path: openapi, stage: 'promotion', command: [process.execPath, generator], inputs: ['services/kernel/**'] },
    ];
    const task = h.dispatch(source);
    await h.start(task);
    await h.train(undefined, false);

    const landing = h.outcomes[0]?.mergedCommit;
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(landing).toBeTruthy();
    expect(git(h.root, 'show', `dev:${declaration}`)).toBe(`declaration: ${source}`);
    expect(git(h.root, 'show', `dev:${openapi}`)).toBe(`contract: ${source}`);
    expect(git(h.root, 'show', '--pretty=format:', '--name-only', landing!)).toEqual(
      expect.stringContaining(`${declaration}\n`),
    );
    expect(git(h.root, 'show', '--pretty=format:', '--name-only', landing!)).toContain(openapi);
    expect(git(h.root, 'show', '--pretty=format:', '--name-only', landing!)).toContain(source);
  } finally {
    h.dispose();
  }
});

test('unchanged dev outputs add no commit and promotion still regenerates and verifies them', async () => {
  const h = integrationHarness();
  try {
    commitFixture(h, {
      [source]: 'initial',
      [declaration]: 'stable declaration',
      [openapi]: 'stable contract',
    });
    h.ensureDev();
    const generator = join(h.settings.stateDirectory, 'regenerate-stable.mjs');
    writeFileSync(
      generator,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(declaration)}, 'stable declaration');
writeFileSync(${JSON.stringify(openapi)}, 'stable contract');
`,
    );
    h.settings.derivedFiles = [
      { path: declaration, stage: 'promotion', command: [process.execPath, generator], inputs: ['services/kernel/**'] },
      { path: openapi, stage: 'promotion', command: [process.execPath, generator], inputs: ['services/kernel/**'] },
    ];
    const task = h.dispatch(source);
    await h.start(task);
    await h.train(undefined, false);
    const integrated = h.head();
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.mergedCommit).toBe(integrated);

    const checkedHeads: string[] = [];
    await h.promote(async (_command, cwd) => {
      checkedHeads.push(git(cwd, 'rev-parse', 'HEAD'));
      const valid =
        readFileSync(join(cwd, declaration), 'utf8') === 'stable declaration' &&
        readFileSync(join(cwd, openapi), 'utf8') === 'stable contract';
      return { passed: valid, output: valid ? '' : 'AssertionError: derived output is stale', timedOut: false };
    });

    expect(h.head()).toBe(integrated);
    expect(h.head('main')).toBe(integrated);
    expect(checkedHeads.length).toBeGreaterThan(0);
    expect(new Set(checkedHeads)).toEqual(new Set([integrated]));
    expect(readFileSync(join(h.root, declaration), 'utf8')).toBe('stable declaration');
  } finally {
    h.dispose();
  }
});
