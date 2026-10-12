import { describe, expect, test } from 'vitest';
import { defaultShowcase } from './default-showcase.fixtures.ts';
import { previewReaders, previewWork } from './home-modules.fixtures.ts';
import { loadDocumentHomeModules, localizedHomePresentation } from './home-modules.ts';
import { zoneHomeProse } from './home-document.tsx';

const context = { locale: 'en' as const, ref: 'harbor', realm: 'harbor' };

describe('resolved default Showcase delivery', () => {
  for (const mode of ['saved', 'public']) {
    test(`${mode} selection with no modules renders one hero and retains prose`, async () => {
      const { selected, page } = defaultShowcase();
      const result = await loadDocumentHomeModules(page, selected, localizedHomePresentation(selected.presentation, 'en'),
        context, previewReaders(), 'Featured');
      expect(result.modules).toHaveLength(1);
      expect(result.modules[0]?.state).toMatchObject({ state: 'ready', data: {
        slides: [{ id: 'default-slide', title: { value: 'The default Showcase' } }],
      } });
      expect(result.representedShowcases).toEqual(['$default']);
      expect(zoneHomeProse(page.document, page.blocks, result.representedShowcases).doc.content).toEqual([
        page.document.doc.content![0],
      ]);
    });
  }

  test('an already represented hero with identical slides is not duplicated', async () => {
    const { selected, page } = defaultShowcase();
    selected.presentation.modules = [{ id: 'featured', type: 'hero-carousel', title: 'Featured',
      source: { kind: 'query-block', block: 'selected-query' } }];
    const result = await loadDocumentHomeModules(page, selected, localizedHomePresentation(selected.presentation, 'en'),
      context, previewReaders(), 'Featured');
    expect(result.modules).toHaveLength(1);
    expect(result.representedShowcases).toEqual(['$default']);
  });

  test('an empty default Showcase retains its original fallback', async () => {
    const { selected, page } = defaultShowcase();
    page.showcaseData!.slides = [];
    const result = await loadDocumentHomeModules(page, selected, localizedHomePresentation(selected.presentation, 'en'),
      context, previewReaders(), 'Featured');
    expect(result.representedShowcases).toEqual([]);
    expect(zoneHomeProse(page.document, page.blocks, result.representedShowcases)).toBe(page.document);
  });

  test('a failed default Showcase retains its fallback beside a visible failed region', async () => {
    const { selected, page } = defaultShowcase();
    page.showcaseData!.slides = [{ id: 'unavailable-slide', work: previewWork }];
    const readers = previewReaders();
    readers.summaries = async () => new Map();
    const result = await loadDocumentHomeModules(page, selected, localizedHomePresentation(selected.presentation, 'en'),
      context, readers, 'Featured');
    expect(result.modules[0]?.state).toEqual({ state: 'failed' });
    expect(result.representedShowcases).toEqual([]);
    expect(zoneHomeProse(page.document, page.blocks, result.representedShowcases)).toBe(page.document);
  });
});
