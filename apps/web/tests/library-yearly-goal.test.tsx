import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { yearlyGoalSearch } from '../src/library/yearly-goal-address';
import { YearlyGoalPage } from '../src/library/yearly-goal-page';
import { libraryNavigationEntries } from '../src/library/library-nav';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, overwriteGetLocale } from '../src/paraglide/runtime.js';

test('year selection accepts the native Gregorian bounds and keeps invalid addresses distinct', () => {
  expect(yearlyGoalSearch({})).toEqual({ year: undefined });
  for (const year of [1, 2026, 9999]) {
    expect(yearlyGoalSearch({ year })).toEqual({ year });
    expect(yearlyGoalSearch({ year: String(year) })).toEqual({ year });
  }
  for (const year of [0, 10000, -1, 1.5, '', '02026', '1e3', 'invalid', ['2026'], null])
    expect(yearlyGoalSearch({ year })).toEqual({ year: 'invalid' });
});

test('all eight locales expose the goal destination, metric, unavailable coverage and selected-year history', () => {
  const original = getLocale;
  try {
    expect(locales).toHaveLength(8);
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      const { tabs } = libraryNavigationEntries('goals', { state: 'preparing' }, [], locale);
      expect(tabs.find((tab) => tab.id === 'goals')).toEqual({
        id: 'goals',
        label: m.library_yearly_goal_title(),
        href: `/${locale}/library/goals`,
        current: true,
      });
      const html = renderToStaticMarkup(<YearlyGoalPage year={2020} sessionState="signed-in" />);
      for (const text of [
        m.library_yearly_goal_metric(),
        m.library_yearly_goal_coverage(),
        m.library_yearly_goal_unavailable(),
      ])
        expect(html).toContain(renderToStaticMarkup(<p>{text}</p>).slice(3, -4));
      expect(html).toContain(`href="/${locale}/library/history?year=2020"`);
      expect(html).toContain(`action="/${locale}/library/goals"`);
      expect(html).toContain('method="get"');
      expect(html).toContain('value="2020"');
      expect(html).toContain('min-h-11');
      expect(html).not.toContain('progressbar');
      expect(html).not.toContain('name="target"');
    }
  } finally {
    overwriteGetLocale(original);
  }
});

test('year navigation respects bounds and rejects an invalid address without silently linking another year', () => {
  const first = renderToStaticMarkup(<YearlyGoalPage year={1} sessionState="signed-in" />);
  const last = renderToStaticMarkup(<YearlyGoalPage year={9999} sessionState="signed-in" />);
  expect(first).not.toContain('/goals?year=0');
  expect(first).toContain('/goals?year=2');
  expect(last).not.toContain('/goals?year=10000');
  expect(last).toContain('/goals?year=9998');
  const invalid = renderToStaticMarkup(<YearlyGoalPage sessionState="signed-in" />);
  expect(invalid).toContain('role="alert"');
  expect(invalid).toContain('aria-invalid="true"');
  expect(invalid).not.toContain('/history?year=');
});

test('retired, unresolved and signed-out sessions never present a target; sign-in retains the selected year', () => {
  for (const sessionState of ['signed-out', 'unknown', 'unavailable'] as const) {
    const html = renderToStaticMarkup(<YearlyGoalPage year={2020} sessionState={sessionState} />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('name="target"');
    expect(html).not.toContain('progressbar');
    if (sessionState === 'signed-out')
      expect(html).toContain(encodeURIComponent(`/${getLocale()}/library/goals?year=2020`));
  }
});
