import type { ConversionDiagnostic } from './index.ts';
import {
  bangumiSourceTime,
  gregorianMonthDays,
  isBangumiTvAnimeInfobox,
  type PublicationTime,
} from './bangumi-subject-profile.ts';
import { exactUnitlessIntegerQuantity } from './support.ts';

const startKey = '放送开始';
const endKey = '播放结束';
const totalKey = '话数';
const weekdayKey = '放送星期';
const unknownTotals = new Set(['', '*', '?', '？', '未知', '未定', 'TBA']);

export type TelevisionRunFact = {
  readonly property: 'schema:datePublished' | 'schema:endDate' | 'schema:numberOfEpisodes';
  readonly content: unknown;
  readonly field: 'datePublished' | 'endDate' | 'numberOfEpisodes';
};

export type TelevisionRunMapping = {
  readonly handledInfobox: boolean;
  readonly facts: readonly TelevisionRunFact[];
  readonly diagnostics: readonly ConversionDiagnostic[];
};

/** Type-2 TVAnime original-run start/end and exact episode total only. */
export function bangumiTelevisionRun(record: {
  readonly type: number;
  readonly infobox?: string;
  readonly date?: string;
}): TelevisionRunMapping {
  if (record.type !== 2 || !isBangumiTvAnimeInfobox(record.infobox))
    return { handledInfobox: false, facts: [], diagnostics: [] };
  const fields = parseInfoboxScalars(record.infobox!);
  const diagnostics: ConversionDiagnostic[] = [];
  const facts: TelevisionRunFact[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.size >= 64) {
      diagnostics.push({ pointer: '/infobox', code: 'infobox_field_limit' });
      break;
    }
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    if (field.key === startKey || field.key === endKey || field.key === totalKey) continue;
    diagnostics.push({
      pointer: infoboxPointer(field.key),
      code: field.key === weekdayKey ? 'unsupported_schedule_text' : 'unsupported_infobox_mapping',
    });
  }

  const startField = first(fields, startKey);
  const endField = first(fields, endKey);
  const totalField = first(fields, totalKey);
  let start = startField ? parseRunDate(startField, startKey, diagnostics) : undefined;
  const end = endField ? parseRunDate(endField, endKey, diagnostics) : undefined;
  if (start && record.date?.trim()) {
    const top = bangumiSourceTime(record.date.trim());
    if (top && !containsRange(span(top), span(start))) {
      diagnostics.push({ pointer: infoboxPointer(startKey), code: 'conflicting_publication_dates' });
      start = undefined;
    }
  }
  if (start && end && span(end).to < span(start).from) {
    diagnostics.push({ pointer: infoboxPointer(endKey), code: 'impossible_run_order' });
  } else {
    if (start) facts.push({ property: 'schema:datePublished', content: start, field: 'datePublished' });
    if (end) facts.push({ property: 'schema:endDate', content: end, field: 'endDate' });
  }
  if (totalField !== undefined) {
    const total = parseEpisodeTotal(totalField, diagnostics);
    if (total) facts.push({ property: 'schema:numberOfEpisodes', content: total, field: 'numberOfEpisodes' });
  }
  return { handledInfobox: true, facts, diagnostics };
}

function parseRunDate(
  field: InfoboxScalar,
  key: string,
  diagnostics: ConversionDiagnostic[],
): PublicationTime | undefined {
  const pointer = infoboxPointer(key);
  if (field.nested) {
    diagnostics.push({ pointer, code: 'unsupported_schedule_text' });
    return;
  }
  const value = field.value.trim();
  if (!value) return;
  const time = bangumiSourceTime(value);
  if (time) return time;
  diagnostics.push({ pointer, code: 'unsupported_schedule_text' });
}

function parseEpisodeTotal(
  field: InfoboxScalar,
  diagnostics: ConversionDiagnostic[],
): { amount: string; unit: '1' } | undefined {
  const pointer = infoboxPointer(totalKey);
  if (field.nested) {
    diagnostics.push({ pointer, code: 'unsupported_episode_total' });
    return;
  }
  const value = field.value.trim();
  if (unknownTotals.has(value)) {
    diagnostics.push({ pointer, code: 'unknown_episode_total' });
    return;
  }
  const quantity = exactUnitlessIntegerQuantity(value);
  if (quantity) return quantity;
  diagnostics.push({ pointer, code: 'unsupported_episode_total' });
}

type InfoboxScalar = { readonly key: string; readonly value: string; readonly nested: boolean };

function parseInfoboxScalars(infobox: string): InfoboxScalar[] {
  const fields: InfoboxScalar[] = [];
  for (const line of infobox.split('\n')) {
    if (fields.length >= 64) break;
    if (!line.startsWith('|')) continue;
    const eq = line.indexOf('=');
    if (eq < 2 || eq > 65) continue;
    const key = line.slice(1, eq);
    if (!key || key.includes('|')) continue;
    const value = line.slice(eq + 1).replace(/\r$/u, '');
    fields.push({ key, value, nested: value.trimStart().startsWith('{') });
  }
  return fields;
}

function first(fields: readonly InfoboxScalar[], key: string): InfoboxScalar | undefined {
  return fields.find((field) => field.key === key);
}

function infoboxPointer(key: string): string {
  return `/infobox/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function span(time: PublicationTime): { from: string; to: string } {
  const year = time.time.slice(1, 5);
  const month = time.time.slice(6, 8);
  const day = time.time.slice(9, 11);
  if (time.precision === 11) return { from: `${year}-${month}-${day}`, to: `${year}-${month}-${day}` };
  if (time.precision === 10) {
    const last = String(gregorianMonthDays(Number(year), Number(month))).padStart(2, '0');
    return { from: `${year}-${month}-01`, to: `${year}-${month}-${last}` };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function containsRange(outer: { from: string; to: string }, inner: { from: string; to: string }): boolean {
  return outer.from <= inner.from && inner.to <= outer.to;
}
