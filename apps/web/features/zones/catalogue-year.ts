/** A year the address names, or null when it names none. A value outside 1..9999 is dropped, not guessed. */
export function catalogueYearParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^[1-9][0-9]{0,3}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1 && year <= 9999 ? year : null;
}
