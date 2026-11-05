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
  if (value.length > bangumiCharacterNameLimits.maxScalarBytes) return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > bangumiCharacterNameLimits.maxScalarBytes) return false;
  let codepoints = 0;
  for (const _ of value) {
    if (++codepoints > bangumiCharacterNameLimits.maxScalarCodepoints) return false;
  }
  return (
    value.isWellFormed() &&
    value.trim().length > 0 &&
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

/** Read the pinned `Crt` grammar or official parsed CharacterDetail name fields only. */
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
  if (Array.isArray(value)) {
    const fieldOverflow = value.length > bangumiCharacterNameLimits.maxFields;
    const fieldCount = Math.min(value.length, bangumiCharacterNameLimits.maxFields);
    const names: BangumiLanguageText[] = [];
    const aliases: BangumiLanguageText[] = [];
    const sourceEvidence: unknown[] = [];
    const chineseValues: string[] = [];
    let chineseInvalid = false;
    let chineseOccurrences = 0;
    let aliasOccurrences = 0;
    let aliasInvalid = false;
    let aliasRows = 0;
    let overLimit = false;
    let omittedSourceBytes = 0;

    const addEvidence = (entry: unknown) => {
      const entryBytes = scalarBytes(JSON.stringify(entry));
      const currentBytes = scalarBytes(JSON.stringify(sourceEvidence));
      if (currentBytes + entryBytes + (sourceEvidence.length ? 1 : 0) > bangumiCharacterNameLimits.maxInfoboxBytes)
        return false;
      sourceEvidence.push(entry);
      return true;
    };
    const addSourceScalar = (kind: string, raw: unknown): boolean => {
      if (typeof raw !== 'string') return addEvidence([kind, typeof raw]);
      if (raw.length > bangumiCharacterNameLimits.maxInfoboxBytes) {
        addEvidence([kind, 'byte-limit', raw.length, fingerprint(raw.slice(0, bangumiCharacterNameLimits.maxScalarBytes))]);
        return false;
      }
      const bytes = scalarBytes(raw);
      if (raw.length > bangumiCharacterNameLimits.maxScalarBytes) {
        omittedSourceBytes += bytes;
        return addEvidence([kind, 'value-limit', raw.length, fingerprint(raw.slice(0, bangumiCharacterNameLimits.maxScalarBytes))]) &&
          scalarBytes(JSON.stringify(sourceEvidence)) + omittedSourceBytes <= bangumiCharacterNameLimits.maxInfoboxBytes;
      }
      if (bytes > bangumiCharacterNameLimits.maxScalarBytes) {
        omittedSourceBytes += bytes;
        return addEvidence([kind, 'value-limit', bytes, fingerprint(raw)]) &&
          scalarBytes(JSON.stringify(sourceEvidence)) + omittedSourceBytes <= bangumiCharacterNameLimits.maxInfoboxBytes;
      }
      return addEvidence([kind, raw]);
    };

    if (fieldOverflow) {
      addDiagnostic('/infobox', 'infobox_field_limit');
      if (!addEvidence(['field-limit', value.length])) overLimit = true;
    }

    for (let index = 0; index < fieldCount; index++) {
      const fieldDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const field = fieldDescriptor && 'value' in fieldDescriptor ? fieldDescriptor.value : undefined;
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        if (!addEvidence(['field', index, 'malformed'])) overLimit = true;
        addDiagnostic(`/infobox/${index}`, 'malformed_infobox_field');
        if (overLimit) break;
        continue;
      }
      const keyDescriptor = Object.getOwnPropertyDescriptor(field, 'key');
      const valueDescriptor = Object.getOwnPropertyDescriptor(field, 'value');
      if (
        !keyDescriptor || !('value' in keyDescriptor) || typeof keyDescriptor.value !== 'string' ||
        !valueDescriptor || !('value' in valueDescriptor)
      ) {
        if (!addEvidence(['field', index, 'malformed'])) overLimit = true;
        addDiagnostic(`/infobox/${index}`, 'malformed_infobox_field');
        if (overLimit) break;
        continue;
      }

      if (keyDescriptor.value === '简体中文名') {
        if (!addSourceScalar('zh-Hans', valueDescriptor.value)) overLimit = true;
        if (overLimit) break;
        chineseOccurrences++;
        const rawName = valueDescriptor.value;
        if (typeof rawName !== 'string') {
          chineseInvalid = true;
          addDiagnostic(`/infobox/${index}/value`, 'invalid_source_name');
          continue;
        }
        if (!rawName.trim()) {
          chineseValues.push('');
          continue;
        }
        const name = rawName.trim();
        if (!usableName(name) || /[{}\[\]<>]/u.test(rawName)) {
          chineseInvalid = true;
          addDiagnostic(`/infobox/${index}/value`, 'invalid_source_name');
          continue;
        }
        chineseValues.push(name);
        continue;
      }

      if (keyDescriptor.value !== '别名') continue;
      aliasOccurrences++;
      const rawAliases = valueDescriptor.value;
      if (!Array.isArray(rawAliases)) {
        if (!addEvidence(['aliases', typeof rawAliases])) overLimit = true;
        aliasInvalid = true;
        addDiagnostic(`/infobox/${index}/value`, 'malformed_alias_field');
        if (overLimit) break;
        continue;
      }
      const rowLimit = bangumiCharacterNameLimits.maxAliases - aliasRows;
      const rowsToVisit = Math.min(rawAliases.length, rowLimit);
      const aliasOverflow = rawAliases.length > rowLimit;
      if (aliasOverflow) {
        if (!addEvidence(['alias-row-limit', aliasRows + rawAliases.length])) overLimit = true;
        aliasInvalid = true;
        addDiagnostic(`/infobox/${index}/value`, 'alias_row_limit');
      }
      aliasRows += rowsToVisit;
      if (!addEvidence(['alias-row-count', rawAliases.length, rowsToVisit])) overLimit = true;
      if (overLimit) break;
      for (let aliasIndex = 0; aliasIndex < rowsToVisit; aliasIndex++) {
        const pointer = `/infobox/${index}/value/${aliasIndex}`;
        const aliasDescriptor = Object.getOwnPropertyDescriptor(rawAliases, String(aliasIndex));
        const alias = aliasDescriptor && 'value' in aliasDescriptor ? aliasDescriptor.value : undefined;
        if (!alias || typeof alias !== 'object' || Array.isArray(alias)) {
          if (!addEvidence(['alias', aliasIndex, 'malformed'])) overLimit = true;
          addDiagnostic(pointer, 'malformed_alias');
          if (overLimit) break;
          continue;
        }
        const labelDescriptor = Object.getOwnPropertyDescriptor(alias, 'k');
        const textDescriptor = Object.getOwnPropertyDescriptor(alias, 'v');
        const label = labelDescriptor && 'value' in labelDescriptor ? labelDescriptor.value : undefined;
        const aliasText = textDescriptor && 'value' in textDescriptor ? textDescriptor.value : undefined;
        const labelEvidence = typeof label === 'string'
          ? label.length <= 64 && label.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(label)
            ? label
            : `${label.length}:${fingerprint(label.slice(0, 64))}`
          : label === undefined ? 'missing' : typeof label;
        if (!addEvidence(['alias', aliasIndex, labelEvidence, aliasText === undefined ? 'missing' : typeof aliasText]))
          overLimit = true;
        if (overLimit) break;
        if (typeof aliasText === 'string') {
          if (!addSourceScalar('alias-value', aliasText)) overLimit = true;
          if (overLimit) break;
        }
        if (!textDescriptor || !('value' in textDescriptor) || typeof textDescriptor.value !== 'string') {
          addDiagnostic(pointer, 'malformed_alias_value');
          continue;
        }
        if (!labelDescriptor) {
          addDiagnostic(pointer, 'unlabelled_alias');
          continue;
        }
        if (!('value' in labelDescriptor) || typeof labelDescriptor.value !== 'string') {
          addDiagnostic(pointer, 'malformed_alias_label');
          continue;
        }
        const language = aliasLanguages[labelDescriptor.value];
        if (!language) {
          addDiagnostic(pointer, 'unsupported_alias_label');
          continue;
        }
        const text = textDescriptor.value.trim();
        if (!text) continue;
        if (!usableName(text) || /[{}\[\]<>]/u.test(text)) {
          addDiagnostic(pointer, 'invalid_alias_value');
          continue;
        }
        aliases.push({ language, text });
      }
      if (overLimit) break;
    }

    const serializedEvidence = JSON.stringify(sourceEvidence);
    const source = {
      bytes: scalarBytes(serializedEvidence),
      sha256: fingerprint(serializedEvidence),
      kind: overLimit || fieldOverflow ? 'over-limit' : 'parsed',
    };
    if (overLimit) addDiagnostic('/infobox', 'infobox_byte_limit');
    if (overLimit || fieldOverflow) return empty(source);

    if (chineseOccurrences > 1) {
      const distinct = new Set(chineseValues);
      if (distinct.size > 1 || chineseInvalid) {
        chineseInvalid = true;
        addDiagnostic('/infobox/简体中文名', 'ambiguous_source_name');
        addDiagnostic('/infobox/简体中文名', 'duplicate_source_name');
      } else addDiagnostic('/infobox/简体中文名', 'duplicate_source_name');
    }
    if (!chineseInvalid && chineseValues[0]) names.push({ language: 'zh-Hans', text: chineseValues[0] });
    if (aliasOccurrences > 1) {
      aliasInvalid = true;
      addDiagnostic('/infobox/别名', 'duplicate_alias_field');
    }
    if (aliasInvalid) aliases.length = 0;

    const unique = (items: BangumiLanguageText[]) => {
      const seen = new Set<string>();
      return items.filter((item) => {
        const key = JSON.stringify([item.language, item.text]);
        if (seen.has(key)) {
          addDiagnostic('/infobox/别名', 'duplicate_alias');
          return false;
        }
        seen.add(key);
        return true;
      });
    };

    return { names, alternateNames: unique(aliases), diagnostics, source };
  }
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

export function bangumiCharacterNameScalar(
  value: unknown,
):
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
