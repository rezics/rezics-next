/** Keep invalid addresses distinct from an omitted year; never silently select another year's goal. */
export function yearlyGoalSearch(search: Record<string, unknown>): { year: number | 'invalid' | undefined } {
  if (search.year === undefined) return { year: undefined };
  const text = typeof search.year === 'number' ? String(search.year) : search.year;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,3}$/.test(text)) return { year: 'invalid' };
  return { year: Number(text) };
}
