export type LoansFilter = 'open' | 'history';
export type LoansQuery = { filter?: unknown; cursor?: unknown };
export type LoansAddress = {
  filter: LoansFilter;
  cursor: string | null;
  locale: string;
  issue?: 'filter' | 'cursor';
};

const absent = (value: unknown) => value === undefined || value === '';

export function loansQuery(input: unknown): LoansQuery {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  return {
    ...(record.filter !== undefined ? { filter: record.filter } : {}),
    ...(record.cursor !== undefined ? { cursor: record.cursor } : {}),
  };
}

export function loansAddress(input: unknown, locale: string): LoansAddress {
  const query = loansQuery(input);
  const filterValid = absent(query.filter) || query.filter === 'open' || query.filter === 'history';
  const cursorValid = absent(query.cursor) || (typeof query.cursor === 'string' && query.cursor.length <= 4096);
  const issue = !filterValid ? 'filter' : !cursorValid ? 'cursor' : undefined;
  return {
    filter: query.filter === 'history' ? 'history' : 'open',
    cursor: typeof query.cursor === 'string' && query.cursor !== '' ? query.cursor : null,
    locale,
    ...(issue ? { issue } : {}),
  };
}

export function sameLoansAddress(a: LoansAddress, b: LoansAddress): boolean {
  return a.filter === b.filter && a.cursor === b.cursor && a.locale === b.locale && a.issue === b.issue;
}
