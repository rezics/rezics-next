import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredAccounts, loadSettings } from './config.ts';

function fixture() {
  const base = join(import.meta.dir, '../../.temp/settings-tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'case-'));
  const directory = join(root, '.goalctl'), stateDirectory = join(root, '.temp/goal-orchestration');
  mkdirSync(directory); mkdirSync(stateDirectory, { recursive: true });
  const reports: string[] = [];
  const options = { directory, stateDirectory, report: (line: string) => reports.push(line) };
  const layer = (name: 'shared' | 'user', value: object) => writeFileSync(join(directory,
    name === 'shared' ? 'settings.json' : 'settings.user.json'), JSON.stringify({ version: 1, ...value }));
  return { root, directory, stateDirectory, reports, options, layer,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('goalctl layered settings', () => {
  test('older schemas ignore newer user fields once, including nested fields, and migration preserves them', () => {
    const f = fixture();
    try {
      f.layer('user', { futureSetting: { value: true }, qaSlots: 7,
        codexCompactTokens: { sol: 160000, luna: 200000, futureModel: 300000 } });
      writeFileSync(join(f.stateDirectory, 'gate-lane-count'), '4');
      const loaded = loadSettings(f.options);
      expect(loaded.settings.qaSlots).toBe(7);
      expect(loaded.settings.gateLanes).toBe(4);
      expect(loaded.settings).not.toHaveProperty('futureSetting');
      expect(loaded.settings.codexCompactTokens).not.toHaveProperty('futureModel');
      const warnings = f.reports.filter(line => line.includes('ignored'));
      expect(warnings).toEqual([
        `${f.directory}/settings.user.json: settings.futureSetting is unknown; ignored`,
        `${f.directory}/settings.user.json: settings.codexCompactTokens.futureModel is unknown; ignored`,
      ]);
      expect(JSON.parse(readFileSync(join(f.directory, 'settings.user.json'), 'utf8'))).toMatchObject({
        futureSetting: { value: true }, codexCompactTokens: { futureModel: 300000 }, gateLanes: 4,
      });
      f.layer('user', { futureSetting: true, qaSlots: 0 });
      expect(() => loadSettings(f.options)).toThrow('settings.qaSlots must be at least 1');
      f.layer('shared', { futureSetting: true });
      expect(() => loadSettings(f.options)).toThrow('settings.json: settings.futureSetting is unknown');
    } finally { f.cleanup(); }
  });

  test('worktrees read their own tracked settings and the main checkout user settings', () => {
    const f = fixture();
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git(f.root, 'init', '-q', '-b', 'main');
      git(f.root, 'config', 'user.name', 'Settings test');
      git(f.root, 'config', 'user.email', 'settings@example.invalid');
      f.layer('shared', { qaSlots: 5 });
      git(f.root, 'add', '.goalctl/settings.json');
      git(f.root, 'commit', '-qm', 'tracked settings');
      const worktree = join(f.root, 'older-tree');
      git(f.root, 'worktree', 'add', '-q', '-b', 'older', worktree);
      writeFileSync(join(worktree, '.goalctl/settings.json'), JSON.stringify({ version: 1, qaSlots: 2 }));
      f.layer('shared', { qaSlots: 8, futureSharedField: true });
      f.layer('user', { futureUserField: true, accounts: [{ engine: 'sample-c', home: './account', weight: 1 }] });
      const options = { cwd: worktree, env: { GOAL_SETTINGS_DIRECTORY: '' }, report: f.options.report };
      const loaded = loadSettings(options);
      expect(loaded.settings.qaSlots).toBe(2);
      expect(loaded.sources.qaSlots).toBe(join(worktree, '.goalctl/settings.json'));
      expect(loaded.sources.accounts).toBe(join(f.directory, 'settings.user.json'));
      expect(configuredAccounts(options)[0]!.home).toBe(join(f.directory, 'account'));
      expect(f.reports[0]).toBe(`${f.directory}/settings.user.json: settings.futureUserField is unknown; ignored`);
      // An inherited launcher override must not redirect the tracked layer to main.
      expect(loadSettings({ ...options, env: { GOAL_SETTINGS_DIRECTORY: f.directory } }).settings.qaSlots).toBe(2);
      f.layer('shared', { qaSlots: 8 });
      expect(loadSettings({ ...options, cwd: f.root }).settings.qaSlots).toBe(8);
    } finally { f.cleanup(); }
  });

  test('simultaneous first loads migrate once without losing user fields', async () => {
    const f = fixture();
    try {
      f.layer('user', { unitGateShards: 9 });
      writeFileSync(join(f.stateDirectory, 'qa-slot-count'), '6');
      writeFileSync(join(f.stateDirectory, 'review-engine'), 'sample-c');
      const program = `import { loadSettings } from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
console.log(JSON.stringify(loadSettings(${JSON.stringify({ directory: f.directory, stateDirectory: f.stateDirectory })}).settings));`;
      const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e', program], {
        cwd: f.root, stdout: 'pipe', stderr: 'pipe',
      }));
      const results = await Promise.all(children.map(async child => ({
        code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(),
      })));
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ qaSlots: 6, reviewEngine: 'sample-c', unitGateShards: 9 });
      }
      expect(results.map(result => result.stderr).join('').match(/Migrated /g)).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  test('layers override fields, report provenance and fall back when the user file is removed', () => {
    const f = fixture();
    try {
      f.layer('shared', { qaSlots: 5, unitGateShards: 2 });
      f.layer('user', { qaSlots: 7, accounts: [{ engine: 'sample-c', home: './account', weight: 3 }] });
      const loaded = loadSettings(f.options);
      expect(loaded.settings).toMatchObject({ qaSlots: 7, unitGateShards: 2, gateLanes: 2 });
      expect(loaded.sources.qaSlots).toEndWith('settings.user.json');
      expect(loaded.sources.unitGateShards).toEndWith('settings.json');
      expect(loaded.sources.gateLanes).toBe('built-in');
      expect(configuredAccounts(f.options)[0]).toMatchObject({ engine: 'sample-c', home: join(f.directory, 'account'), pastAllowance: [] });
      rmSync(join(f.directory, 'settings.user.json'));
      expect(loadSettings(f.options).settings.qaSlots).toBe(5);
      expect(configuredAccounts(f.options)).toMatchObject([{ engine: 'codex', launcher: 'codex', weight: 1 }]);
    } finally { f.cleanup(); }
  });

  test.each([
    [{ codexCompactTokens: { sol: 0, luna: 200000 } }, 'codexCompactTokens.sol'],
    [{ codexCompactTokens: { sol: 160000.5, luna: 200000 } }, 'codexCompactTokens.sol'],
    [{ codexCompactTokens: { sol: 160000 } }, 'codexCompactTokens'],
    [{ qaSlots: 0 }, 'qaSlots'],
    [{ gateLanes: 'many' }, 'gateLanes'],
    [{ accounts: [{ engine: 'sample-c', home: './home', weight: -1 }] }, 'accounts[0].weight'],
    [{ accounts: [{ engine: 'sol', launcher: 'tool', weight: 1 }] }, 'accounts[0].engine'],
    [{ accounts: [{ engine: 'sample-c', weight: 1 }] }, 'accounts[0]'],
    [{ accounts: [{ engine: 'sample-c', launcher: 'tool', weight: 1, pastAllowance: ['model', 'model'] }] }, 'pastAllowance'],
  ])('rejects an invalid user layer with its file and field: %j', (value, field) => {
    const f = fixture();
    try {
      f.layer('user', value);
      expect(() => loadSettings(f.options)).toThrow('settings.user.json');
      expect(() => loadSettings(f.options)).toThrow(field);
    } finally { f.cleanup(); }
  });

  test('requires the supported version and keeps accounts out of the shared layer', () => {
    const f = fixture();
    try {
      writeFileSync(join(f.directory, 'settings.user.json'), '{"version":2}');
      expect(() => loadSettings(f.options)).toThrow('version');
      rmSync(join(f.directory, 'settings.user.json'));
      f.layer('shared', { accounts: [{ engine: 'sample-a', home: './home', weight: 1 }] });
      expect(() => loadSettings(f.options)).toThrow('settings.accounts belongs in settings.user.json');
    } finally { f.cleanup(); }
  });

  test.each([
    ['codex-service-tier', 'codexServiceTier', 'default', 'default'],
    ['review-engine', 'reviewEngine', 'sample-c', 'sample-c'],
    ['confirm-interval-minutes', 'confirmIntervalMinutes', '45', 45],
    ['gate-lane-count', 'gateLanes', '5', 5],
    ['qa-slot-count', 'qaSlots', '7', 7],
    ['regress-lane-count', 'regressLaneCount', '6', 6],
    ['unit-gate-scope', 'unitGateScope', 'changed', 'changed'],
    ['unit-gate-shards', 'unitGateShards', '8', 8],
    ['telegram-chat', 'telegramChat', 'sample-room', 'sample-room'],
  ] as const)('migrates %s once and retains runtime state', (name, key, text, expected) => {
    const f = fixture();
    try {
      const file = join(f.stateDirectory, name);
      writeFileSync(file, `${text}\n`);
      writeFileSync(join(f.stateDirectory, 'ledger.json'), '{}');
      expect(loadSettings(f.options).settings[key]).toBe(expected);
      expect(f.reports).toHaveLength(1);
      expect(f.reports[0]).toContain(name);
      expect(existsSync(`${file}.migrated`)).toBe(true);
      expect(existsSync(join(f.stateDirectory, 'ledger.json'))).toBe(true);
      const before = readFileSync(join(f.directory, 'settings.user.json'), 'utf8');
      writeFileSync(file, 'obsolete rewrite');
      expect(loadSettings(f.options).settings[key]).toBe(expected);
      expect(readFileSync(join(f.directory, 'settings.user.json'), 'utf8')).toBe(before);
      expect(f.reports).toHaveLength(1);
    } finally { f.cleanup(); }
  });
});
