import { expect, test } from 'bun:test';
import { progressDefaultUnit } from '../src/library/progress-default-unit.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { progressFormChoices } from '../src/library/progress-profile.ts';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('progress pages show current progress before opening an update form', async () => {
  const page = await read('../src/library/progress-page.tsx');
  const session = await read('../src/library/progress-session.tsx');
  expect(page).toContain('<ProgressRow');
  expect(session).toContain('progressView(session');
  expect(session).toContain('library_progress_update');
  expect(session).toContain("setAmount(session.amount ?? '')");
  expect(session).toContain('open={editing}');
  expect(session).toMatch(/editing \?\s*\(\s*phone \?/);
});

test('default progress units follow only published supported declarations', async () => {
  expect(progressDefaultUnit(['schema:Book'])).toBe('page');
  expect(progressDefaultUnit(['schema:Text'])).toBe('');
  expect(progressDefaultUnit(['schema:Movie'])).toBe('minute');
  expect(progressDefaultUnit(['schema:VideoGame'])).toBe('minute');
  expect(progressDefaultUnit(['schema:TVSeries'])).toBe('episode');
  expect(progressDefaultUnit(['wd:Q689445'])).toBe('percent');
  expect(progressDefaultUnit(['unknown:Book'])).toBe('');
  expect(progressFormChoices(bundledRelease, 'schema:Text', 'en')).toBeUndefined();
  expect(progressFormChoices(bundledRelease, 'schema:Book', 'en')?.[0]?.units[0]?.id).toBe('page');
  const page = await read('../src/library/progress-page.tsx');
  expect(page).toContain('progressDefaultUnit');
});

test('progress labels use released unit metadata and preserve free-text locators', async () => {
  const label = await read('../src/library/progress-label.ts');
  expect(label).toContain('progress.locator');
  expect(label).toContain('progress.unitLabel');
  expect(label).toContain('progress.unitCountForms');
  expect(label).not.toMatch(/`[^`]*(?:Part|chapter|Chapter)[^`]*`/);
  for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const messages = (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<
      string,
      string
    >;
    expect(messages.library_progress_locator, locale).toBeTruthy();
  }
});

test('session changes list each changed field once and use a real progress icon', async () => {
  const session = await read('../src/library/progress-session.tsx');
  expect(session.match(/m\.library_progress_amount\(\)/g)?.length).toBe(2);
  expect(session).toContain('m.library_progress_locator()');
  expect(session).toContain('m.library_progress_position()');
  expect(session).not.toContain('>…</');
});

test('progress unit choices use a labelled Select form field while row actions use menus', async () => {
  const [page, picker, session] = await Promise.all([
    read('../src/library/progress-page.tsx'),
    read('../src/library/progress-picker.tsx'),
    read('../src/library/progress-session.tsx'),
  ]);
  expect(page).toContain('@rezics/ui/shadcn/select');
  expect(page).toContain('<Select');
  expect(page).toContain('<FieldLabel htmlFor="progress-unit">');
  expect(page).toContain('name="unit"');
  expect(page).toContain('changeDraft(() => setUnit(value))');
  expect(page).not.toContain('title={m.library_progress_unit()}');
  expect(page).toContain('@rezics/ui/menu');
  expect(session).toContain('@rezics/ui/menu');
  expect(page).not.toContain('@rezics/ui/shadcn/dropdown-menu');
  expect(session).not.toContain('@rezics/ui/shadcn/dropdown-menu');
  expect(picker).not.toContain('@rezics/ui/shadcn/dropdown-menu');
});

test('progress lists and logs use ListRow, with row links above their own controls', async () => {
  for (const path of [
    '../src/library/progress-page.tsx',
    '../src/library/progress-session.tsx',
    '../src/library/logs-progress.tsx',
  ]) {
    const source = await read(path);
    expect(source).toContain('ListRow');
    const rowOpenings = [...source.matchAll(/<ListRow\b[^>]*>/g)].map(([opening]) => opening);
    expect(rowOpenings.length).toBeGreaterThan(0);
    expect(rowOpenings.join('\n')).not.toMatch(/divide-y|border-y|border-b|rounded-(?:lg|xl)\s+bg-card/);
    expect(source).toContain('ListRowLink');
    expect(source).toContain('ListRowControl');
  }
});
