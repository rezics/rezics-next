import { createHash } from 'node:crypto';

export const bangumiCharacterNameLimits = Object.freeze({
  maxInfoboxBytes: 32_768,
  maxDepth: 2,
  maxFields: 64,
  maxAliases: 64,
  maxNameFacts: 16,
  maxAlternateNameFacts: 64,
  maxScalarBytes: 4096,
  maxScalarCodepoints: 500,
  maxDiagnostics: 16,
});

export type BangumiLanguageText = { language: string; text: string };
export type BangumiCharacterNameDiagnostic = { pointer: string; code: string };

export type BangumiCharacterInfoboxNames = {
  names: BangumiLanguageText[];
  alternateNames: BangumiLanguageText[];
  diagnostics: BangumiCharacterNameDiagnostic[];
  source: { bytes: number; sha256?: string; kind: string };
};

const aliasLanguages: Readonly<Record<string, string>> = Object.freeze({
  第二中文名: 'zh',
  英文名: 'en',
  日文名: 'ja',
  纯假名: 'ja',
  罗马字: 'und-Latn',
  昵称: 'und',
});

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function usableName(value: string): boolean {
  return (
    value.isWellFormed() &&
    value.trim().length > 0 &&
    [...value].length <= bangumiCharacterNameLimits.maxScalarCodepoints &&
    Buffer.byteLength(value, 'utf8') <= bangumiCharacterNameLimits.maxScalarBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function splitListedAliases(value: string, remaining: number): string[] | undefined {
  let count = 1;
  for (const char of value) if (char === '，') count++;
  if (count > remaining) return undefined;
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    if (index !== value.length && value[index] !== '，') continue;
    const item = value.slice(start, index).trim();
    if (!item || !usableName(item) || /[{}\[\]<>]/u.test(item)) return undefined;
    result.push(item);
    start = index + 1;
  }
  return result;
}

function scalarBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Read only the pinned `Crt` name fields and its labelled `Crt.aliases` rows.
 * This deliberately does not interpret other wiki markup or nested fields.
 */
export function parseBangumiCharacterInfoboxNames(value: unknown): BangumiCharacterInfoboxNames {
  const diagnostics: BangumiCharacterNameDiagnostic[] = [];
  const addDiagnostic = (pointer: string, code: string) => {
    if (diagnostics.length < bangumiCharacterNameLimits.maxDiagnostics) diagnostics.push({ pointer, code });
  };
  const empty = (source: BangumiCharacterInfoboxNames['source']): BangumiCharacterInfoboxNames => ({
    names: [],
    alternateNames: [],
    diagnostics,
    source,
  });

  if (value === undefined) return empty({ bytes: 0, kind: 'absent' });
  if (typeof value !== 'string') {
    addDiagnostic('/infobox', 'invalid_infobox_type');
    return empty({ bytes: 0, kind: value === null ? 'null' : typeof value });
  }

  const bytes = scalarBytes(value);
  if (bytes > bangumiCharacterNameLimits.maxInfoboxBytes) {
    addDiagnostic('/infobox', 'infobox_byte_limit');
    return empty({ bytes, kind: 'over-limit' });
  }
  const source = { bytes, sha256: fingerprint(value), kind: 'string' };
  const names: BangumiLanguageText[] = [];
  const aliases: BangumiLanguageText[] = [];
  let aliasRows = 0;
  let fields = 0;
  let aliasFieldCount = 0;
  let aliasGroupInvalid = false;
  let aliasGroupClosed = false;
  let infoboxNameInvalid = false;
  let infoboxNameSeen = false;
  let infoboxName: string | undefined;
  let hasHeader = false;
  let outerClosed = false;
  let nestedDepth = 0;
  let lineNumber = 0;
  let offset = 0;
  let discardInfoboxFacts = false;

  while (offset <= value.length) {
    const newline = value.indexOf('\n', offset);
    const end = newline === -1 ? value.length : newline;
    let line = value.slice(offset, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    offset = newline === -1 ? value.length + 1 : newline + 1;
    const syntax = line.trim();

    if (lineNumber === 0) {
      hasHeader = syntax === '{{Infobox Crt';
      if (!hasHeader) {
        addDiagnostic('/infobox', 'unsupported_infobox_template');
        return empty(source);
      }
      nestedDepth = 1;
      lineNumber++;
      continue;
    }

    if (outerClosed) {
      if (syntax) addDiagnostic('/infobox', 'trailing_infobox_content');
      lineNumber++;
      continue;
    }

    if (aliasFieldCount > 0 && !aliasGroupClosed && syntax === '}') {
      aliasGroupClosed = true;
      nestedDepth--;
      lineNumber++;
      continue;
    }

    if (aliasFieldCount > 0 && !aliasGroupClosed) {
      if (!syntax) {
        lineNumber++;
        continue;
      }
      aliasRows++;
      const pointer = `/infobox/别名/${aliasRows - 1}`;
      if (aliasRows > bangumiCharacterNameLimits.maxAliases) {
        aliasGroupInvalid = true;
        addDiagnostic('/infobox/别名', 'alias_row_limit');
        lineNumber++;
        continue;
      }
      if (syntax.startsWith('[') && syntax.endsWith(']')) {
        const row = syntax.slice(1, -1);
        const separator = row.indexOf('|');
        const label = separator < 0 ? '' : row.slice(0, separator);
        const alias = separator < 0 ? '' : row.slice(separator + 1).trim();
        const language = aliasLanguages[label];
        if (separator <= 0 || alias.indexOf('|') !== -1 || /[{}\[\]<>]/u.test(alias)) {
          aliasGroupInvalid = true;
          addDiagnostic(pointer, 'malformed_alias');
        } else if (!language) {
          addDiagnostic(pointer, 'unsupported_alias_label');
        } else if (!alias) {
          // Empty labelled values are admitted by the pinned template and mean no alias.
        } else if (!usableName(alias)) {
          aliasGroupInvalid = true;
          addDiagnostic(pointer, 'invalid_alias_value');
        } else {
          const items = splitListedAliases(alias, bangumiCharacterNameLimits.maxAlternateNameFacts - aliases.length);
          if (!items) {
            aliasGroupInvalid = true;
            addDiagnostic(pointer, 'alias_value_limit_or_format');
          } else aliases.push(...items.map((text) => ({ language, text })));
        }
      } else {
        aliasGroupInvalid = true;
        addDiagnostic(pointer, 'malformed_alias');
      }
      lineNumber++;
      continue;
    }

    if (syntax === '}}') {
      outerClosed = true;
      nestedDepth--;
      lineNumber++;
      continue;
    }

    if (!syntax) {
      lineNumber++;
      continue;
    }

    if (!syntax.startsWith('|')) {
      addDiagnostic('/infobox', 'malformed_infobox_field');
      lineNumber++;
      continue;
    }

    fields++;
    if (fields > bangumiCharacterNameLimits.maxFields) {
      discardInfoboxFacts = true;
      addDiagnostic('/infobox', 'infobox_field_limit');
      lineNumber++;
      continue;
    }

    const fieldLine = line.trimStart();
    const equals = fieldLine.indexOf('=');
    if (equals <= 1) {
      addDiagnostic(`/infobox/field/${fields - 1}`, 'malformed_infobox_field');
      lineNumber++;
      continue;
    }
    const key = fieldLine.slice(1, equals).trim();
    const fieldValue = fieldLine.slice(equals + 1);
    if (key === '别名') {
      aliasFieldCount++;
      if (fieldValue !== '{' || aliasFieldCount > 1) {
        aliasGroupInvalid = true;
        addDiagnostic('/infobox/别名', aliasFieldCount > 1 ? 'duplicate_alias_field' : 'malformed_alias_field');
      } else {
        nestedDepth++;
        if (nestedDepth > bangumiCharacterNameLimits.maxDepth) {
          aliasGroupInvalid = true;
          addDiagnostic('/infobox/别名', 'alias_depth_limit');
        }
      }
    } else if (key === '简体中文名') {
      if (infoboxNameSeen) {
        infoboxNameInvalid = true;
        addDiagnostic('/infobox/简体中文名', 'duplicate_source_name');
      } else if (!fieldValue.trim()) {
        infoboxNameSeen = true;
      } else if (!usableName(fieldValue.trim()) || /[{}\[\]<>]/u.test(fieldValue)) {
        infoboxNameInvalid = true;
        addDiagnostic('/infobox/简体中文名', 'invalid_source_name');
      } else {
        infoboxNameSeen = true;
        infoboxName = fieldValue.trim();
      }
    }
    lineNumber++;
  }

  if (!outerClosed || nestedDepth !== 0) addDiagnostic('/infobox', 'unclosed_infobox');
  if (aliasFieldCount > 0 && !aliasGroupClosed) {
    aliasGroupInvalid = true;
    addDiagnostic('/infobox/别名', 'unclosed_alias_field');
  }
  if (discardInfoboxFacts) {
    names.length = 0;
    aliases.length = 0;
  } else if (!infoboxNameInvalid && infoboxName !== undefined) {
    names.push({ language: 'zh-Hans', text: infoboxName });
  }
  if (aliasGroupInvalid) aliases.length = 0;

  const unique = (items: BangumiLanguageText[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = JSON.stringify([item.language, item.text]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    names: unique(names),
    alternateNames: unique(aliases),
    diagnostics,
    source,
  };
}

export function bangumiCharacterNameScalar(value: unknown):
  | { status: 'absent' }
  | { status: 'invalid'; kind: string; bytes?: number; sha256?: string }
  | { status: 'admitted'; text: string } {
  if (value === undefined || value === null || value === '') return { status: 'absent' };
  if (typeof value !== 'string') return { status: 'invalid', kind: value === null ? 'null' : typeof value };
  const bytes = scalarBytes(value);
  if (!usableName(value)) {
    return {
      status: 'invalid',
      kind: 'string',
      bytes,
      ...(bytes <= bangumiCharacterNameLimits.maxInfoboxBytes ? { sha256: fingerprint(value) } : {}),
    };
  }
  return { status: 'admitted', text: value };
}
