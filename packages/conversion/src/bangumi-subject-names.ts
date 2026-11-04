import { parseBangumiTVAnimeInfobox } from './bangumi-subject-profile.ts';

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
export type BangumiOfficialWebsite = Readonly<{ url: string; pointer: string }>;
export type BangumiSubjectExtraction = Readonly<{
  names: readonly BangumiSubjectName[];
  officialWebsites: readonly BangumiOfficialWebsite[];
  diagnostics: readonly BangumiNameDiagnostic[];
}>;

const nameLimit = 24;
const diagnosticLimit = 16;
const textLimit = 500;
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;

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

/**
 * Extract only the two admitted TVAnime name fields. Unknown fields and wiki
 * structures remain bounded omissions; source spelling inside plain values is kept.
 */
export function extractBangumiSubjectProfile(record: {
  readonly type: number;
  readonly name: string;
  readonly name_cn?: string;
  readonly infobox?: string;
}): BangumiSubjectExtraction {
  const names: BangumiSubjectName[] = [];
  const seen = new Set<string>();
  const officialWebsites: BangumiOfficialWebsite[] = [];
  const seenWebsites = new Set<string>();
  const diagnostics: BangumiNameDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  let diagnosticOverflow = false;
  let nameOverflow = false;

  const omit = (pointer: string, code: string) => {
    const key = `${pointer}\u0000${code}`;
    if (seenDiagnostics.has(key)) return;
    seenDiagnostics.add(key);
    if (code === 'additional_infobox_omissions') {
      if (!diagnosticOverflow) diagnostics.push({ pointer: '/infobox', code });
      diagnosticOverflow = true;
      return;
    }
    if (diagnostics.length < diagnosticLimit - 1) diagnostics.push({ pointer, code });
    else if (!diagnosticOverflow) {
      diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
      diagnosticOverflow = true;
    }
  };
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
    return { names: names.sort(compareNames), officialWebsites, diagnostics };

  const infobox = parseBangumiTVAnimeInfobox(record.infobox);
  for (const diagnostic of infobox.diagnostics) omit(diagnostic.pointer, diagnostic.code);
  for (const field of infobox.fields) {
    if (field.key === '中文名') {
      if (field.value) add('schema:name', 'zh', field.value, field.pointer, true);
      for (const _continuation of field.continuations) omit(field.pointer, 'unsupported_infobox_name_form');
      continue;
    }
    if (field.key === '别名') {
      const hasInlineValue = Boolean(field.value);
      let hasListValue = false;
      let hasContinuationValue = false;
      if (hasInlineValue) add('schema:alternateName', 'und', field.value, field.pointer, true);
      for (const continuation of field.continuations) {
        if (continuation.startsWith('*')) {
          if (continuation.startsWith('**') || continuation === '*') {
            omit(field.pointer, 'unsupported_infobox_name_form');
            continue;
          }
          hasListValue = true;
          add('schema:alternateName', 'und', continuation.slice(1), field.pointer, true);
        } else if (!hasContinuationValue && !hasListValue && !hasInlineValue) {
          hasContinuationValue = true;
          add('schema:alternateName', 'und', continuation, field.pointer, true);
        } else omit(field.pointer, 'unsupported_infobox_name_form');
      }
      if (hasInlineValue && hasListValue) omit(field.pointer, 'unsupported_infobox_name_form');
      continue;
    }
    if (field.key === '官方网站') {
      if (field.value) {
        const url = officialWebsiteUrl(field.value);
        if (url === undefined) omit(field.pointer, 'unsupported_infobox_website_form');
        else if (!seenWebsites.has(url)) {
          seenWebsites.add(url);
          officialWebsites.push({ url, pointer: field.pointer });
        }
      }
      if (field.continuations.length) omit(field.pointer, 'unsupported_infobox_website_form');
      continue;
    }
    omit(field.pointer, 'unsupported_infobox_key');
  }
  if (nameOverflow) omit('/infobox', 'infobox_name_limit');
  return { names: names.sort(compareNames), officialWebsites, diagnostics };
}

/** Backward-compatible name projection over the shared, bounded TVAnime parser. */
export function extractBangumiSubjectNames(record: {
  readonly type: number;
  readonly name: string;
  readonly name_cn?: string;
  readonly infobox?: string;
}): BangumiNameExtraction {
  const extraction = extractBangumiSubjectProfile(record);
  return { names: extraction.names, diagnostics: extraction.diagnostics };
}
