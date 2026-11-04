import { isBangumiBookTemplateHead, isBangumiTVAnimeTemplateHead } from './bangumi-subject-profile.ts';
import { bangumiTelevisionRunKeys } from './bangumi-television-run.ts';

export type BangumiSubjectName = Readonly<{
  property: 'schema:name' | 'schema:alternateName';
  language: 'und' | 'zh';
  text: string;
  pointer: string;
}>;
export type BangumiNameDiagnostic = Readonly<{ pointer: string; code: string }>;
export type BangumiNameExtraction = Readonly<{
  names: readonly BangumiSubjectName[];
  diagnostics: readonly BangumiNameDiagnostic[];
}>;
export type BangumiOfficialWebsite = Readonly<{ url: string; pointer: string }>;
export type BangumiSubjectProfileExtraction = Readonly<{
  names: readonly BangumiSubjectName[];
  officialWebsites: readonly BangumiOfficialWebsite[];
  diagnostics: readonly BangumiNameDiagnostic[];
}>;

const nameLimit = 24;
const fieldLimit = 64;
export const bangumiDiagnosticLimit = 16;
const diagnosticLimit = bangumiDiagnosticLimit;
const textLimit = 500;
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;
type NameField = {
  key: string;
  pointer: string;
  form: 'empty' | 'scalar' | 'list';
  values: string[];
  unsupported: boolean;
};

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

function plainName(value: string): string | undefined {
  const text = cleanHorizontal(value);
  if (!text.trim() || text.length > textLimit) return;
  // Template and link syntax has no admitted name semantics in this inventory.
  if (text.includes('{{') || text.includes('}}') || text.includes('[[') || text.includes(']]') || text.includes('|'))
    return;
  return text;
}

function officialWebsiteUrl(value: string): string | undefined {
  if (
    value.length > 1500 ||
    !value.isWellFormed() ||
    !/^https?:\/\/[^\s]+$/u.test(value) ||
    /[\u0000-\u0020\u007f-\u009f\\]/u.test(value) ||
    /%(?![0-9a-f]{2})/iu.test(value) ||
    value.includes('{{') ||
    value.includes('}}') ||
    value.includes('[[') ||
    value.includes(']]') ||
    value.includes('|')
  )
    return;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    )
      return;
  } catch {
    return;
  }
  return value;
}

function compareNames(left: BangumiSubjectName, right: BangumiSubjectName): number {
  const a = `${left.property}\u0000${left.language}\u0000${left.text}`;
  const b = `${right.property}\u0000${right.language}\u0000${right.text}`;
  return a < b ? -1 : a > b ? 1 : left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0;
}

/**
 * Extract only the admitted TVAnime or Book name fields. Unknown fields and wiki
 * structures remain bounded omissions; source spelling inside plain values is kept.
 */
