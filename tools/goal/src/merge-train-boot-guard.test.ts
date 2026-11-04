import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import defaults from '../defaults.json';
import { landingBootCommand } from './merge-train.ts';
import { integrationHarness } from './test-support.ts';

const boot = defaults.devLandingBoot;
const kernelFile = 'services/kernel/src/entry.ts';
const docsFile = 'docs/note.md';

test('the landing boot paths and command come from policy', () => {
  expect(boot).toEqual({
    paths: ['services/kernel/**', 'services/auth/**', 'packages/**'],
    command: ['bun', 'test', 'services/kernel/test/boot'],
  });
  expect(landingBootCommand([kernelFile], boot)).toEqual(boot.command);
  expect(landingBootCommand(['services/auth/src/host.ts'], boot)).toEqual(boot.command);
  expect(landingBootCommand(['packages/ui/src/a.ts'], boot)).toEqual(boot.command);
  expect(landingBootCommand([docsFile], boot)).toBeUndefined();
  expect(landingBootCommand([kernelFile], { paths: ['docs/**'], command: ['boot-fixture'] })).toBeUndefined();
  expect(landingBootCommand([docsFile], { paths: ['docs/**'], command: ['boot-fixture'] })).toEqual(['boot-fixture']);
});

test('a kernel batch runs the policy boot check after typecheck on the combined candidate', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    h.settings.integration.devPrelandingTypecheck = true;
    Object.assign(h.settings, {
      devLandingBoot: { paths: ['services/kernel/**'], command: ['boot-fixture'] },
    });
    const kernel = h.dispatch(kernelFile);
    const docs = h.dispatch(docsFile);
    await h.start(kernel);
    await h.start(docs);
    const commands: string[][] = [];
    await h.train(async (command) => {
      commands.push([...command]);
      return { passed: true, output: '', timedOut: false };
    });
    expect(commands[0]?.some((part) => part.includes('scripts/typecheck.ts'))).toBe(true);
    expect(commands[0]).toContain('TYPECHECK_LOCAL=1');
    expect(commands[0]?.some((part) => /^TYPECHECK_DEV_COMMIT=[0-9a-f]{40}$/.test(part))).toBe(true);
    expect(commands[0]?.some((part) => /^TYPECHECK_CANDIDATE_COMMIT=[0-9a-f]{40}$/.test(part))).toBe(true);
    expect(commands[1]).toEqual(['boot-fixture']);
    expect(commands).toHaveLength(2);
    expect(h.outcomes.map(({ passed }) => passed)).toEqual([true, true]);
    const log = readFileSync(h.outcomes.find(({ taskId }) => taskId === kernel.id)!.logPath, 'utf8');
    expect(log).toMatch(/Boot check passed in \d+ms/);
  } finally {
    h.dispose();
  }
}, 60_000);

test('a failing boot check leaves dev unchanged and returns the error to the responsible task', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    Object.assign(h.settings, {
      devLandingBoot: { paths: ['services/kernel/**'], command: ['boot-fixture'] },
    });
    const kernel = h.dispatch(kernelFile);
    const docs = h.dispatch(docsFile);
    await h.start(kernel);
    await h.start(docs);
    const base = h.head('dev');
    const error = "ReferenceError: Cannot access 'IDEMPOTENCY_HEADER' before initialization";
    let bootRuns = 0;
    await h.train(async (command) => {
      if (command[0] === 'boot-fixture') {
        bootRuns += 1;
        return bootRuns === 1
          ? { passed: false, output: `${error}\n`, timedOut: false }
          : { passed: true, output: '', timedOut: false };
      }
      return { passed: false, output: `Unexpected preintegration check: ${command.join(' ')}`, timedOut: false };
    });
    expect(h.head('dev')).toBe(base);
    expect(bootRuns).toBe(2);
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([[kernel.id, false]]);
    expect(h.outcomes.some(({ taskId }) => taskId === docs.id)).toBe(false);
    expect(h.outcomes[0]!.failedCommand).toEqual(['boot-fixture']);
    expect(h.outcomes[0]!.firstFailure?.excerpt).toContain(error);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Required boot check failed');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a candidate may keep or reduce boot failures already present on its dev base', async () => {
  const baseErrors = 'ReferenceError: Existing kernel failure A\nTypeError: Existing kernel failure B\n';
  for (const candidateErrors of [baseErrors, 'ReferenceError: Existing kernel failure A\n']) {
    const h = integrationHarness();
    try {
      h.ensureDev();
      h.settings.integration.batchSize = 2;
      Object.assign(h.settings, {
        devLandingBoot: { paths: ['services/kernel/**'], command: ['boot-fixture'] },
      });
      const kernel = h.dispatch(kernelFile);
      const docs = h.dispatch(docsFile);
      await h.start(kernel);
      await h.start(docs);
      const base = h.head('dev');
      let bootRuns = 0;
      await h.train(async (command) => {
        if (command[0] === 'boot-fixture') {
          bootRuns += 1;
          return bootRuns === 1
            ? { passed: false, output: candidateErrors, timedOut: false }
            : { passed: false, output: baseErrors, timedOut: false };
        }
        return { passed: true, output: '', timedOut: false };
      });
      expect(bootRuns).toBe(2);
      expect(h.head('dev')).not.toBe(base);
      expect(h.outcomes.map(({ passed }) => passed)).toEqual([true, true]);
      expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain(
        'Candidate boot failures are already present on dev base',
      );
    } finally {
      h.dispose();
    }
  }
}, 60_000);

test('a batch that touches none of the policy boot paths does not run it', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    Object.assign(h.settings, {
      devLandingBoot: { paths: [...boot.paths], command: ['boot-fixture'] },
    });
    const first = h.dispatch(docsFile);
    const second = h.dispatch('apps/web/src/page.ts');
    await h.start(first);
    await h.start(second);
    const commands: string[][] = [];
    await h.train(async (command) => {
      commands.push([...command]);
      return { passed: true, output: '', timedOut: false };
    });
    expect(commands.some((command) => command[0] === 'boot-fixture')).toBe(false);
    expect(h.outcomes.map(({ passed }) => passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
}, 60_000);
