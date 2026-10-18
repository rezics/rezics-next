import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { qaArtifactDirectory } from '../../../scripts/qa/core.ts';
import { STORY_SCREENSHOTS_ENV } from '../../../scripts/qa/story-screenshots.ts';
import { dispatchTest, selectTestCommand, selectTestGroups } from '../../../scripts/qa/test.ts';

const root = resolve(import.meta.dir, '../../..');
const directories: string[] = [];

function artifactRoot(): string {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'story-dispatch-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('one mixed unit and story invocation keeps sequential execution and story screenshot artifacts', async () => {
  const artifacts = artifactRoot();
  const unit = 'apps/web/features/tracking/series-progress-panel.test.tsx';
  const story = 'apps/web/features/tracking/edition-preference.stories.tsx';
  const groups = selectTestGroups([unit, story]);
  expect(groups.map(group => group.files)).toEqual([[unit], [story]]);
  let launches = 0;
  let admissions = 0;
  let screenshotDirectory = '';
  const code = await dispatchTest([unit, story], {
    env: { REZICS_STACK_PROFILE: 'qa', REZICS_QA_ARTIFACT_ROOT: artifacts },
    admission: async () => { admissions++; },
    runner: async (command, env) => {
      expect(command).toEqual(groups[launches]!.command);
      if (launches++ === 0) {
        expect(env?.[STORY_SCREENSHOTS_ENV]).toBeUndefined();
        return 1;
      }
      screenshotDirectory = env![STORY_SCREENSHOTS_ENV]!;
      expect(isAbsolute(screenshotDirectory)).toBe(true);
      expect(existsSync(screenshotDirectory)).toBe(true);
      return 0;
    },
  });
  expect(code).toBe(1);
  expect(launches).toBe(2);
  expect(admissions).toBe(1);
  const summary = readFileSync(join(dirname(screenshotDirectory), 'summary.md'), 'utf8');
  expect(summary).toContain(story);
  expect(summary).toContain('passed');
});

for (const workspace of ['apps/web', 'apps/accounts', 'packages/ui']) {
  test(`${workspace} story dispatch supplies an absolute screenshot artifact directory before launch`, async () => {
    const artifacts = artifactRoot();
    const file = [...new Bun.Glob(`${workspace}/**/*.stories.tsx`).scanSync({ cwd: root })][0]!;
    expect(file).toBeDefined();
    const args = [file, '--reporter=dot'];
    const expectedCode = workspace === 'apps/accounts' ? 7 : 0;
    let screenshots = '';
    const code = await dispatchTest(args, {
      env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts, STORY_DISPATCH_PARENT: 'retained' },
      admission: async () => { throw new Error('Production-profile stories need no QA admission'); },
      runner: async (command, env) => {
        expect(command).toEqual(selectTestCommand(args));
        expect(env?.STORY_DISPATCH_PARENT).toBe('retained');
        screenshots = env?.[STORY_SCREENSHOTS_ENV] ?? '';
        expect(isAbsolute(screenshots)).toBe(true);
        expect(basename(screenshots)).toBe('story-screenshots');
        expect(dirname(dirname(screenshots))).toBe(artifacts);
        expect(basename(dirname(screenshots))).toMatch(/^\d{8}t\d{6}-[a-f0-9]{6}$/);
        expect(existsSync(screenshots)).toBe(true);
        expect(readFileSync(join(dirname(screenshots), 'summary.md'), 'utf8'))
          .toContain(`Story screenshots: \`${screenshots}\``);
        return expectedCode;
      },
    });
    expect(code).toBe(expectedCode);
    const summary = readFileSync(join(dirname(screenshots), 'summary.md'), 'utf8');
    expect(summary).toContain(file);
    expect(summary).toContain(expectedCode === 0 ? 'passed' : 'failed');
    expect(readdirSync(artifacts)).toEqual([basename(dirname(screenshots))]);
  });
}

test('story dispatch defaults to the harness’s QA artifact directory', async () => {
  let directory = '';
  try {
    await dispatchTest(['packages/ui/src/components/badge.stories.tsx'], {
      env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: undefined },
      runner: async (_, env) => {
        directory = dirname(env![STORY_SCREENSHOTS_ENV]!);
        expect(dirname(directory)).toBe(resolve(qaArtifactDirectory(root)));
        expect(relative(directory, env![STORY_SCREENSHOTS_ENV]!)).toBe('story-screenshots');
        return 0;
      },
    });
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary and mixed-tier dispatch do not supply screenshot environment or create story artifacts', async () => {
  const artifacts = artifactRoot();
  const env = { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts };
  for (const { args, expectedLaunches } of [
    { args: ['services/main/tests/command.test.ts', '-t', 'profile'], expectedLaunches: 1 },
    { args: ['apps/web/tests/g-944-shared-browser.test.ts', 'scripts/dev/seed/api.test.ts'], expectedLaunches: 2 },
  ]) {
    let launches = 0;
    expect(await dispatchTest(args, {
      env,
      admission: async () => { throw new Error('Non-story tests need no Storybook admission'); },
      runner: async (_, override) => {
        expect(override).toBeUndefined();
        launches++;
        return 0;
      },
    })).toBe(0);
    expect(launches).toBe(expectedLaunches);
    expect(readdirSync(artifacts)).toEqual([]);
  }
});

test('an invalid artifact root warns once per run and preserves passing and failing story exits', async () => {
  const artifacts = join(artifactRoot(), 'not-a-directory\nartifact-root');
  writeFileSync(artifacts, 'existing regular file');
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  let launches = 0;
  try {
    for (const expectedCode of [0, 7]) {
      expect(await dispatchTest(['packages/ui/src/components/badge.stories.tsx'], {
        env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts },
        runner: async (_, env) => {
          expect(dirname(dirname(env![STORY_SCREENSHOTS_ENV]!))).toBe(artifacts);
          launches++;
          return expectedCode;
        },
      })).toBe(expectedCode);
    }
  } finally { console.warn = original; }
  expect(launches).toBe(2);
  expect(warnings).toHaveLength(2);
  for (const warning of warnings) {
    expect(warning).toStartWith('Warning: story screenshot artifacts ');
    expect(warning).not.toMatch(/[\r\n]/);
  }
  expect(readFileSync(artifacts, 'utf8')).toBe('existing regular file');
});

test('a summary append failure warns and preserves the story exit', async () => {
  const artifacts = artifactRoot();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    expect(await dispatchTest(['packages/ui/src/components/badge.stories.tsx'], {
      env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts },
      runner: async (_, env) => {
        const summary = join(dirname(env![STORY_SCREENSHOTS_ENV]!), 'summary.md');
        rmSync(summary);
        mkdirSync(summary);
        return 7;
      },
    })).toBe(7);
  } finally { console.warn = original; }
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith('Warning: story screenshot artifacts ');
});