export function extractBangumiSubjectProfile(
  record: {
    readonly type: number;
    readonly name: string;
    readonly name_cn?: string;
    readonly infobox?: string;
  },
  nativeType: string,
): BangumiSubjectProfileExtraction {
  const names: BangumiSubjectName[] = [];
  const seen = new Set<string>();
  const officialWebsites: BangumiOfficialWebsite[] = [];
  const seenWebsites = new Set<string>();
  const diagnostics: BangumiNameDiagnostic[] = [];
  let diagnosticOverflow = false;
  let fieldOverflow = false;

  const omit = (pointer: string, code: string) => {
    if (diagnostics.length < diagnosticLimit - 1) diagnostics.push({ pointer, code });
    else if (!diagnosticOverflow) {
      diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
      diagnosticOverflow = true;
    }
  };
  const addTopLevel = (
    property: BangumiSubjectName['property'],
    language: BangumiSubjectName['language'],
    raw: string,
  ) => {
    const tuple = `${property}\u0000${language}\u0000${raw}`;
    if (seen.has(tuple)) return;
    seen.add(tuple);
    if (names.length < nameLimit)
      names.push({ property, language, text: raw, pointer: language === 'zh' ? '/name_cn' : '/name' });
  };

  addTopLevel('schema:name', 'und', record.name);
  if (record.name_cn?.trim()) addTopLevel('schema:name', 'zh', record.name_cn);
  const book = record.type === 1 && nativeType === 'schema:Book';
  const tvAnime = record.type === 2 && nativeType === 'schema:TVSeries';
  if ((!book && !tvAnime) || record.infobox === undefined)
    return { names: names.sort(compareNames), officialWebsites, diagnostics };

  const infobox = record.infobox;
  const iterator = sourceLines(infobox);
  let header: { line: string; number: number } | undefined;
  let candidate = iterator.next();
  while (!candidate.done) {
    if (candidate.value.line.trim()) {
      header = candidate.value;
      break;
    }
    candidate = iterator.next();
  }
  if (!header || (book ? !isBangumiBookTemplateHead(header.line) : !isBangumiTVAnimeTemplateHead(header.line))) {
    omit('/infobox', 'unsupported_infobox_template');
    return { names: names.sort(compareNames), officialWebsites, diagnostics };
  }

  let fields = 0;
  let closed = false;
  let trailing = false;
  let active: NameField | undefined;

  const finishField = (field: NameField | undefined, complete = true) => {
    if (field?.key === '官方网站' && tvAnime) {
      if (!complete) {
        omit(field.pointer, 'unsupported_infobox_structure');
        return;
      }
      if (field.unsupported || field.values.length !== 1 || field.form !== 'scalar') {
        omit(field.pointer, 'unsupported_infobox_website_form');
        return;
      }
      const url = officialWebsiteUrl(field.values[0]!);
      if (url === undefined) omit(field.pointer, 'unsupported_infobox_website_form');
      else if (!seenWebsites.has(url)) {
        seenWebsites.add(url);
        officialWebsites.push({ url, pointer: field.pointer });
      }
      return;
    }
    if (!field || (field.key !== '中文名' && field.key !== '别名')) return;
    if (!complete) {
      omit(field.pointer, 'unsupported_infobox_structure');
      return;
    }
    if (field.unsupported) {
      omit(field.pointer, 'unsupported_infobox_name_form');
      return;
    }
    if (!field.values.length) return;

    const aliasProperty = book ? 'schema:name' : 'schema:alternateName';
    const property = field.key === '中文名' ? 'schema:name' : aliasProperty;
    const language = field.key === '中文名' ? 'zh' : 'und';
    const staged = field.values.map((value) => plainName(value));
    if (staged.some((text) => text === undefined)) {
      omit(field.pointer, 'unsupported_infobox_name_form');
      return;
    }
    const fieldNames = new Map<string, BangumiSubjectName>();
    for (const text of staged) {
      if (text === undefined) continue;
      const tuple = `${property}\u0000${language}\u0000${text}`;
      fieldNames.set(tuple, { property, language, text, pointer: field.pointer });
    }
    const additions = [...fieldNames].filter(([tuple]) => !seen.has(tuple));
    if (names.length + additions.length > nameLimit) {
      omit(field.pointer, 'infobox_name_limit');
      return;
    }
    for (const [tuple, name] of additions) {
      seen.add(tuple);
      names.push(name);
    }
  };

  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value;
    const line = cleanHorizontal(row.line);
    if (!line) continue;
    if (line === '}}') {
      finishField(active);
      active = undefined;
      closed = true;
      continue;
    }
    if (closed) {
      if (line.trim()) trailing = true;
      continue;
    }
    if (line.startsWith('|')) {
      finishField(active);
      fields++;
      if (fields > fieldLimit) {
        active = undefined;
        if (!fieldOverflow) omit('/infobox', 'infobox_field_limit');
        fieldOverflow = true;
        continue;
      }
      const equals = line.indexOf('=', 1);
      const pointer = `/infobox/fields/${fields - 1}`;
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
      const value = cleanHorizontal(line.slice(equals + 1));
      active = {
        key,
        pointer,
        form: 'empty',
        values: [],
        unsupported: false,
      };
      if (key === '中文名' || key === '别名') {
        if (value) {
          active.form = 'scalar';
          active.values.push(value);
        }
      } else if (!(tvAnime && (bangumiTelevisionRunKeys.has(key) || key === '官方网站')))
        omit(pointer, 'unsupported_infobox_key');
      continue;
    }
    if (!active) {
      omit(`/infobox/lines/${row.number}`, 'unsupported_infobox_structure');
      continue;
    }
    if (active.key === '官方网站') {
      active.unsupported = true;
      continue;
    }
    if (active.key !== '中文名' && active.key !== '别名') continue;
    const continuation = cleanHorizontal(line);
    if (continuation.startsWith('*')) {
      if (active.key !== '别名' || continuation.startsWith('**') || continuation === '*' || active.form === 'scalar') {
        active.unsupported = true;
        continue;
      }
      active.form = 'list';
      active.values.push(continuation.slice(1));
      continue;
    }
    if (active.key === '别名' && active.form === 'empty') {
      active.form = 'scalar';
      active.values.push(continuation);
    } else active.unsupported = true;
  }
  finishField(active, closed);
  if (!closed) omit('/infobox', 'unsupported_infobox_structure');
  if (trailing) omit('/infobox', 'unsupported_infobox_structure');
  return { names: names.sort(compareNames), officialWebsites, diagnostics };
}

/** Backward-compatible projection for callers that only consume the name fields. */
export function extractBangumiSubjectNames(
  record: {
    readonly type: number;
    readonly name: string;
    readonly name_cn?: string;
    readonly infobox?: string;
  },
  nativeType: string,
): BangumiNameExtraction {
  const profile = extractBangumiSubjectProfile(record, nativeType);
  return { names: profile.names, diagnostics: profile.diagnostics };
}
