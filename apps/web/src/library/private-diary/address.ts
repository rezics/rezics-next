export type DiaryAddress = { cursor?: string | undefined; year?: number | undefined; returnTo?: string | undefined };

export function diarySearch(search: Record<string, unknown>): DiaryAddress {
  const cursor = typeof search.cursor === 'string' && search.cursor.length <= 2048 ? search.cursor : undefined;
  const year =
    typeof search.year === 'number'
      ? search.year
      : typeof search.year === 'string' && /^[0-9]{1,4}$/.test(search.year)
        ? Number(search.year)
        : undefined;
  const returnTo = typeof search.returnTo === 'string' && search.returnTo.length <= 2048 ? search.returnTo : undefined;
  return {
    ...(cursor ? { cursor } : {}),
    ...(year !== undefined && Number.isInteger(year) && year >= 1 && year <= 9999 ? { year } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

export function sameDiaryAddress(a: DiaryAddress, b: DiaryAddress) {
  return a.cursor === b.cursor && a.year === b.year;
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
