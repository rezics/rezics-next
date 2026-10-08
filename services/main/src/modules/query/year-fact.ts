/** First-publication directory. The ascending key is the inverted calendar year,
 * so the existing `(key, id)` walk is newest first. These literals match the
 * native directory; disclosure stays outside the key. */
export const FIRST_PUBLICATION_GRAPH = 'urn:rezics:graph:current';
export const FIRST_PUBLICATION_PREDICATE = 'https://rezics.com/vocab/work';
export const FIRST_PUBLICATION_ANCHOR = 'urn:rezics:template-anchor:first-publication';
export const FIRST_PUBLICATION_TYPE = 'https://rezics.com/vocab/FirstPublication';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DATE = /^(\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DATE_TIME = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export function invertedPublicationYear(year: number): string {
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new Error('publication year is outside 1..9999');
  return String(10000 - year).padStart(4, '0');
}

export function publicationYearFromKey(key: string): number {
  if (!/^\d{4}$/.test(key)) throw new Error('publication year key is invalid');
  const year = 10000 - Number(key);
  if (year < 1 || year > 9999) throw new Error('publication year key is invalid');
  return year;
}

export function publicationYearBoundsError(fromYear: number | undefined, toYear: number | undefined): string | null {
  for (const year of [fromYear, toYear]) {
    if (year === undefined) continue;
    if (!Number.isInteger(year) || year < 1 || year > 9999) return 'publication year is outside 1..9999';
  }
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) return 'publication year range is empty';
  return null;
}

export function publicationRowKey(id: string, year: string): string {
  return `${id}\0${year}`;
}

/** Same work and year keeps the first statement. A different year is another row. */
export function keepPublicationRow(seen: Set<string>, id: string, year: string): boolean {
  const key = publicationRowKey(id, year);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function calendarDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function digits(value: string): number {
  if (value.length > 9) return -1;
  const year = Number(value);
  return Number.isInteger(year) ? year : -1;
}

/** Year field of the typed lexical form. A timezone does not move that field,
 * and an invalid calendar day is not a publication year. */
export function publicationCalendarYear(datatype: string, lexical: string): number | null {
  let year = -1;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  if (datatype === `${XSD}gYear`) {
    if (!/^\d{4,}$/.test(lexical)) return null;
    year = digits(lexical);
  } else if (datatype === `${XSD}date`) {
    const match = DATE.exec(lexical);
    if (!match) return null;
    year = digits(match[1]!);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (datatype === `${XSD}dateTime`) {
    const match = DATE_TIME.exec(lexical);
    if (!match) return null;
    year = digits(match[1]!);
    month = Number(match[2]);
    day = Number(match[3]);
    hour = Number(match[4]);
    minute = Number(match[5]);
    second = Number(match[6]);
  } else return null;
  if (year < 1 || year > 9999 || !calendarDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return year;
}
