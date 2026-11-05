import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { getLocale, overwriteGetLocale } from '../src/paraglide/runtime.js';
import { RecentPanel } from '../src/search/recent-panel';
import type { RecentHistory } from '../src/search/recent-history';
import { TrendingSearchesSection } from '../src/search/trending-section';

const query = 'Kokoro「こころ」';
const display = '小王子';
const history = (extra: Partial<RecentHistory> = {}): RecentHistory => ({
  entries: extra.entries ?? [{ id: '1', query, visitedAt: 1 }],
  persistence: 'local',
  sync: 'local-only',
  remember() {},
  remove() {},
  retry() {},
  ...extra,
});
const copy = (locale: string) => ({ locale: locale as never });
const recent = (language: string, extra?: Partial<Parameters<typeof RecentPanel>[0]>) =>
  renderToStaticMarkup(createElement(RecentPanel, { language, global: false, history: history(), ...extra }));
const trending = (
  language: string | undefined,
  state: Parameters<typeof TrendingSearchesSection>[0]['state'],
  onRetry?: () => void,
) => renderToStaticMarkup(createElement(TrendingSearchesSection, { language, state, onRetry }));

test('default header Recent and Trending copy follows the supplied language against the opposite ambient locale', () => {
  const previous = getLocale;
  try {
    for (const [language, ambient] of [
      ['en', 'zh-Hans'],
      ['zh-Hans', 'en'],
    ] as const) {
      overwriteGetLocale(() => ambient);
      const options = copy(language);
      const opposite = copy(ambient);
      const empty = recent(language, { history: history({ entries: [] }) });
      expect(empty).toContain(m.header_search_recent({}, options));
      expect(empty).toContain(`aria-label="${m.header_search_recent({}, options)}"`);
      expect(empty).toContain(m.header_search_history({}, options));
      expect(empty).toContain(m.header_search_recent_empty({}, options));
      expect(empty).not.toContain(m.header_search_recent({}, opposite));
      expect(empty).not.toContain(m.header_search_recent_empty({}, opposite));

      const pending = recent(language, { history: history({ persistence: 'memory', sync: 'pending' }) });
      expect(pending).toContain(m.header_search_history_pending({}, options));
      expect(pending).toContain(query);
      expect(pending).toContain(m.header_search_remove_recent({ name: query }, options));
      expect(pending).not.toContain(m.header_search_history_pending({}, opposite));
      expect(pending).not.toContain(m.header_search_remove_recent({ name: query }, opposite));

      expect(recent(language, { history: history({ failure: 'conflict' }) })).toContain(
        m.search_history_conflict({}, options),
      );
      expect(recent(language, { history: history({ failure: 'unavailable' }) })).toContain(
        m.search_history_offline({}, options),
      );
      expect(recent(language, { history: history({ persistence: 'unavailable' }) })).toContain(
        m.shell_account_unavailable({}, options),
      );
      expect(recent(language, { history: history({ failure: 'conflict' }) })).toContain(
        m.search_history_reload({}, options),
      );

      const custom = recent(language, { recent: createElement('p', null, 'Custom recent') });
      expect(custom).toContain('Custom recent');
      expect(custom).not.toContain(m.header_search_recent({}, options));

      const ready = trending(language, {
        status: 'ready',
        page: { trendingSearches: [{ query: '"The Little Prince"', display }], next: null },
      });
      expect(ready).toContain(m.header_search_trending_searches({}, options));
      expect(ready).toContain(`aria-label="${m.header_search_trending_searches({}, options)}"`);
      expect(ready).toContain(display);
      expect(ready).not.toContain('The Little Prince');
      expect(ready).not.toContain(m.header_search_trending_searches({}, opposite));

      const preparing = trending(language, { status: 'preparing' }, () => {});
      expect(preparing).toContain(m.discovery_not_ready({}, options));
      expect(preparing).toContain(m.search_facet_retry({}, options));
      expect(preparing).not.toContain(m.discovery_not_ready({}, opposite));

      const waiting = trending(language, { status: 'unavailable', retryAt: Date.now() + 60_000 }, () => {});
      expect(waiting).toContain(m.search_recovery_wait({}, options));
      expect(waiting).toContain(m.search_facet_retry({}, options));
      expect(waiting).not.toContain(m.search_recovery_wait({}, opposite));
      expect(getLocale()).toBe(ambient);
    }

    overwriteGetLocale(() => 'ja');
    const together = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(RecentPanel, { language: 'en', global: false, history: history({ entries: [] }) }),
        createElement(RecentPanel, { language: 'zh-Hans', global: false, history: history({ entries: [] }) }),
        createElement(TrendingSearchesSection, { language: 'en', state: { status: 'preparing' } }),
        createElement(TrendingSearchesSection, { language: 'zh-Hans', state: { status: 'preparing' } }),
      ),
    );
    expect(together).toContain(m.header_search_recent({}, copy('en')));
    expect(together).toContain(m.header_search_recent({}, copy('zh-Hans')));
    expect(together).toContain(m.discovery_not_ready({}, copy('en')));
    expect(together).toContain(m.discovery_not_ready({}, copy('zh-Hans')));
    expect(trending(undefined, { status: 'preparing' })).toContain(m.discovery_not_ready());
    expect(getLocale()).toBe('ja');
  } finally {
    overwriteGetLocale(previous);
  }
});
