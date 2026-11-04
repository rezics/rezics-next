import type { ConversionDiagnostic } from './index.ts';

export const bangumiGameTemplateHead = '{{Infobox Game';
const countKey = '游玩人数';
const publicationKey = '发行日期';
const fieldLimit = 64;
const diagnosticLimit = 16;
const occurrenceLimit = 8;
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;
const countGrammar = /^([1-9][0-9]{0,15})(?:[\t ]*人)?(?:[\t ]*[-~～〜–—－][\t ]*([1-9][0-9]{0,15})(?:[\t ]*人)?)?$/u;

export type GamePlayerCountQualifier = {
  readonly property: { readonly id: 'schema:minValue' };
  readonly value: { readonly type: 'value'; readonly content: { readonly amount: string; readonly unit: '1' } };
};

export type GamePlayerCountFact = {
  readonly property: 'schema:numberOfPlayers';
  readonly content: { readonly amount: string; readonly unit: '1' };
  readonly field: 'numberOfPlayers';
  readonly qualifier?: GamePlayerCountQualifier;
};

export type GamePlayerCountMapping = {
  readonly handledInfobox: boolean;
  readonly facts: readonly GamePlayerCountFact[];
  readonly diagnostics: readonly ConversionDiagnostic[];
};

export type BangumiGameInfoboxField = {
  key: string;
  value: string;
  nested: boolean;
  continued: boolean;
  pointer: string;
};

export type BangumiGameInfoboxScan = {
  readonly handledInfobox: boolean;
  readonly fields: readonly BangumiGameInfoboxField[];
  readonly overflow: boolean;
  readonly malformed: boolean;
};

export const bangumiGameInfoboxFieldLimit = fieldLimit;

