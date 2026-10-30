import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operationIsAdmitted } from '../src/kernel/exposure';
const root = join(import.meta.dir, '..');
const read = (path: string) => readFile(join(root, path), 'utf8');

test('progress form admission fails closed for missing and unknown groups', () => {
  expect(operationIsAdmitted('progress_session.create', undefined)).toBe(false);
  expect(operationIsAdmitted('progress_session.create', [])).toBe(false);
  expect(operationIsAdmitted('progress_session.create', ['unrelated'])).toBe(false);
  expect(operationIsAdmitted('progress_session.create', ['reading_progress'])).toBe(true);
});

test('progress Unit is one controlled native select and fixed form choices use shared field components', async () => {
  const progress = await read('src/library/progress-page.tsx');
  expect(progress).toContain('<NativeSelect');
  expect(progress).toContain('name="unit"');
  expect(progress).toContain('value={unit}');
  expect(progress).toContain('onChange={(event) => setUnit(event.currentTarget.value)}');
  expect(progress).not.toContain('<select');
  expect(progress).not.toContain('title={m.library_progress_unit()}');
  expect(progress).toContain('<Field>');
  expect(progress).toContain('<FieldLabel');
  expect(progress).toContain('<NativeSelectOption');
  expect(progress).toContain('<FieldLabel htmlFor="progress-total">');
  expect(progress).toContain('<FieldLegend variant="label">');

  for (const file of [
    'src/library/copies-page.tsx',
    'src/library/copies-fallback.tsx',
    'src/features/pages/curate-view.tsx',
    'src/search/sort.tsx',
    'src/settings/collection-privacy.tsx',
  ]) {
    const source = await read(file);
    expect(source, file).not.toContain('<select');
    expect(source, file).toContain('<NativeSelect');
    expect(source, file).toContain('<FieldLabel');
    expect(source, file).toMatch(/<Field(?:\s|>)/);
  }
  const curate = await read('src/features/pages/curate-view.tsx');
  expect(curate).toContain('<FieldLabel htmlFor="curation-key">');
  const copiesFallback = await read('src/library/copies-fallback.tsx');
  expect(copiesFallback).toContain('<FieldLabel htmlFor="fallback-copy-subject">');
});

test('source has no raw select elements and Work title styling stays within document prose', async () => {
  const { readdir } = await import('node:fs/promises');
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? files(path) : entry.name.endsWith('.tsx') ? [path] : [];
        }),
      )
    ).flat();
  }
  const sourceFiles = await files(join(root, 'src'));
  for (const file of sourceFiles) expect(await readFile(file, 'utf8'), file).not.toMatch(/<select\b/);
  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');
    if (source.includes('<NativeSelect')) {
      expect(source, file).toContain('<Field');
      expect(source, file).toContain('<FieldLabel');
    }
  }
  const progress = await read('src/library/progress-page.tsx');
  const session = await read('src/library/progress-session.tsx');
  expect(progress).not.toContain('work-title');
  expect(session).not.toContain('work-title');
});
