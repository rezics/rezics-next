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
