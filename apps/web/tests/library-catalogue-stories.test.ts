import { expect, test } from 'bun:test';

// Source catalogue acceptance only. Connected play outcomes and native/browser evidence remain separate and UNRUN.
test('Library catalogue stories use real connected tracked-entry presentation and state-based story names without viewport duplicate pages or simulated production controls', async () => {
  const [patterns, progress, pages] = await Promise.all([
    Bun.file(new URL('../src/stories/library-patterns.stories.tsx', import.meta.url)).text(),
    Bun.file(new URL('../src/stories/library-progress.stories.tsx', import.meta.url)).text(),
    Bun.file(new URL('../src/stories/library-entries.stories.tsx', import.meta.url)).text(),
  ]);
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  const patternModule = transpiler.scan(patterns);
  const progressModule = transpiler.scan(progress);

  expect(patternModule.imports.map(({ path }) => path)).toContain('../library/personal-library-current');
  expect(patternModule.imports.map(({ path }) => path)).toContain('../library/personal-library-server');
  expect(patternModule.imports.map(({ path }) => path)).toContain('../../.storybook/cloudflare-workers');
  expect(patternModule.imports.map(({ path }) => path)).toContain('../kernel/fake');
  for (const primitive of ['@rezics/ui/cover-card', '@rezics/ui/shelf-list', '@rezics/ui/shelf-table']) {
    expect(patternModule.imports.map(({ path }) => path)).not.toContain(primitive);
  }
  expect(patterns.match(/<PersonalLibraryCurrent\b/g)).toHaveLength(1);
  expect(patterns).toContain('readPersonalLibraryCurrent({ data: search })');
  expect(patterns).toContain('createRecordedKernelFetch(');
  expect(patterns).toContain('<PatternStory visitor="Signed In"');
  expect(patterns).not.toMatch(/\buseState\b|\bonSort\s*=|\bonSelectedChange\s*=/);
  for (const layout of ['TrackedLayouts', 'GridSmall', 'GridMedium', 'GridLarge', 'StatusChips']) {
    expect(patternModule.exports).not.toContain(layout);
  }
  for (const outcome of ['StateFilterActive', 'SelectionMode', 'LongTitles', 'SubjectUnavailable', 'ViewerRetired']) {
    expect(patternModule.exports).toContain(outcome);
  }
  expect(transpiler.scan(pages).exports).toContain('StateFilterCleared');
  expect(progressModule.exports).not.toContain('Desktop');
  for (const exposure of ['ExposureOpen', 'ExposureClosed']) expect(progressModule.exports).toContain(exposure);
  for (const source of [patterns, progress]) {
    expect(source).not.toMatch(/defaultViewport|\bviewport\s*:/);
    for (const [, name] of source.matchAll(/\bname:\s*'([^']+)'/g)) {
      expect(name).not.toMatch(/\b(?:390|1280|phone|desktop)\b/i);
    }
  }
});

