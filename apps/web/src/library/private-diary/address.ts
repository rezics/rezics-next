import type { KernelClient } from '@rezics/client';

type DiaryQuery = NonNullable<Parameters<KernelClient['libraryDiary']['get']>[0]>['query'];
export type DiaryAddress = {
  cursor?: string | undefined;
  year?: number | undefined;
  month?: NonNullable<DiaryQuery>['month'] | undefined;
  focus?: string | undefined;
  returnTo?: string | undefined;
};

export function diarySearch(search: Record<string, unknown>): DiaryAddress {
  const cursor = typeof search.cursor === 'string' && search.cursor.length <= 2048 ? search.cursor : undefined;
  const year =
    typeof search.year === 'number'
      ? search.year
      : typeof search.year === 'string' && /^[0-9]{1,4}$/.test(search.year)
        ? Number(search.year)
        : undefined;
  const validYear = year !== undefined && Number.isInteger(year) && year >= 1 && year <= 9999;
  const month =
    search.month === 'unallocated'
      ? 'unallocated'
      : typeof search.month === 'number'
        ? search.month
        : typeof search.month === 'string' && /^[0-9]{1,2}$/.test(search.month)
          ? Number(search.month)
          : undefined;
  const validMonth =
    month === 'unallocated' || (typeof month === 'number' && Number.isInteger(month) && month >= 1 && month <= 12);
  const focus = typeof search.focus === 'string' && search.focus.length <= 128 ? search.focus : undefined;
  const returnTo = typeof search.returnTo === 'string' && search.returnTo.length <= 2048 ? search.returnTo : undefined;
  return {
    ...(cursor ? { cursor } : {}),
    ...(validYear ? { year } : {}),
    ...(validYear && validMonth ? { month } : {}),
    ...(focus ? { focus } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

export function sameDiaryAddress(a: DiaryAddress, b: DiaryAddress) {
  return a.cursor === b.cursor && a.year === b.year && a.month === b.month;
}

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f]/.test(value)) return '/library';
  try {
    const parsed = new URL(value, 'https://rezics.invalid');
    return parsed.origin === 'https://rezics.invalid' && parsed.pathname !== '/library/history'
      ? parsed.pathname + parsed.search + parsed.hash
      : '/library';
  } catch {
    return '/library';
  }
}

export function diaryReturnContext(address: DiaryAddress): string {
  const query = new URLSearchParams();
  if (address.cursor) query.set('cursor', address.cursor);
  if (address.year !== undefined) query.set('year', String(address.year));
  if (address.month !== undefined) query.set('month', String(address.month));
  if (address.focus) query.set('focus', address.focus);
  if (address.returnTo) query.set('returnTo', safeReturnTo(address.returnTo));
  return '/library/history' + (query.size ? '?' + query.toString() : '');
}

export function historyReturn(value: unknown): DiaryAddress | undefined {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/library/history')) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    if (url.origin !== 'https://rezics.invalid' || url.pathname !== '/library/history' || url.hash) return;
    return diarySearch(Object.fromEntries(url.searchParams));
  } catch {
    return;
  }
}
