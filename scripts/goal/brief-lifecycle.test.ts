import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRIEF_KINDS, type Ledger, type Task } from './types.ts';
import { mechanismSectionErrors, parseBrief, parseFrontmatter, validateBrief } from './briefs.ts';
import { fixtureSpawns } from './fixtures/spawn-deadline.ts';

const spawnSync = fixtureSpawns(60_000);
const cli = join(import.meta.dir, 'goalctl.ts');

function repository() {
  const scratch = join(import.meta.dir, '../../.temp/brief-lifecycle');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'repo-'));
  const env = { PATH: process.env.PATH, CLAUDECODE: process.env.CLAUDECODE, GOAL_ID: 'alpha' };
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'brief-lifecycle@example.test');
  git('config', 'user.name', 'Brief lifecycle test');
  write('.gitignore', '.temp/\n');
  write('docs/goals/alpha/GOAL.md', '# Alpha\n');
  git('add', '.');
  git('commit', '-qm', 'Initial Goal');
  const ledger: Ledger = { tasks: {}, goals: { alpha: { manager: 'fixture', startedAt: '2026-10-13T00:00:00Z' } } };
  const save = () => write('.temp/goal-orchestration/ledger.json', JSON.stringify(ledger));
  save();
  return { dir, git, write, ledger, save,
    run: (args: string[], overrides: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...args],
      { cwd: dir, env: { ...env, ...overrides }, encoding: 'utf8' }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('brief skeleton', () => {
  for (const kind of BRIEF_KINDS) test(`new writes a complete valid ${kind} skeleton`, () => {
    const repo = repository();
    try {
      const created = repo.run(['new', '--kind', kind, '--goal', 'alpha', 'Example brief'], { GOAL_ENGINE: 'claude' });
      expect(created.status, created.stderr).toBe(0);
      const path = created.stdout.match(/docs\/goals\/alpha\/tasks\/G-\d+\.md/)?.[0];
      expect(path).toBeDefined();
      const skeleton = readFileSync(join(repo.dir, path!), 'utf8');
      const completed = skeleton.replace('## Outcome\n', '## Outcome\n\nThe worker delivers the stated outcome.\n')
        .replace('## Checks\n', '## Checks\n\nRun the declared proofs.\n');
      const brief = parseBrief(completed);
      expect(brief.kind).toBe(kind);
      expect(brief.title).toBe('Example brief');
      expect(brief.engine).toBe('sol');
      expect(validateBrief(brief)).toEqual([]);
      expect(mechanismSectionErrors(completed)).toEqual([]);
      expect(Object.keys(parseFrontmatter(completed)!)).toEqual([
        'id', 'title', 'kind', 'rows', 'engine', 'effort', 'cases', 'paths', 'tests', 'refs', 'operations',
        'migrations', 'shared', 'depends', 'needs', ...['outcome', 'surface', 'tooling'].includes(kind) ? ['land'] : [],
      ]);
      expect(brief.land).toBe(['outcome', 'surface', 'tooling'].includes(kind) ? 'auto' : undefined);
      expect(skeleton).toContain('# worktree:');
      expect(skeleton).toContain('# <id>: consume | configure | extend | new — <why no owner fits>');
      if (!brief.land) expect(skeleton).toContain('# land: auto');
    } finally { repo.cleanup(); }
  });

  test('new refuses a missing or unknown kind before reserving an ID and lists the kinds', () => {
    const repo = repository();
    try {
      for (const args of [['new', 'Example brief'], ['new', '--kind', 'unknown', 'Example brief'], ['new', 'Example brief', '--kind']]) {
        const result = repo.run(args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--kind');
        expect(result.stderr).toContain(BRIEF_KINDS.join(', '));
        expect(existsSync(join(repo.dir, 'docs/goals/alpha/tasks'))).toBe(false);
      }
      expect(JSON.parse(readFileSync(join(repo.dir, '.temp/goal-orchestration/ledger.json'), 'utf8'))).toEqual(repo.ledger);
    } finally { repo.cleanup(); }
  });

  test('engine resolution defaults to sol and preserves explicit Claude in a brief or environment', () => {
    const repo = repository();
    try {
      const source = `import { parseBrief, validateBrief } from ${JSON.stringify(join(import.meta.dir, 'briefs.ts'))};
import { DEFAULT_ENGINE } from ${JSON.stringify(join(import.meta.dir, 'types.ts'))};
const brief = '---\\nid: G-001\\ntitle: Example\\nkind: tooling\\neffort: high\\n---\\n';
const explicit = parseBrief(brief.replace('kind: tooling', 'engine: claude\\nkind: tooling'));
console.log(JSON.stringify({ defaultEngine: DEFAULT_ENGINE, implicit: parseBrief(brief).engine,
  explicit: explicit.engine, errors: validateBrief(explicit) }));`;
      repo.write('.temp/engines.ts', source);
      for (const engine of [undefined, 'claude'] as const) {
        const result = spawnSync(process.execPath, [join(repo.dir, '.temp/engines.ts')], {
          cwd: repo.dir, env: { PATH: process.env.PATH, ...engine ? { GOAL_ENGINE: engine } : {} }, encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ defaultEngine: engine ?? 'sol', implicit: engine ?? 'sol', explicit: 'claude', errors: [] });
      }
    } finally { repo.cleanup(); }
  });
});

test('needs uses the same quoted and multiline list parsing as other brief lists', () => {
  for (const field of ['needs: ["apps/replay.ts", \'tests/answer.json\']', 'needs:\n  - "apps/replay.ts"\n  - \'tests/answer.json\'']) {
    const brief = parseBrief(`---\nid: G-001\ntitle: Waiting work\nkind: tooling\n${field}\n---\n`);
    expect(brief.needs).toEqual(['apps/replay.ts', 'tests/answer.json']);
    expect(validateBrief(brief)).toEqual([]);
  }
  expect(parseBrief('---\nid: G-001\n---\n').needs).toEqual([]);
});

test('needed paths must be literal repository paths and may normalize inside the repository', () => {
  const brief = parseBrief('---\nid: G-001\ntitle: Waiting work\nkind: tooling\n---\n');
  for (const path of ['../outside', 'inside/../../outside', '..', '/absolute', 'C:\\absolute', '\\\\server\\share', '*.ts', '?.ts', '[ab].ts', '{a,b}.ts']) {
    expect(validateBrief({ ...brief, needs: [path] })).toEqual([
      `needed path must be repository-relative without globs and stay inside the repository: ${path}`,
    ]);
  }
  expect(validateBrief({ ...brief, needs: ['./claimed.ts', 'inside/../claimed.ts'] })).toEqual([]);
});

function closedBrief(repo: ReturnType<typeof repository>): Task {
  const path = 'docs/goals/alpha/tasks/G-001.md';
  repo.write(path, '---\nid: G-001\ntitle: Example\nkind: tooling\nengine: sol\neffort: high\n---\n\n## Outcome\n\nDelivered.\n');
  const task: Task = { ...parseBrief(readFileSync(join(repo.dir, path), 'utf8')), goal: 'alpha',
    brief: join(repo.dir, path), worktree: join(repo.dir, '.temp/absent-worker'), branch: 'goal/example',
    base: repo.git('rev-parse', 'HEAD'), state: 'merged', attempts: [] };
  repo.ledger.tasks[task.id] = task;
  repo.save();
  return task;
}

function documentationLinks(repo: ReturnType<typeof repository>) {
  const checker = join(import.meta.dir, '../documentation');
  return spawnSync('python3', ['-B', '-c',
    'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from check_docs import check; '
      + 'root = Path(sys.argv[2]); errors = check(root, list((root / "docs").rglob("*.md")), navigation=False); '
      + 'print("\\n".join(errors)); sys.exit(bool(errors))', checker, repo.dir],
  { cwd: repo.dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
}

describe('brief archive links', () => {
  test('indented code examples remain source text', () => {
    const repo = repository();
    try {
      const task = closedBrief(repo);
      const text = '# State\n\n    [example](tasks/G-001.md)\n';
      repo.write('docs/goals/alpha/state.md', text);
      repo.git('add', 'docs'); repo.git('commit', '-qm', 'Show a code example');
      const result = repo.run(['close', task.id, 'verified']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(task.brief)).toBe(false);
      expect(readFileSync(join(repo.dir, 'docs/goals/alpha/state.md'), 'utf8')).toBe(text);
    } finally { repo.cleanup(); }
  });

  test('reference links and multiline destinations become text, including links in a kept brief', () => {
    const repo = repository();
    try {
      const task = closedBrief(repo);
      const kept = 'docs/goals/beta/tasks/G-002.md';
      repo.write(kept, '# Kept brief\n[Delivered](../../alpha/tasks/G-001.md)\n');
      task.state = 'verified';
      repo.ledger.tasks['G-002'] = { ...task, id: 'G-002', goal: 'beta', brief: join(repo.dir, kept) };
      repo.ledger.goals!.beta = { manager: 'fixture', startedAt: '2026-10-13T00:00:00Z' };
      repo.save();
      repo.write('README.md', `[Kept](${kept})\n`);
      const before = '# State\n[Explicit][done], [Done][] and [done].\n'
        + '[done]: <tasks/G-%30%30%31.md#outcome> "Delivered"\n'
        + '[line\nbreak](\n  tasks/G-001.md\n)\n[**work [label]**](tasks/G-001.md)\n';
      const after = '# State\nExplicit, Done and done.\nline\nbreak\n**work [label]**\n';
      repo.write('docs/goals/alpha/state.md', before);
      repo.git('add', '.'); repo.git('commit', '-qm', 'Link to closed work');
      const result = repo.run(['tidy']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(task.brief)).toBe(false);
      expect(readFileSync(join(repo.dir, kept), 'utf8')).toBe('# Kept brief\nDelivered\n');
      expect(readFileSync(join(repo.dir, 'docs/goals/alpha/state.md'), 'utf8')).toBe(after);
      const links = documentationLinks(repo);
      expect(links.status, links.stdout + links.stderr).toBe(0);
    } finally { repo.cleanup(); }
  });

  test('close flattens links across Goals in the removal commit and preserves prose and examples', () => {
    const repo = repository();
    try {
      const task = closedBrief(repo);
      const before = '# State\n[G-001](tasks/G-001.md) and [delivered **work**](./tasks/G-001.md#outcome "Result").\n'
        + '[root](</docs/goals/alpha/tasks/G-001.md?view=closed#outcome>)\n'
        + 'Plain tasks/G-001.md and G-001 stay.\n'
        + '`[example](tasks/G-001.md)`\n```md\n[example](tasks/G-001.md)\n```\n'
        + '\\[escaped](GOAL.md)\n[Goal](GOAL.md)\n';
      const after = '# State\nG-001 and delivered **work**.\nroot\n'
        + 'Plain tasks/G-001.md and G-001 stay.\n'
        + '`[example](tasks/G-001.md)`\n```md\n[example](tasks/G-001.md)\n```\n'
        + '\\[escaped](GOAL.md)\n[Goal](GOAL.md)\n';
      repo.write('docs/goals/alpha/state.md', before);
      repo.write('docs/goals/beta/notes.md', '[Other Goal](../alpha/tasks/G-001.md)\n');
      repo.git('add', 'docs'); repo.git('commit', '-qm', 'Record delivered work');
      const original = repo.git('show', `HEAD:${task.brief.slice(repo.dir.length + 1)}`);
      repo.write('peer.txt', 'Another change\n'); repo.git('add', 'peer.txt');
      const closed = repo.run(['close', task.id, 'verified']);
      expect(closed.status, closed.stderr).toBe(0);
      expect(existsSync(task.brief)).toBe(false);
      expect(readFileSync(join(repo.dir, 'docs/goals/alpha/state.md'), 'utf8')).toBe(after);
      expect(readFileSync(join(repo.dir, 'docs/goals/beta/notes.md'), 'utf8')).toBe('Other Goal\n');
      expect(repo.git('show', '--format=', '--name-status', 'HEAD').split('\n')).toEqual([
        'M\tdocs/goals/alpha/state.md', 'D\tdocs/goals/alpha/tasks/G-001.md', 'M\tdocs/goals/beta/notes.md',
      ]);
      expect(repo.git('show', 'HEAD:docs/goals/alpha/state.md')).toBe(after.trim());
      expect(repo.git('show', 'archive/goals:alpha-2026-10-13/tasks/G-001.md')).toBe(original);
      expect(repo.git('diff', '--cached', '--name-only')).toBe('peer.txt');
      const links = documentationLinks(repo);
      expect(links.status, links.stdout + links.stderr).toBe(0);
      const head = repo.git('rev-parse', 'HEAD');
      expect(repo.run(['tidy']).status).toBe(0);
      expect(repo.git('rev-parse', 'HEAD')).toBe(head);
    } finally { repo.cleanup(); }
  });

  for (const [path, link] of [
    ['README.md', '[Needed brief](docs/goals/alpha/tasks/G-001.md)\n'],
    ['docs/guide.md', '[Needed brief](goals/alpha/tasks/G-001.md)\n'],
  ]) test(`a link from ${path} keeps the brief and its Goal links`, () => {
    const repo = repository();
    try {
      const task = closedBrief(repo);
      repo.write(path!, link!);
      repo.write('docs/goals/alpha/state.md', '[G-001](tasks/G-001.md)\n');
      repo.git('add', '.'); repo.git('commit', '-qm', 'Keep an external citation');
      const head = repo.git('rev-parse', 'HEAD');
      const closed = repo.run(['close', task.id, 'verified']);
      expect(closed.status, closed.stderr).toBe(0);
      expect(closed.stdout).toContain('kept; cited by');
      expect(existsSync(task.brief)).toBe(true);
      expect(readFileSync(join(repo.dir, 'docs/goals/alpha/state.md'), 'utf8')).toBe('[G-001](tasks/G-001.md)\n');
      expect(repo.git('rev-parse', 'HEAD')).toBe(head);
      expect(repo.git('status', '--porcelain')).toBe('');
      const links = documentationLinks(repo);
      expect(links.status, links.stdout + links.stderr).toBe(0);
    } finally { repo.cleanup(); }
  });
});
