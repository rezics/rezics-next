import { describe, expect, test } from 'vitest';
import type { ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import type { AdaptContext } from '../realm/adapt.ts';
import { loadRankingsModule } from '../realm/modules.ts';
import type { Loaded, RankingPage } from '../realm/types.ts';
import { messages } from '../zones/messages.ts';
import { defaultPresentation, placedModule } from '../zones/presentation.ts';
import { loadPreviewHomeModules } from './home-modules.ts';
import { collectionPreview, previewCollection, previewReaders, previewSummary, previewWork } from './home-modules.fixtures.ts';

const context: AdaptContext = { locale: 'en', ref: 'harbor', realm: previewCollection };
const module = defaultPresentation(messages).modules.find(item => item.type === 'ranking')!;
const intervals = ['day', 'week', 'month'] as const;
type Interval = typeof intervals[number];

function page(interval: Interval, populated = true, nextCursor: string | null = null, count = 1): RankingPage {
  return { metric: 'reads', interval, nextCursor, items: populated ? Array.from({ length: count }, (_, index) => ({
    id: `https://rezics.com/id/00000000-0000-4000-8000-${String(602 + index).padStart(12, '0')}`,
    title: previewSummary.name, address: previewSummary.address,
    cover: previewSummary.avatar, types: [], tagline: null, completionStatus: null,
    chapterCount: null, wordCount: null, lastUpdatedAt: null,
  })) : [] } as unknown as RankingPage;
}

function readers(answer: (interval: Interval) => Loaded<RankingPage>) {
  return { cards: async () => new Map<string, ZoneWork>(),
    rankings: async (_realm: string, _locale: UiLocale, interval: Interval) => answer(interval) };
}

describe('preview ranking reads', () => {
  test.each(intervals)('a failed %s interval cannot disappear behind successful tabs', async refused => {
    const read = readers(interval => interval === refused ? { ok: false, failure: 'unavailable' }
      : { ok: true, data: page(interval) });
    expect(await loadRankingsModule(module, context, read)).toEqual({ state: 'failed' });
  });

  test('successful intervals retain Main’s day, week and month order', async () => {
    const state = await loadRankingsModule(module, context, readers(interval => ({ ok: true, data: page(interval) })));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('Ranking did not load');
    expect(state.data.tabs.map(tab => tab.interval)).toEqual(intervals);
    expect(state.data.tabs.every(tab => tab.items[0]?.work.id === previewWork)).toBe(true);
  });

  test.each(intervals)('an underfilled continued %s interval refuses the whole chart', async continued => {
    const state = await loadRankingsModule(module, context, readers(interval => ({ ok: true,
      data: page(interval, true, interval === continued ? 'more' : null) })));
    expect(state).toEqual({ state: 'failed' });
  });

  test('a full requested chart window may stop while an empty continued window cannot', async () => {
    expect((await loadRankingsModule(module, context,
      readers(interval => ({ ok: true, data: page(interval, true, 'more', 10) })))).state).toBe('ready');
    expect(await loadRankingsModule(module, context,
      readers(interval => ({ ok: true, data: page(interval, false, 'more') })))).toEqual({ state: 'failed' });
  });

  test('genuinely empty intervals stay empty without hiding a refused read', async () => {
    const state = await loadRankingsModule(module, context,
      readers(interval => ({ ok: true, data: page(interval, interval === 'week') })));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('Ranking did not load');
    expect(state.data.tabs.map(tab => tab.interval)).toEqual(['week']);
    expect(await loadRankingsModule(module, context,
      readers(interval => ({ ok: true, data: page(interval, false) })))).toEqual({ state: 'empty' });
  });

  test('the saved default ranking exposes a public-read refusal as a failed preview region', async () => {
    const preview = collectionPreview();
    preview.presentation.modules = [module];
    preview.moduleData = [{ id: module.id, sources: [{ source: module.source, state: 'public-read', members: [] }] }];
    const read = previewReaders();
    read.publicModules = async (_presentation, context) => [{ module: { ...placedModule(module, null), type: 'ranking' },
      state: await loadRankingsModule(module, context, readers(interval => interval === 'week'
        ? { ok: false, failure: 'missing' } : { ok: true, data: page(interval) })) }];
    expect((await loadPreviewHomeModules(preview, preview.presentation, context, read)).modules[0]?.state)
      .toEqual({ state: 'failed' });
  });
});
