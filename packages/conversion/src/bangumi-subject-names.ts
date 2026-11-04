import {
  isBangumiBookTemplateHead,
  isBangumiTVAnimeTemplateHead,
} from './bangumi-subject-profile.ts';
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
export type BangumiNameRecord = Readonly<{
  type: number;
  name: string;
  name_cn?: string;
  infobox?: string;
}>;
export type BangumiNameTemplate = Readonly<{
  type: number;
  isTemplateHead(line: string): boolean;
  listFields: ReadonlySet<'中文名' | '别名'>;
  aliasProperty?: BangumiSubjectName['property'];
  retainedOtherFields?: ReadonlySet<string>;
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
  limitExceeded: boolean;
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

function compareNames(left: BangumiSubjectName, right: BangumiSubjectName): number {
  const a = `${left.property}\u0000${left.language}\u0000${left.text}`;
  const b = `${right.property}\u0000${right.language}\u0000${right.text}`;
  return a < b ? -1 : a > b ? 1 : left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0;
}

/** Extract admitted names from one pinned template with bounded field staging. */
export function extractBangumiNamesForTemplate(
  record: BangumiNameRecord,
  template: BangumiNameTemplate,
): BangumiNameExtraction {
  const names: BangumiSubjectName[] = [];
  const seen = new Set<string>();
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
  const stageValue = (field: NameField, raw: string) => {
    if (field.unsupported || field.limitExceeded) return;
    const text = plainName(raw);
    if (text === undefined) {
      field.unsupported = true;
      return;
    }
    const property = field.key === '中文名' ? 'schema:name' : (template.aliasProperty ?? 'schema:alternateName');
    const language = field.key === '中文名' ? 'zh' : 'und';
    const tuple = `${property}\u0000${language}\u0000${text}`;
    if (seen.has(tuple) || field.values.includes(text)) return;
    if (names.length + field.values.length >= nameLimit) {
      field.limitExceeded = true;
      return;
    }
    field.values.push(text);
  };

  addTopLevel('schema:name', 'und', record.name);
  if (record.name_cn?.trim()) addTopLevel('schema:name', 'zh', record.name_cn);
  if (record.type !== template.type || record.infobox === undefined)
    return { names: names.sort(compareNames), diagnostics };

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
  if (!header || !template.isTemplateHead(header.line)) {
    omit('/infobox', 'unsupported_infobox_template');
    return { names: names.sort(compareNames), diagnostics };
  }

  let fields = 0;
  let closed = false;
  let trailing = false;
  let active: NameField | undefined;

  const finishField = (field: NameField | undefined, complete = true) => {
    if (!field || (field.key !== '中文名' && field.key !== '别名')) return;
    if (!complete) {
      omit(field.pointer, 'unsupported_infobox_structure');
      return;
    }
    if (field.unsupported) {
      omit(field.pointer, 'unsupported_infobox_name_form');
      return;
    }
    if (field.limitExceeded) {
      omit(field.pointer, 'infobox_name_limit');
      return;
    }
    if (!field.values.length) return;

    const property = field.key === '中文名' ? 'schema:name' : (template.aliasProperty ?? 'schema:alternateName');
    const language = field.key === '中文名' ? 'zh' : 'und';
    const additions = field.values
      .map((text) => [
        `${property}\u0000${language}\u0000${text}`,
        { property, language, text, pointer: field.pointer },
      ] as const)
      .filter(([tuple]) => !seen.has(tuple));
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
        limitExceeded: false,
      };
      if (key === '中文名' || key === '别名') {
        if (value) {
          active.form = 'scalar';
          stageValue(active, value);
        }
      } else if (!template.retainedOtherFields?.has(key)) omit(pointer, 'unsupported_infobox_key');
      continue;
    }
    if (!active) {
      omit(`/infobox/lines/${row.number}`, 'unsupported_infobox_structure');
      continue;
    }
    if (active.key !== '中文名' && active.key !== '别名') continue;
    const continuation = cleanHorizontal(line);
    if (continuation.startsWith('*')) {
      if (
        !template.listFields.has(active.key as '中文名' | '别名') ||
        continuation.startsWith('**') ||
        continuation === '*' ||
        active.form === 'scalar'
      ) {
        active.unsupported = true;
        continue;
      }
      active.form = 'list';
      stageValue(active, continuation.slice(1));
      continue;
    }
    if (active.key === '别名' && active.form === 'empty') {
      active.form = 'scalar';
      stageValue(active, continuation);
    } else active.unsupported = true;
  }
  finishField(active, closed);
  if (!closed) omit('/infobox', 'unsupported_infobox_structure');
  if (trailing) omit('/infobox', 'unsupported_infobox_structure');
  return { names: names.sort(compareNames), diagnostics };
}

/** The TVAnime owner admits only its pinned template and existing run fields. */
export function extractBangumiSubjectNames(record: BangumiNameRecord, nativeType: string): BangumiNameExtraction {
  const book = record.type === 1 && nativeType === 'schema:Book';
  const television = record.type === 2 && nativeType === 'schema:TVSeries';
  const template: BangumiNameTemplate = book
    ? {
        type: 1,
        isTemplateHead: isBangumiBookTemplateHead,
        listFields: new Set(['别名']),
        aliasProperty: 'schema:name',
      }
    : television
      ? {
          type: 2,
          isTemplateHead: isBangumiTVAnimeTemplateHead,
          listFields: new Set(['别名']),
          retainedOtherFields: bangumiTelevisionRunKeys,
        }
      : { type: -1, isTemplateHead: () => false, listFields: new Set<'中文名' | '别名'>() };
  return extractBangumiNamesForTemplate(record, template);
}
