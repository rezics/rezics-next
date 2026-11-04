import type { ConversionDiagnostic } from './index.ts';

export const bangumiGameTemplateHead = '{{Infobox Game';
const countKey = '游玩人数';
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

function parseFields(infobox: string): { fields: BangumiGameInfoboxField[]; overflow: boolean } {
  const fields: BangumiGameInfoboxField[] = [];
  let overflow = false;
  let active: BangumiGameInfoboxField | undefined;
  for (const raw of infobox.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.replace(horizontalSpace, '');
    if (!trimmed) continue;
    if (trimmed === '}}') {
      active = undefined;
      continue;
    }
    if (!trimmed.startsWith('|')) {
      if (active) active.continued = true;
      continue;
    }
    if (fields.length >= fieldLimit) {
      overflow = true;
      active = undefined;
      break;
    }
    const equals = trimmed.indexOf('=');
    const pointer = `/infobox/fields/${fields.length}`;
    if (equals < 2) {
      const field = { key: '', value: '', nested: false, continued: false, pointer };
      fields.push(field);
      active = field;
      continue;
    }
    const key = trimmed.slice(1, equals).replace(horizontalSpace, '');
    const value = trimmed.slice(equals + 1);
    const field = {
      key,
      value,
      nested: value.replace(horizontalSpace, '').startsWith('{') || value.includes('{{') || value.includes('[['),
      continued: false,
      pointer: key ? infoboxPointer(key) : pointer,
    };
    fields.push(field);
    active = field;
  }
  return { fields, overflow };
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

/** Parse the existing bounded, line-oriented Game template without evaluating wiki markup. */
export function parseBangumiGameInfobox(infobox: string): {
  readonly matched: boolean;
  readonly fields: readonly BangumiGameInfoboxField[];
  readonly overflow: boolean;
} {
  let header: string | undefined;
  for (const raw of infobox.split('\n')) {
    const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).replace(horizontalSpace, '');
    if (line) {
      header = line;
      break;
    }
  }
  if (header !== bangumiGameTemplateHead) return { matched: false, fields: [], overflow: false };
  return { matched: true, ...parseFields(infobox) };
}

/** Type-4 pinned `{{Infobox Game` 游玩人数 only: unqualified count or inclusive range. */
export function bangumiGamePlayerCount(record: {
  readonly type: number;
  readonly infobox?: string;
}, options: { readonly handledFields?: readonly string[] } = {}): GamePlayerCountMapping {
  if (record.type !== 4 || record.infobox === undefined) return { handledInfobox: false, facts: [], diagnostics: [] };
  const parsedInfobox = parseBangumiGameInfobox(record.infobox);
  if (!parsedInfobox.matched) return { handledInfobox: false, facts: [], diagnostics: [] };

  const diagnostics: ConversionDiagnostic[] = [];
  const omit = (pointer: string, code: string) => {
    if (diagnostics.length < diagnosticLimit - 1) diagnostics.push({ pointer, code });
    else if (!diagnostics.some((item) => item.code === 'additional_infobox_omissions'))
      diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
  };
  const { fields, overflow } = parsedInfobox;
  if (overflow) omit('/infobox', 'infobox_field_limit');
  const counts: BangumiGameInfoboxField[] = [];
  const handledFields = new Set(options.handledFields ?? []);
  let examined = 0;
  let bounded = false;
  for (const field of fields) {
    if (!field.key) {
      omit(field.pointer, 'unsupported_infobox_structure');
      continue;
    }
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
    if (handledFields.has(field.key)) continue;
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
