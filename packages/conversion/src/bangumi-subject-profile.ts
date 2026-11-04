import { liveActionWorkType } from './cross-media-entities.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
export const bangumiTVAnimeTemplateHead = '{{Infobox animanga/TVAnime';
export const bangumiBookTemplateHead = '{{Infobox animanga/Book';

export const bangumiTVAnimeWorkEvidenceFields = {
  descriptiveLink: '链接',
  copyrightNotice: 'Copyright',
} as const;

export type BangumiTVAnimeWorkEvidenceField =
  (typeof bangumiTVAnimeWorkEvidenceFields)[keyof typeof bangumiTVAnimeWorkEvidenceFields];

export function isBangumiTVAnimeWorkEvidenceField(key: string): key is BangumiTVAnimeWorkEvidenceField {
  return (
    key === bangumiTVAnimeWorkEvidenceFields.descriptiveLink || key === bangumiTVAnimeWorkEvidenceFields.copyrightNotice
  );
}

export function isBangumiTVAnimeTemplateHead(line: string): boolean {
  return line.trim() === bangumiTVAnimeTemplateHead;
}

export function isBangumiBookTemplateHead(line: string): boolean {
  return line.trim() === bangumiBookTemplateHead;
}

/** Existing 1/2/4 class bindings. Type 2 stays TVSeries even when the platform names a film. */
export const bangumiLaunchTypes = {
  1: 'schema:Book',
  2: 'schema:TVSeries',
  4: 'schema:VideoGame',
} as const;

export function isAdmittedBangumiType(type: unknown): type is 1 | 2 | 3 | 4 | 6 {
  return type === 1 || type === 2 || type === 3 || type === 4 || type === 6;
}

export type ProfileSelection =
  | { readonly outcome: 'selected'; readonly type: string }
  | { readonly outcome: 'unknown_live_action_platform' };

/** Pinned Bangumi platform/template grain. Music has no admitted release/track type. */
export function selectBangumiProfile(input: {
  readonly type: 1 | 2 | 3 | 4 | 6;
  readonly platform?: string;
  readonly infobox?: string;
}): ProfileSelection {
  if (input.type === 1 || input.type === 2 || input.type === 4)
    return { outcome: 'selected', type: bangumiLaunchTypes[input.type] };
  if (input.type === 3) return { outcome: 'selected', type: 'schema:MusicAlbum' };
  const live = liveActionWorkType(input.platform);
  if (live) return { outcome: 'selected', type: live };
  const template = infoboxTemplate(input.infobox);
  if (template === 'realMovie') return { outcome: 'selected', type: 'schema:Movie' };
  if (template === 'TV') return { outcome: 'selected', type: 'schema:TVSeries' };
  if (!input.platform?.trim()) return { outcome: 'selected', type: 'schema:TVSeries' };
  return { outcome: 'unknown_live_action_platform' };
}

function infoboxTemplate(infobox: string | undefined): 'realMovie' | 'TV' | undefined {
  if (infobox === undefined) return;
  const head = infoboxHead(infobox);
  if (/realMovie/u.test(head)) return 'realMovie';
  if (/(?:\{\{Infobox(?:\s+|\/)|\/)TV\b/u.test(head)) return 'TV';
}

function infoboxHead(infobox: string): string {
  return infobox.slice(0, 256).split('\n', 1)[0] ?? '';
}

/** Pinned `{{Infobox animanga/TVAnime` grammar only; OVA/Movie/custom templates stay unmapped. */
export function isBangumiTvAnimeInfobox(infobox: string | undefined): boolean {
  if (infobox === undefined) return false;
  for (const line of infobox.split('\n')) {
    if (line.trim()) return isBangumiTVAnimeTemplateHead(line);
  }
  return false;
}

export type PublicationTime = {
  readonly time: string;
  readonly precision: 9 | 10 | 11;
  readonly calendarmodel: typeof gregorian;
};

/** Gregorian year/month/day only. Unparseable source text is withheld, never coerced. */
export function bangumiPublicationTime(value: string): PublicationTime | undefined {
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(value);
  if (!iso || iso[0] !== value) return;
  const year = iso[1]!;
  const month = iso[2];
  const day = iso[3];
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) return;
  if (day !== undefined && !gregorianDay(Number(year), Number(month!), Number(day))) return;
  return {
    time: `+${year}-${month ?? '00'}-${day ?? '00'}T00:00:00Z`,
    precision: day ? 11 : month ? 10 : 9,
    calendarmodel: gregorian,
  };
}

/** ISO dates plus explicit TVAnime 年月日 spellings; extra schedule text is not a date. */
export function bangumiSourceTime(value: string): PublicationTime | undefined {
  const iso = bangumiPublicationTime(value);
  if (iso) return iso;
  const chinese = /^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/u.exec(value);
  if (!chinese || chinese[0] !== value) return;
  const year = chinese[1]!;
  const month = chinese[2] === undefined ? undefined : chinese[2].padStart(2, '0');
  const day = chinese[3] === undefined ? undefined : chinese[3].padStart(2, '0');
  return bangumiPublicationTime([year, month, day].filter((part): part is string => part !== undefined).join('-'));
}

export function gregorianMonthDays(year: number, month: number): number {
  const february = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function gregorianDay(year: number, month: number, day: number): boolean {
  return day >= 1 && day <= gregorianMonthDays(year, month);
}
