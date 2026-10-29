export type Count = { value: number; relation: 'exact' | 'lower_bound' };

export function countFromLinks(
  count: { value: number; exact: boolean } | undefined,
  returned: number,
): Count | undefined {
  if (!count) return;
  return {
    value: Math.max(count.value, returned),
    relation: count.exact ? 'exact' : 'lower_bound',
  };
}

export function sumCounts(counts: readonly (Count | undefined)[]): Count | undefined {
  if (counts.length === 0 || counts.some((count) => count === undefined)) return;
  return {
    value: counts.reduce((sum, count) => sum + count!.value, 0),
    relation: counts.every((count) => count!.relation === 'exact') ? 'exact' : 'lower_bound',
  };
}

export function formatCount(count: Count | undefined, locale: string): string {
  if (!count) return '';
  const number = new Intl.NumberFormat(locale).format(count.value);
  return count.relation === 'lower_bound' ? `${number}+` : number;
}
