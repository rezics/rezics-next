import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';

/** Content text keeps one paragraph per line; blank lines separate nothing. */
export const paragraphs = (text: string) => text.split('\n').filter(line => line.trim());

// Tags that name no one language: undetermined, several, none.
const unstated = new Set(['und', 'mul', 'zxx']);
const primary = (tag: string) => tag.toLowerCase().split('-')[0]!;

/** CLDR's name for `und`; ICU names it after its root locale, "root", which no reader should see. */
const unknownLanguage: Partial<Record<UiLocale, string>> = { en: 'Unknown language', 'zh-Hans': '未知语言' };

/** A BCP 47 tag's name in the interface language ("zh-Hant" → "繁体中文"), or the tag itself. */
export function languageName(tag: string, locale: UiLocale): string {
  if (primary(tag) === 'und') return unknownLanguage[locale] ?? unknownLanguage.en!;
  try {
    return new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export const formatNumber = (value: number, locale: UiLocale, digits = 0) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

export const formatShare = (part: number, whole: number, locale: UiLocale) =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(whole ? part / whole : 0);

// Main's Work semantic types (`WORK_SEMANTIC_TYPES` in services/main/src/modules/work/activate.ts).
const typeLabels = {
  'https://schema.org/Book': 'book',
  'https://schema.org/DigitalDocument': 'digitalDocument',
  'https://schema.org/Recipe': 'recipe',
} as const satisfies Record<string, keyof WorkPageMessages>;

/** Labels for the types the interface knows; an unknown type is left out rather than shown as an IRI. */
export function typeNames(types: readonly string[], t: Pick<WorkPageMessages, (typeof typeLabels)[keyof typeof typeLabels]>) {
  return types.flatMap(type => type in typeLabels ? [t[typeLabels[type as keyof typeof typeLabels]]] : []);
}

const uuidV7 = /([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * When Main minted a native ID. Main mints time-ordered UUIDv7s, whose first
 * 48 bits are the Unix time in milliseconds, so a revision's or a
 * publication's ID dates it. Null for any other kind of ID.
 */
export function mintedAt(iri: string): Date | null {
  const match = uuidV7.exec(iri);
  if (!match) return null;
  const date = new Date(Number.parseInt(`${match[1]}${match[2]}`, 16));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A Main timestamp as an ISO string. Main's contract types date-times as
 * strings, but the Eden client revives them into `Date`s; every use goes
 * through here so server and browser render the same attribute.
 */
export const isoTime = (value: string | Date): string => new Date(value).toISOString();

/** "27 Sept 2026", "2026年9月27日": a calendar date in the interface language, in UTC so it never depends on the server. */
export const formatDate = (date: Date, locale: UiLocale) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);

const units = [['year', 365 * 86_400], ['month', 30 * 86_400], ['week', 7 * 86_400], ['day', 86_400],
  ['hour', 3_600], ['minute', 60]] as const;

/**
 * "3 days ago" within a month, the date after that, as Royal Road and
 * KadoKado date a serial's last update. `now` is passed in so the server and
 * the browser agree.
 */
export function sinceWhen(iso: string | Date, locale: UiLocale, now: Date): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const seconds = (now.getTime() - then.getTime()) / 1000;
  if (seconds < 0 || seconds >= 30 * 86_400) return formatDate(then, locale);
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? ['minute', 60];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
}

// Scripts that name a language family, for telling whether a title is already in the reader's language.
const scripts: Record<string, RegExp> = {
  zh: /\p{Script=Han}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, ko: /\p{Script=Hangul}/u,
};

/**
 * Whether a title shown in another language than the reader asked for needs
 * saying so. Main names a title's language as its record states it, and
 * older records can mislabel one; a title whose script is the interface
 * language's own ("雨夜书店" in Chinese) reads as the reader's already. A
 * record that states no language (`und`) is not known to be in another one.
 */
export function titleNeedsLanguageNote(title: { value: string; language: string; basis: 'requested' | 'fallback' },
  locale: UiLocale): boolean {
  if (title.basis !== 'fallback' || unstated.has(primary(title.language))) return false;
  const wanted = primary(locale);
  if (primary(title.language) === wanted) return false;
  // A CJK interface judges by script; a Latin-script one by the tag, since Latin text alone can't tell English from German.
  const script = scripts[wanted];
  return script ? !script.test(title.value) : true;
}

const chineseDigits = '零一二三四五六七八九';
/** Chinese numerals as volumes are counted (1 → 一, 10 → 十, 21 → 二十一, 105 → 一百零五); past 9999, digits. */
export function chineseNumeral(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 9999) return String(value);
  if (value < 10) return chineseDigits[value]!;
  const units = ['', '十', '百', '千'];
  const digits = String(value).split('').map(Number);
  let out = '';
  let zero = false;
  for (const [index, digit] of digits.entries()) {
    const unit = units[digits.length - 1 - index]!;
    if (digit === 0) { zero = out !== ''; continue; }
    if (zero) out += '零';
    zero = false;
    out += (digit === 1 && unit === '十' && index === 0 ? '' : chineseDigits[digit]!) + unit;
  }
  return out;
}

/** "Volume 2" in the interface language; Chinese counts volumes in Chinese numerals (第二卷). */
export function volumeName(number: number, locale: UiLocale,
  t: { volumeNumber: (values: { number: string }) => string }): string {
  return t.volumeNumber({ number: locale.startsWith('zh') ? chineseNumeral(number)
    : new Intl.NumberFormat(locale).format(number) });
}

/**
 * Whether a title already says its place ("Chapter 24", "Letter 3", "第三章 最后一班车", "番外一"):
 * then no generated number is set beside it, so a reader never meets two numbers for one chapter.
 */
export function numberedTitle(title: string | null | undefined): boolean {
  return !!title && /^(?:(?:chapter|letter|part|book|volume|vol\.|episode|extra)\s*[0-9ivxlcdm]+\b|[0-9]+\s*[.、:：]|第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节回卷部集篇话幕]|番外\s*[0-9一二三四五六七八九十]+)/iu
    .test(title.trim());
}
