import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configurationProblem, loadLocalSettings, reportedConfigurationProblem } from './local-settings.ts';

function fixture() {
  const repository = resolve(import.meta.dir, '../../..');
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/local-settings-'));
  const real = join(directory, 'real');
  const file = join(real, 'local.json');
  const alias = join(directory, 'local-alias.json');
  const other = join(directory, 'other');
  mkdirSync(real);
  mkdirSync(other);
  symlinkSync(file, alias, 'file');
  return {
    directory,
    file,
    alias,
    other: join(other, 'local.json'),
  };
}

function validate(local: unknown): { value: string } {
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('invalid local settings');
  const value = (local as { value?: unknown }).value;
  if (value !== undefined && typeof value !== 'string') throw new Error('invalid value');
  return { value: typeof value === 'string' ? value : 'default' };
}

test('recovery tracks canonical identity, accepted clears, reports, and file isolation', () => {
  const h = fixture();
  const load = (file: string) => loadLocalSettings(file, h.directory, validate);
  try {
    writeFileSync(h.file, '{"value":"first"}');
    expect(load(h.file).value).toBe('first');
    writeFileSync(h.other, '{"value":"unrelated"}');
    expect(load(h.other).value).toBe('unrelated');
    writeFileSync(h.file, '{ invalid json');
    const recovered = load(h.alias);
    expect(recovered.value).toBe('first');
    const problem = configurationProblem(recovered)!;
    expect(problem.reported).toBe(false);
    reportedConfigurationProblem(problem);
    expect(configurationProblem(load(h.file))?.reported).toBe(true);
    writeFileSync(h.alias, '{"value":"latest"}');
    expect(load(h.file).value).toBe('latest');
    unlinkSync(h.file);
    expect(load(h.alias).value).toBe('default');
    writeFileSync(h.file, '{ invalid json');
    expect(load(h.alias).value).toBe('default');
  } finally {
    rmSync(h.directory, { recursive: true, force: true });
  }
});

test('a delayed report acknowledgment cannot mark a newer recovery state reported', () => {
  const h = fixture();
  const load = (file: string) => loadLocalSettings(file, h.directory, validate);
  try {
    writeFileSync(h.file, '{"value":"old"}');
    load(h.file);
    writeFileSync(h.file, '{ invalid json');
    const stale = configurationProblem(load(h.file))!;
    writeFileSync(h.file, '{"value":"new"}');
    expect(load(h.file).value).toBe('new');
    reportedConfigurationProblem(stale);
    writeFileSync(h.file, '{ invalid json');
    const recovered = load(h.file);
    expect(recovered.value).toBe('new');
    expect(configurationProblem(recovered)?.reported).toBe(false);
  } finally {
    rmSync(h.directory, { recursive: true, force: true });
  }
});
