import { diaryReturnContext } from '../private-diary/address';
import type { ReadingInsightsOverview } from './native';

export type InsightsSearch = { year?: number | 'invalid' };

/** The URL is an external input; an invalid explicit year must never select a different year. */
export function insightsSearch(search: Record<string, unknown>): InsightsSearch {
  if (search.year === undefined) return {};
  const value = typeof search.year === 'string' && /^[0-9]{1,4}$/.test(search.year) ? Number(search.year) : search.year;
  return {
    year: typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9999 ? value : 'invalid',
  };
}

export function insightsHref(year: number, locale: string) {
  return `/${locale}/library/insights?year=${year}`;
}

/** Diary owns the address. Only the native action's supplied operands are forwarded. */
export function insightsDiaryHref(action: ReadingInsightsOverview['actions']['diary'], locale: string) {
  return `/${locale}${diaryReturnContext(action.query)}`;
}
