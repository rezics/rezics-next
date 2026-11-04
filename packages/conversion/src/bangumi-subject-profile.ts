import { liveActionWorkType } from './cross-media-entities.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
export const bangumiTVAnimeTemplateHead = '{{Infobox animanga/TVAnime';

export function isBangumiTVAnimeTemplateHead(line: string): boolean {
  return line.trim() === bangumiTVAnimeTemplateHead;
}

export type BangumiTVAnimeField = Readonly<{
  key: string;
  pointer: string;
  value: string;
  continuations: readonly string[];
}>;
export type BangumiTVAnimeInfoboxDiagnostic = Readonly<{ pointer: string; code: string }>;
export type BangumiTVAnimeInfobox = Readonly<{
  fields: readonly BangumiTVAnimeField[];
  diagnostics: readonly BangumiTVAnimeInfoboxDiagnostic[];
}>;

const infoboxFieldLimit = 64;
const infoboxDiagnosticLimit = 16;
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;

function* sourceLines(text: string): Generator<{ line: string; number: number }> {
  let start = 0;
  let number = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield { line, number };
    number++;
    if (newline === -1) return;
    start = newline + 1;
  }
}

function cleanHorizontal(value: string): string {
  return value.replace(horizontalSpace, '');
}

/** One bounded reader for the pinned TVAnime template used by names and work facts. */
export function parseBangumiTVAnimeInfobox(infobox: string): BangumiTVAnimeInfobox {
  const fields: { key: string; pointer: string; value: string; continuations: string[] }[] = [];
  const diagnostics: BangumiTVAnimeInfoboxDiagnostic[] = [];
  let overflow = false;
  let fieldOverflow = false;
  const omit = (pointer: string, code: string) => {
    if (code === 'additional_infobox_omissions') {
      if (!overflow) diagnostics.push({ pointer: '/infobox', code });
      overflow = true;
    } else if (diagnostics.length < infoboxDiagnosticLimit - 1) diagnostics.push({ pointer, code });
    else if (!overflow) {
      diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
      overflow = true;
    }
  };

  const iterator = sourceLines(infobox);
  let header: string | undefined;
  let candidate = iterator.next();
  while (!candidate.done) {
    if (candidate.value.line.trim()) {
      header = candidate.value.line;
      break;
    }
    candidate = iterator.next();
  }
  if (!header || !isBangumiTVAnimeTemplateHead(header)) {
    omit('/infobox', 'unsupported_infobox_template');
    return { fields, diagnostics };
  }

  let active: { key: string; pointer: string; value: string; continuations: string[] } | undefined;
  let fieldCount = 0;
  let closed = false;
  let trailing = false;
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value;
    const line = cleanHorizontal(row.line);
    if (!line) continue;
    if (line === '}}') {
      active = undefined;
      closed = true;
      continue;
    }
    if (closed) {
      trailing = true;
      continue;
    }
    if (line.startsWith('|')) {
      fieldCount++;
      if (fieldCount > infoboxFieldLimit) {
        active = undefined;
        if (!fieldOverflow) omit('/infobox', 'infobox_field_limit');
        fieldOverflow = true;
        continue;
      }
      const pointer = `/infobox/fields/${fieldCount - 1}`;
      const equals = line.indexOf('=', 1);
      if (equals < 0) {
        active = undefined;
        omit(pointer, 'unsupported_infobox_structure');
        continue;
      }
      const key = cleanHorizontal(line.slice(1, equals));
      if (!key) {
        active = undefined;
        omit(pointer, 'unsupported_infobox_structure');
        continue;
      }
      active = { key, pointer, value: cleanHorizontal(line.slice(equals + 1)), continuations: [] };
      fields.push(active);
      continue;
    }
    if (!active) omit(`/infobox/lines/${row.number}`, 'unsupported_infobox_structure');
    else active.continuations.push(line);
  }
  if (!closed) omit('/infobox', 'unsupported_infobox_structure');
  if (trailing) omit('/infobox', 'unsupported_infobox_structure');
  return { fields, diagnostics };
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
  const head = infobox.slice(0, 256).split('\n', 1)[0] ?? '';
  if (/realMovie/u.test(head)) return 'realMovie';
  if (/(?:\{\{Infobox(?:\s+|\/)|\/)TV\b/u.test(head)) return 'TV';
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

function gregorianDay(year: number, month: number, day: number): boolean {
  const february = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  const days = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}
