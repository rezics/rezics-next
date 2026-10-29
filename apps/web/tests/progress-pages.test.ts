import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('progress pages show current progress before opening an update form', async () => {
  const page = await read('../src/library/progress-page.tsx');
  expect(page).toContain('<ProgressRow');
  expect(page).toContain('progressView(session');
  expect(page).toContain('library_progress_update');
  expect(page).toContain('defaultValue={session.amount');
  expect(page).toContain('open={editing}');
  expect(page).not.toMatch(/<Input[^>]+name="amount"/);
});

test('default progress units follow subject type', async () => {
  const page = await read('../src/library/progress-page.tsx');
  expect(page).toMatch(/type[^\n]*(?:book|text)[\s\S]{0,180}unit[^\n]*page/);
  expect(page).toMatch(/type[^\n]*video[\s\S]{0,180}unit[^\n]*episode/);
});

test('progress labels use localized messages for locator parts and chapters', async () => {
  const label = await read('../src/library/progress-label.ts');
  expect(label).toContain('library_progress_locator');
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
  expect(session).toContain('library_progress_change_amount');
  expect(session).toContain('library_progress_change_locator');
  expect(session).toContain('library_progress_change_position');
  expect(session).not.toContain('>…</');
});

test('progress selectors use the shared responsive menu', async () => {
  const [page, picker, session] = await Promise.all([
    read('../src/library/progress-page.tsx'),
    read('../src/library/progress-picker.tsx'),
    read('../src/library/progress-session.tsx'),
  ]);
  for (const source of [page, picker, session]) {
    expect(source).toContain("@rezics/ui/menu");
    expect(source).not.toContain('@rezics/ui/shadcn/dropdown-menu');
  }
});

test('progress lists and logs use ListRow, with row links above their own controls', async () => {
  for (const path of [
    '../src/library/progress-page.tsx',
    '../src/library/progress-session.tsx',
    '../src/library/logs-progress.tsx',
  ]) {
    const source = await read(path);
    expect(source).toContain('ListRow');
    expect(source).not.toMatch(/divide-y|border-y|border-b|rounded-(?:lg|xl)\s+bg-card/);
  }
});

