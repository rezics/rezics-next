import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseJUnit } from './acceptance.ts';
import { measuredBrowserStep, runPreparedJourneys, type BrowserStepResult } from './e2e.ts';
import type { JourneyPreparation } from './e2e-preparation.ts';

const preparation = (name: string): JourneyPreparation => ({
  journey: `apps/web/tests/${name}.e2e.ts`, command: ['bun', 'prepare.ts'],
  step: `Prepare ${name}`, slug: name, budgetMs: 1_000,
});

function fixture() {
  const parent = resolve(import.meta.dir, '../../.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'prepared-journeys-'));
  const journeys = join(root, 'apps/web/tests');
  mkdirSync(journeys, { recursive: true });
  return { root, artifactDir: root, results: () => parseJUnit(readFileSync(join(root, 'e2e.xml'), 'utf8'), 'e2e'),
    journey: (name: string) => writeFileSync(join(journeys, `${name}.e2e.ts`), ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('journey preparation isolation', () => {
  for (const error of ['Prepare first failed (1)', 'Prepare first exceeded its 1s budget']) {
    test(`${error}: the next preparation and journey run, with both file outcomes reported`, async () => {
      const f = fixture();
      try {
        const first = preparation('first'), second = preparation('second');
        const prepared: string[] = [], launched: (readonly string[])[] = [], steps: BrowserStepResult[] = [];
        const failures = await runPreparedJourneys([first, second], [first.journey, second.journey, '--project', 'chromium'], {
          root: f.root, artifactDir: f.artifactDir,
          prepare: async item => {
            await measuredBrowserStep(item.step, item.budgetMs, async () => {
              prepared.push(item.journey);
              if (item === first) throw new Error(error);
            }, { root: f.root, env: { CI: '1' }, deadline: Date.now() + 10_000, record: result => steps.push(result) });
          },
          playwright: async args => {
            launched.push(args);
            writeFileSync(join(f.artifactDir, 'e2e.xml'), `<testsuites><testsuite tests="1"><testcase name="second journey" classname="second.e2e.ts" time="1" /></testsuite></testsuites>`);
          },
        });
        expect(prepared).toEqual([first.journey, second.journey]);
        expect(launched).toEqual([['--project', 'chromium', second.journey]]);
        expect(failures).toEqual([{ preparation: first, error }]);
        expect(steps.map(step => step.passed)).toEqual([false, true]);
        expect(f.results()).toEqual([
          expect.objectContaining({ file: second.journey, failed: false }),
          expect.objectContaining({ file: first.journey, name: first.step, failed: true, skipped: false,
            detail: `${first.step}: ${error}; see logs/e2e-first.log` }),
        ]);
        // The tier uses this condition even when every launched test passed.
        expect(failures.length > 0).toBe(true);
      } finally { f.cleanup(); }
    });
  }

  test('when every selected preparation fails, both files fail without starting Playwright', async () => {
    const f = fixture();
    try {
      const preparations = [preparation('first'), preparation('second')];
      let launches = 0;
      const failures = await runPreparedJourneys(preparations, preparations.map(item => item.journey), {
        root: f.root, artifactDir: f.artifactDir,
        prepare: async item => { throw new Error(`${item.step} failed (1)`); },
        playwright: async () => { launches++; },
      });
      expect(launches).toBe(0);
      expect(failures).toHaveLength(2);
      expect(f.results().map(result => ({ file: result.file, failed: result.failed, detail: result.detail }))).toEqual(
        preparations.map(item => ({ file: item.journey, failed: true,
          detail: `${item.step}: ${item.step} failed (1); see logs/e2e-${item.slug}.log` })),
      );
    } finally { f.cleanup(); }
  });

  test('a full tier still runs undeclared journeys and filters matching path forms', async () => {
    const f = fixture();
    try {
      f.journey('first'); f.journey('second'); f.journey('unprepared');
      const first = preparation('first'), second = preparation('second');
      for (const args of [[], ['./apps/web/tests/first.e2e.ts', join(f.root, second.journey), 'unprepared.e2e.ts']]) {
        let launched: readonly string[] = [];
        await runPreparedJourneys([first, second], args, {
          root: f.root, artifactDir: f.artifactDir,
          prepare: async item => { if (item === first) throw new Error('denied'); },
          playwright: async remaining => { launched = remaining; writeFileSync(join(f.artifactDir, 'e2e.xml'), '<testsuites />'); },
        });
        expect(launched).toEqual(args.length ? [join(f.root, second.journey), 'unprepared.e2e.ts']
          : [second.journey, 'apps/web/tests/unprepared.e2e.ts']);
      }
    } finally { f.cleanup(); }
  });

  test('a Playwright error still leaves preparation failures beside its partial report', async () => {
    const f = fixture();
    try {
      const first = preparation('first'), second = preparation('second');
      await expect(runPreparedJourneys([first], [first.journey, second.journey], {
        root: f.root, artifactDir: f.artifactDir,
        prepare: async () => { throw new Error('denied <403> & "closed"'); },
        playwright: async () => {
          writeFileSync(join(f.artifactDir, 'e2e.xml'), `<testsuites><testsuite><testcase name="second" classname="second.e2e.ts"><failure message="browser failed" /></testcase></testsuite></testsuites>`);
          throw new Error('Playwright failed (1)');
        },
      })).rejects.toThrow('Playwright failed (1)');
      expect(f.results()).toEqual([
        expect.objectContaining({ file: second.journey, failed: true, detail: 'browser failed' }),
        expect.objectContaining({ file: first.journey, failed: true,
          detail: 'Prepare first: denied <403> & "closed"; see logs/e2e-first.log' }),
      ]);
    } finally { f.cleanup(); }
  });

  test('successful preparations retain the original selection and Playwright report', async () => {
    const f = fixture();
    try {
      const first = preparation('first');
      const args = [first.journey, '--project', 'chromium'];
      const xml = '<testsuites><testsuite><testcase name="first" classname="first.e2e.ts" /></testsuite></testsuites>';
      let launched: readonly string[] = [];
      expect(await runPreparedJourneys([first], args, {
        root: f.root, artifactDir: f.artifactDir, prepare: async () => {},
        playwright: async remaining => { launched = remaining; writeFileSync(join(f.artifactDir, 'e2e.xml'), xml); },
      })).toEqual([]);
      expect(launched).toEqual(args);
      expect(readFileSync(join(f.artifactDir, 'e2e.xml'), 'utf8')).toBe(xml);
    } finally { f.cleanup(); }
  });
});
