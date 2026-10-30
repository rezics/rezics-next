import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSettings } from './config.ts';
import { deliverDueReminders, occurrence, parseNotes } from './notes.ts';

test('notes are validated: text is required, everyHours needs remindAt, unknown keys are refused', () => {
  expect(parseNotes([{ text: 'documents a plan' }])).toEqual([{ text: 'documents a plan' }]);
  expect(() => parseNotes([{ remindAt: '2026-10-27T03:00:00Z' }])).toThrow('text is required');
  expect(() => parseNotes([{ text: 'x', everyHours: 24 }])).toThrow('needs remindAt');
  expect(() => parseNotes([{ text: 'x', when: 'soon' }])).toThrow('unknown notes[0].when');
  expect(() => parseNotes([{ text: 'x', remindAt: 'tomorrow' }])).toThrow('ISO time');
});

test('a reminder is due from its time, and a recurring one at its latest period', () => {
  const at = Date.parse('2026-10-27T03:00:00Z');
  expect(occurrence({ text: 'x' }, at)).toBeUndefined();
  expect(occurrence({ text: 'x', remindAt: '2026-10-27T03:00:00Z' }, at - 1)).toBeUndefined();
  expect(occurrence({ text: 'x', remindAt: '2026-10-27T03:00:00Z' }, at + 5)).toBe('2026-10-27T03:00:00.000Z');
  expect(occurrence({ text: 'x', remindAt: '2026-10-27T03:00:00Z', everyHours: 24 }, at + 50 * 3_600_000))
    .toBe('2026-10-29T03:00:00.000Z');
});

test('each due reminder reaches the supermanager once per occurrence', () => {
  const state = mkdtempSync(join(tmpdir(), 'notes-'));
  try {
    const notes = parseNotes([
      { text: 'plain note' },
      { text: 'check the Claude weekly pace', remindAt: '2026-10-27T03:00:00Z', everyHours: 24 },
    ]);
    const sent: string[] = [];
    const at = Date.parse('2026-10-27T04:00:00Z');
    expect(deliverDueReminders(notes, state, (s) => sent.push(s), at)).toBe(1);
    expect(deliverDueReminders(notes, state, (s) => sent.push(s), at + 3_600_000)).toBe(0);
    expect(deliverDueReminders(notes, state, (s) => sent.push(s), at + 24 * 3_600_000)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('check the Claude weekly pace');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('the local configuration accepts top-level notes and a note on a pool', () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-config-'));
  try {
    const localFile = join(root, 'local.json');
    writeFileSync(localFile, JSON.stringify({
      notes: [{ text: 'Claude week resets Mondays 15:00 UTC', remindAt: '2026-10-27T03:00:00Z', everyHours: 24 }],
      pools: [{ name: 'p', cli: 'claude', classes: ['claude'], command: 'claude', configDirectory: root, allowanceKey: 'claude',
        note: 'shares the managers allowance', policy: { weight: 1, reservePercent: 30, allowUnknown: false, maxAgeMs: 1 } }],
    }));
    const settings = loadSettings({ cwd: root, localFile, env: { GOAL_MAIN_CHECKOUT: root } });
    expect(settings.notes).toEqual([{ text: 'Claude week resets Mondays 15:00 UTC', remindAt: '2026-10-27T03:00:00Z', everyHours: 24 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the CLI rejects string notes before state mutation and accepts note objects', () => {
  mkdirSync(join(import.meta.dir, '../../../.temp'), { recursive: true });
  const root = mkdtempSync(join(import.meta.dir, '../../../.temp/notes-cli-'));
  try {
    const state = join(root, '.temp/goal');
    mkdirSync(state, { recursive: true });
    const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
    expect(initialized.status).toBe(0);
    spawnSync('git', ['config', 'user.name', 'Fixture'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    spawnSync('git', ['add', 'README.md'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'Initialize notes CLI fixture'], { cwd: root, encoding: 'utf8' });
    expect(spawnSync('git', ['branch', 'dev', 'main'], { cwd: root, encoding: 'utf8' }).status).toBe(0);
    const localFile = join(state, 'local.json');
    const cli = resolve(import.meta.dir, './cli.ts');
    const run = () =>
      spawnSync('bun', [cli, 'verify'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GOAL_MAIN_CHECKOUT: root,
          GOAL_LOCAL_CONFIG: localFile,
          GOAL_STATE_DIRECTORY: state,
        },
      });

    writeFileSync(localFile, JSON.stringify({ notes: ['remember the schedule'] }));
    const invalid = run();
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('notes[0] must be an object');
    expect(existsSync(join(state, 'goal.sqlite'))).toBe(false);
    expect(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/dev-verified'], { cwd: root }).status).not.toBe(
      0,
    );

    writeFileSync(localFile, JSON.stringify({ notes: [{ text: 'remember the schedule' }] }));
    const valid = run();
    expect(valid.status).toBe(0);
    expect(existsSync(join(state, 'goal.sqlite'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
