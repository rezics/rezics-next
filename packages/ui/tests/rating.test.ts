import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');
const stories = ['src/components/rating.stories.tsx'];

type Outcomes = Record<string, string>;

// One browser run serves the three story-backed tests below.
let storyRun: Promise<Outcomes> | undefined;

function runStories(): Promise<Outcomes> {
  storyRun ??= (async () => {
    for (const file of stories) expect(existsSync(join(root, file)), file).toBe(true);
    const output = mkdtempSync(join(tmpdir(), 'rezics-ui-rating-'));
    const report = join(output, 'stories.json');
    try {
      const run = Bun.spawn(['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...stories], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '1' },
      });
      const [stdout, stderr] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
      };
      return Object.fromEntries(
        result.testResults
          .flatMap((file) => file.assertionResults)
          .map((assertion) => [
            assertion.title,
            `${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
          ]),
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  })();
  return storyRun;
}

function expectPassed(outcomes: Outcomes, titles: string[]) {
  expect(
    Object.fromEntries(titles.map((title) => [title, outcomes[title] ?? 'missing'])),
    Object.entries(outcomes)
      .map(([title, outcome]) => `${title}: ${outcome}`)
      .join('\n'),
  ).toEqual(Object.fromEntries(titles.map((title) => [title, 'passed'])));
}

const source = (name: string) => readFileSync(join(components, `${name}.tsx`), 'utf8');

/** The component files a source file reaches through relative imports, itself included. */
function closure(name: string, seen = new Set<string>()): Set<string> {
  const file = join(components, name);
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = join(dirname(file), match[1]!);
    if (target.startsWith(components) && existsSync(target)) closure(target.slice(components.length + 1), seen);
  }
  return seen;
}

const shadcnImports = (name: string) =>
  [...source(name).matchAll(/from\s+'@rezics\/ui\/shadcn\/([a-z-]+)'/g)].map((match) => match[1]!).sort();

test('a rating summary never shows a score without its population and count, and lists other populations separately', async () => {
  const outcomes = await runStories();
  expectPassed(outcomes, [
    'Headline Shows Population And Count',
    'Realm Headline Beside Global',
    'Other Populations Listed Separately',
    'Imported Scores Labelled',
    'No Ratings Draws Nothing',
    'Long And CJK Names',
    'Dark',
  ]);
}, 300_000);

test('the distribution is hidden below the threshold the aggregate returns and says why', async () => {
  const outcomes = await runStories();
  expectPassed(outcomes, ['Below Threshold Hides Distribution', 'At Threshold Shows Distribution']);
}, 300_000);

test('a reader rates with one control, sees their own vote and can clear it, using shadcn primitives', async () => {
  const outcomes = await runStories();
  expectPassed(outcomes, ['Rate With One Control', 'Clear Own Vote', 'Failed Save Rolls Back', 'Unrated']);
  expect(shadcnImports('rating')).toEqual(expect.arrayContaining(['button', 'slider']));
  const reached = [...closure('rating.tsx')].map((file) => readFileSync(file, 'utf8')).join('\n');
  expect(reached).not.toContain('@ark-ui');
}, 300_000);

test('reactions, the overflow menu with report, and the report dialog are built from shadcn primitives and import no Ark UI', () => {
  const expected: Record<string, string[]> = {
    reactions: ['button'],
    'content-actions': ['alert-dialog', 'button'],
    'report-dialog': ['button', 'dialog', 'radio-group', 'textarea'],
  };
  for (const [name, primitives] of Object.entries(expected)) {
    expect(shadcnImports(name), name).toEqual(expect.arrayContaining(primitives));
    // Neither the file nor anything it imports from this package may reach Ark UI.
    for (const file of closure(`${name}.tsx`)) expect(readFileSync(file, 'utf8'), file).not.toContain('@ark-ui');
  }
  for (const name of ['reactions', 'content-actions']) expect(source(name)).toContain("from './menu.tsx'");
});