test('Library layout, size and profile-state map cells name connected exports with authored production outcomes at both global widths', async () => {
  const [patterns, map] = await Promise.all([
    Bun.file(new URL('../src/stories/library-patterns.stories.tsx', import.meta.url)).text(),
    Bun.file(new URL('../../../docs/development/page-stories.md', import.meta.url)).text(),
  ]);
  const exports = new Bun.Transpiler({ loader: 'tsx' }).scan(patterns).exports;
  expect(patterns).toContain('const search = validateShelfSearch(location.search)');
  expect(patterns).toContain('display={shelfDisplay(search)}');
  const outcomes = {
    'tracked entries list in grid, list and table': 'EntryPresentations',
    'grid small': 'SmallEntryGrid',
    'grid medium': 'MediumEntryGrid',
    'grid large': 'LargeEntryGrid',
    'each grid size': 'EntryGridSizes',
    'status chip for each state': 'ProfileStateDestinations',
  };
  const rows = map
    .split('\n')
    .filter((line) => line.startsWith('| apps/web/src/routes/library/index.tsx |'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  for (const [state, exportName] of Object.entries(outcomes)) {
    const mapped = rows.filter((row) => row[1] === state);
    expect(mapped, state).toHaveLength(1);
    const reference = `apps/web/src/stories/library-patterns.stories.tsx#${exportName}`;
    expect(mapped[0]!.slice(3), state).toEqual([reference, reference]);
    expect(exports).toContain(exportName);
    const story = patterns.match(new RegExp(`export const ${exportName}\\b[\\s\\S]*?(?=\\nexport const|$)`))?.[0];
    expect(story, reference).toMatch(/\bplay\s*:/);
    expect(story, reference).toContain('renderPattern(');
    expect(story, reference).toContain('await expectPresentation(');
    expect(story, reference).toContain('await expectRecordedDestinations(');
  }
});

test('Library connected layout and size plays exercise every named production presentation and the truthful table fallback', async () => {
  const patterns = await Bun.file(new URL('../src/stories/library-patterns.stories.tsx', import.meta.url)).text();
  const story = (name: string) =>
    patterns.match(new RegExp(`export const ${name}\\b[\\s\\S]*?(?=\\nexport const|$)`))![0];
  const presentations = story('EntryPresentations');
  expect(presentations).toContain("renderPattern({ layout: 'table' })");
  for (const layout of ['table', 'grid', 'list']) {
    expect(presentations).toContain(`await expectPresentation(canvasElement, { layout: '${layout}', size: 'm' })`);
    expect(presentations).toContain(
      `await expectRecordedDestinations(canvasElement, { layout: '${layout}', size: 'm' })`,
    );
  }
  for (const control of ['library_layout_grid', 'library_layout_list']) {
    expect(presentations).toContain(`await userEvent.click(canvas.getByRole('button', { name: m.${control}() }))`);
  }
  for (const [name, size] of [
    ['SmallEntryGrid', 's'],
    ['MediumEntryGrid', 'm'],
    ['LargeEntryGrid', 'l'],
  ] as const) {
    expect(story(name)).toContain(`renderPattern({ layout: 'grid', size: '${size}' })`);
    expect(story(name)).toContain(`await expectPresentation(canvasElement, { layout: 'grid', size: '${size}' })`);
  }
  const sizes = story('EntryGridSizes');
  expect(sizes).toContain("await expectPresentation(canvasElement, { layout: 'grid', size: 's' })");
  expect(sizes).toContain("for (const size of ['m', 'l'] as const)");
  expect(sizes).toContain('m.library_size_medium()');
  expect(sizes).toContain('m.library_size_large()');
  expect(sizes).toContain("await userEvent.click(canvas.getByRole('button', { name: label }))");
  expect(sizes).toContain("await expectPresentation(canvasElement, { layout: 'grid', size })");

  const presentation = patterns.slice(
    patterns.indexOf('async function expectPresentation('),
    patterns.indexOf('async function expectRecordedDestinations('),
  );
  expect(presentation).toContain("view.matchMedia('(min-width: 640px)').matches");
  expect(presentation).toContain("if (display.layout === 'table' && !wide)");
  expect(presentation).toContain("await expect(body.getByRole('table')).toBeVisible()");
  expect(presentation).toContain("await expect(body.getByRole('list')).toBeVisible()");
  expect(presentation).toContain("expect(body.queryByRole('table')).toBeNull()");
  expect(presentation).toContain('getComputedStyle(grid).gridTemplateColumns');
  expect(presentation).toContain('{ s: 4, m: 3, l: 2 }[display.size]');
  expect(presentation).toContain('{ s: 6, m: 7.5, l: 9 }[display.size] * rem');

  const profileStates = story('ProfileStateDestinations');
  expect(profileStates).toContain('libraryStateOptions(release, type, getLocale())');
  expect(profileStates).toContain('expect([...new Set(recordedStates)].sort()).toEqual(profileStates.sort())');
  expect(profileStates).toContain("await expectRecordedDestinations(canvasElement, { layout: 'grid', size: 'm' })");
  expect(patterns).toContain('expect(subjectLinks.map((link) => link.textContent)).toEqual(titles)');
  expect(patterns).toContain('subjectHref({ id: entry.subject.id, label: title }, getLocale()).href');
  expect(patterns).toContain('libraryStateLabel(release, entry.subject.type, entry.state, getLocale())');
  expect(patterns).toContain('shelfHref(getLocale(), { state: entry.state, ...display })');
});