function infoboxPointer(key: string): string {
  return `/infobox/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function quantity(spelling: string): { amount: string; unit: '1' } {
  return { amount: `+${spelling}`, unit: '1' };
}

function notGreater(left: string, right: string): boolean {
  return left.length !== right.length ? left.length < right.length : left <= right;
}

/** Scan the pinned Game template once; both Game field mappers consume these bounded occurrences. */
export function scanBangumiGameInfobox(record: {
  readonly type: number;
  readonly infobox?: string;
}): BangumiGameInfoboxScan {
  if (record.type !== 4 || record.infobox === undefined)
    return { handledInfobox: false, fields: [], overflow: false, malformed: false };

  const fields: BangumiGameInfoboxField[] = [];
  let overflow = false;
  let malformed = false;
  let active: BangumiGameInfoboxField | undefined;
  let foundTemplate = false;
  let closed = false;
  let depth = 0;
  for (const raw of record.infobox.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.replace(horizontalSpace, '');
    if (!trimmed) continue;
    if (!foundTemplate) {
      if (trimmed !== bangumiGameTemplateHead)
        return { handledInfobox: false, fields: [], overflow: false, malformed: false };
      foundTemplate = true;
      depth = 1;
      continue;
    }
    if (closed) {
      malformed = true;
      break;
    }

    if (depth === 1 && trimmed.startsWith('|')) {
      if (fields.length >= fieldLimit) {
        overflow = true;
        break;
      }
      const equals = trimmed.indexOf('=');
      const pointer = `/infobox/fields/${fields.length}`;
      if (equals < 2) {
        active = { key: '', value: '', nested: false, continued: false, pointer };
        fields.push(active);
      } else {
        const key = trimmed.slice(1, equals).replace(horizontalSpace, '');
        const value = trimmed.slice(equals + 1);
        active = {
          key,
          value,
          nested: value.includes('{{') || value.includes('}}') || value.includes('[[') || value.includes(']]'),
          continued: false,
          pointer: key ? infoboxPointer(key) : pointer,
        };
        fields.push(active);
      }
    } else if (depth === 1 && active && trimmed !== '}}') {
      active.continued = true;
    }

    for (let index = 0; index < line.length;) {
      if (line.startsWith('{{', index)) {
        depth += 1;
        if (depth > 2) malformed = true;
        index += 2;
      } else if (line.startsWith('}}', index)) {
        depth -= 1;
        if (depth < 0) malformed = true;
        index += 2;
        if (depth === 0) {
          closed = true;
          if (line.slice(index).trim()) malformed = true;
          break;
        }
      } else index += 1;
      if (malformed) break;
    }
    if (malformed) break;
    if (depth === 0) {
      closed = true;
      active = undefined;
    }
    if (closed && trimmed === '}}') {
      active = undefined;
      continue;
    }
  }
  return {
    handledInfobox: foundTemplate,
    fields,
    overflow,
    malformed: !overflow && (malformed || (foundTemplate && !closed)),
  };
}

/** Share the one bounded Game scan with adapters that consume exact infobox fields. */
export function parseBangumiGameInfobox(infobox: string): {
  readonly matched: boolean;
  readonly fields: readonly BangumiGameInfoboxField[];
  readonly overflow: boolean;
  readonly malformed: boolean;
} {
  const scan = scanBangumiGameInfobox({ type: 4, infobox });
  return {
    matched: scan.handledInfobox,
    fields: scan.fields,
    overflow: scan.overflow,
    malformed: scan.malformed,
  };
}

function parseCount(field: BangumiGameInfoboxField): {
  readonly fact?: GamePlayerCountFact;
  readonly code?: string;
} {
  if (field.nested || field.continued || !field.key) return { code: 'unsupported_player_count' };
  const value = field.value.replace(horizontalSpace, '');
  if (!value) return {};
  const match = countGrammar.exec(value);
  if (!match || match[0] !== value) return { code: 'unsupported_player_count' };
  const maximum = match[2] ?? match[1]!;
  const minimum = match[2] === undefined ? undefined : match[1]!;
  if (minimum !== undefined && !notGreater(minimum, maximum)) return { code: 'reversed_player_count_range' };
  return {
    fact: {
      property: 'schema:numberOfPlayers',
      content: quantity(maximum),
      field: 'numberOfPlayers',
      ...(minimum === undefined
        ? {}
        : {
            qualifier: {
              property: { id: 'schema:minValue' },
              value: { type: 'value', content: quantity(minimum) },
            },
          }),
    },
  };
}

/** Type-4 pinned `{{Infobox Game` 游玩人数 only: unqualified count or inclusive range. */
export function bangumiGamePlayerCount(
  record: {
    readonly type: number;
    readonly infobox?: string;
  },
  scan = scanBangumiGameInfobox(record),
  options: { readonly handledFields?: readonly string[] } = {},
): GamePlayerCountMapping {
  if (!scan.handledInfobox) return { handledInfobox: false, facts: [], diagnostics: [] };

  const diagnostics: ConversionDiagnostic[] = [];
  const omit = (pointer: string, code: string) => {
    if (diagnostics.length < diagnosticLimit - 1) diagnostics.push({ pointer, code });
    else if (!diagnostics.some((item) => item.code === 'additional_infobox_omissions'))
      diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
  };
  const fields = scan.fields;
  if (scan.overflow) omit('/infobox', 'infobox_field_limit');
  if (scan.malformed) omit('/infobox', 'unsupported_infobox_structure');
  const counts: BangumiGameInfoboxField[] = [];
  const handledFields = new Set(options.handledFields ?? []);
  let examined = 0;
  let bounded = scan.overflow || scan.malformed;
  for (const field of fields) {
    if (!field.key) {
      omit(field.pointer, 'unsupported_infobox_structure');
      continue;
    }
    if (field.key === publicationKey) continue;
    if (field.key === countKey) {
      examined++;
      if (examined > occurrenceLimit) {
        omit(infoboxPointer(countKey), 'player_count_occurrence_limit');
        bounded = true;
        break;
      }
      counts.push(field);
      continue;
    }
    if (field.key === '平台' || field.key === '游戏引擎' || handledFields.has(field.key)) continue;
    if (field.key === 'website' || field.key === '链接') continue;
    omit(field.pointer, 'unsupported_infobox_mapping');
  }

  let fact: GamePlayerCountFact | undefined;
  if (!bounded && counts.length > 1) omit(infoboxPointer(countKey), 'contradictory_player_count');
  else if (!bounded && counts.length === 1) {
    const parsed = parseCount(counts[0]!);
    if (parsed.code) omit(counts[0]!.pointer, parsed.code);
    else fact = parsed.fact;
  }
  return { handledInfobox: true, facts: fact ? [fact] : [], diagnostics };
}
