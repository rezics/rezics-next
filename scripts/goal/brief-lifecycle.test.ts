import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRIEF_KINDS, type Ledger } from './types.ts';
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
        'migrations', 'shared', 'depends', ...['outcome', 'surface', 'tooling'].includes(kind) ? ['land'] : [],
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
