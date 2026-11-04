import { isBangumiTVAnimeTemplateHead, isBangumiTVAnimeWorkEvidenceField } from './bangumi-subject-profile.ts';
import {
  createBangumiWorkEvidenceCollector,
  type BangumiWorkEvidence,
  type BangumiWorkEvidenceFieldState,
} from './bangumi-work-evidence.ts';

export type BangumiSubjectName = Readonly<{
  property: 'schema:name' | 'schema:alternateName';
  language: 'und' | 'zh';
  text: string;
}>;
export type BangumiNameDiagnostic = Readonly<{ pointer: string; code: string }>;
export type BangumiNameExtraction = Readonly<{
  names: readonly BangumiSubjectName[];
  diagnostics: readonly BangumiNameDiagnostic[];
}>;
export type BangumiTVAnimeEvidenceExtraction = BangumiNameExtraction & Readonly<{
  workEvidence: readonly BangumiWorkEvidence[];
}>;

const nameLimit = 24;
const fieldLimit = 64;
const diagnosticLimit = 16;
const textLimit = 500;
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
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extract only the two admitted TVAnime name fields. Unknown fields and wiki
 * structures remain bounded omissions; source spelling inside plain values is kept.
 */
export function extractBangumiSubjectNames(record: {
  readonly type: number;
  readonly name: string;
  readonly name_cn?: string;
  readonly infobox?: string;
}): BangumiNameExtraction {
  const extraction = extractBangumiTVAnimeEvidence(record);
  return { names: extraction.names, diagnostics: extraction.diagnostics };
}

export function extractBangumiTVAnimeEvidence(record: {
  readonly type: number;
  readonly name: string;
  readonly name_cn?: string;
  readonly infobox?: string;
}): BangumiTVAnimeEvidenceExtraction {
  const names: BangumiSubjectName[] = [];
  const seen = new Set<string>();
  const diagnostics: BangumiNameDiagnostic[] = [];
  let diagnosticOverflow = false;
  let nameOverflow = false;
  let fieldOverflow = false;

  const omit = (pointer: string, code: string) => {
    if (diagnostics.length < diagnosticLimit - 1) diagnostics.push({ pointer, code });
    else if (!diagnosticOverflow) {
      diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
      diagnosticOverflow = true;
    }
  };
  const workEvidence = createBangumiWorkEvidenceCollector(omit);
  const add = (
    property: BangumiSubjectName['property'],
    language: BangumiSubjectName['language'],
    raw: string,
    pointer: string,
    infoboxValue = false,
  ) => {
    const text = infoboxValue ? plainName(raw) : raw;
    if (text === undefined) {
      omit(pointer, 'unsupported_infobox_name_form');
      return;
    }
    const name = { property, language, text } as const;
    const tuple = `${property}\u0000${language}\u0000${text}`;
    if (seen.has(tuple)) return;
    seen.add(tuple);
    if (names.length >= nameLimit) {
      nameOverflow = true;
      return;
    }
    names.push(name);
  };

  add('schema:name', 'und', record.name, '/name');
  if (record.name_cn?.trim()) add('schema:name', 'zh', record.name_cn, '/name_cn');
  if (record.type !== 2 || record.infobox === undefined)
    return { names: names.sort(compareNames), diagnostics, workEvidence: [] };

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
  if (!header || !isBangumiTVAnimeTemplateHead(header.line)) {
    omit('/infobox', 'unsupported_infobox_template');
    return { names: names.sort(compareNames), diagnostics, workEvidence: [] };
  }

  let fields = 0;
  let closed = false;
  let trailing = false;
  let active:
    | {
        key: string;
        pointer: string;
        hasInlineValue: boolean;
        hasListValue: boolean;
        hasContinuationValue: boolean;
        workEvidence?: BangumiWorkEvidenceFieldState;
      }
    | undefined;

  const finishField = (field: typeof active) => {
    if (!field) return;
    workEvidence.finish(field.workEvidence);
    if ((field.key === '中文名' || field.key === '别名') && field.hasInlineValue && field.hasListValue) {
      omit(field.pointer, 'unsupported_infobox_name_form');
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
      if (fields >= fieldLimit) {
        active = undefined;
        omit('/infobox', 'infobox_field_limit');
        fieldOverflow = true;
        break;
      }
      fields++;
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
        hasInlineValue: Boolean(value),
        hasListValue: false,
        hasContinuationValue: false,
        ...(isBangumiTVAnimeWorkEvidenceField(key)
          ? { workEvidence: workEvidence.begin(key, pointer, value, Boolean(value)) }
          : {}),
      };
      if (key === '中文名' && value) add('schema:name', 'zh', value, pointer, true);
      else if (key === '别名' && value) add('schema:alternateName', 'und', value, pointer, true);
      else if (key !== '中文名' && key !== '别名' && !isBangumiTVAnimeWorkEvidenceField(key))
        omit(pointer, 'unsupported_infobox_key');
      continue;
    }
    if (!active) {
      omit(`/infobox/lines/${row.number}`, 'unsupported_infobox_structure');
      continue;
    }
    const continuation = cleanHorizontal(line);
    if (active.key !== '中文名' && active.key !== '别名') {
      if (continuation.startsWith('*'))
        workEvidence.continuation(active.workEvidence, 'list', cleanHorizontal(continuation.slice(1)));
      else workEvidence.continuation(active.workEvidence, 'plain', continuation);
      continue;
    }
    if (continuation.startsWith('*')) {
      if (active.key !== '别名' || continuation.startsWith('**') || continuation === '*') {
        omit(active.pointer, 'unsupported_infobox_name_form');
        continue;
      }
      active.hasListValue = true;
      add('schema:alternateName', 'und', continuation.slice(1), active.pointer, true);
      continue;
    }
    if (active.key === '别名' && !active.hasContinuationValue && !active.hasListValue && !active.hasInlineValue) {
      active.hasContinuationValue = true;
      add('schema:alternateName', 'und', continuation, active.pointer, true);
    } else {
      omit(active.pointer, 'unsupported_infobox_name_form');
    }
  }
  finishField(active);
  if (!closed && !fieldOverflow) omit('/infobox', 'unsupported_infobox_structure');
  if (trailing) omit('/infobox', 'unsupported_infobox_structure');
  if (nameOverflow) omit('/infobox', 'infobox_name_limit');
  return { names: names.sort(compareNames), diagnostics, workEvidence: workEvidence.values() };
}
