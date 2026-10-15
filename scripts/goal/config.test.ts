import { describe, expect, test } from 'bun:test';
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
    [{ qaSlots: 0 }, 'qaSlots'],
    [{ gateLanes: 'many' }, 'gateLanes'],
    [{ unexpected: true }, 'unexpected'],
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
