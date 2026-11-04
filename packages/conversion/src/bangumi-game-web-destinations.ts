import {
  bangumiCharacterMeasurementLimits,
  bangumiInfoboxBraceTransition,
  bangumiInfoboxLines,
  type BangumiInfoboxLine,
} from './bangumi-character-measurements.ts';
import { sourceWebsiteUrl } from './support.ts';

export const bangumiGameWebDestinationLimits = Object.freeze({
  maxDestinations: 16,
  maxFieldBytes: 4096,
});

export type BangumiGameDestination = Readonly<{
  field: 'website' | '链接';
  pointer: string;
  property: 'schema:url' | 'wdt:P973';
  url: string;
}>;

export type BangumiGameDestinationEvidence = Readonly<{
  field: 'website' | '链接';
  pointer: string;
  outcome: 'admitted' | 'withheld';
  property?: 'schema:url' | 'wdt:P973';
  code?: string;
}>;

export type BangumiGameDestinationProjection = Readonly<{
  handledInfobox: boolean;
  destinations: readonly BangumiGameDestination[];
  evidence: readonly BangumiGameDestinationEvidence[];
  diagnostics: readonly Readonly<{ pointer: string; code: string }>[];
}>;

type FieldOccurrence = {
  field: 'website' | '链接';
  pointer: string;
  start: number;
  end: number;
  nested: boolean;
  continued: boolean;
  tooLarge: boolean;
};

const noInfobox: BangumiGameDestinationProjection = {
  handledInfobox: false,
  destinations: [],
  evidence: [],
  diagnostics: [],
};
const horizontalSpace = /^[\t ]+|[\t ]+$/gu;

function utf8Bytes(source: string, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const code = source.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function omissionSink() {
  const diagnostics: { pointer: string; code: string }[] = [];
  let overflow = false;
  return {
    diagnostics,
    add(pointer: string, code: string) {
      if (diagnostics.length < bangumiCharacterMeasurementLimits.maxDiagnostics - 1) {
        diagnostics.push({ pointer, code });
      } else if (!overflow) {
        diagnostics.push({ pointer: '/infobox', code: 'additional_infobox_omissions' });
        overflow = true;
      }
    },
  };
}

function gameField(value: string): 'website' | '链接' | undefined {
  if (value === 'website' || value === '链接') return value;
  return undefined;
}

function unsupportedInfobox(pointer: string): BangumiGameDestinationProjection {
  return {
    ...noInfobox,
    diagnostics: [{ pointer, code: 'unsupported_infobox_structure' }],
  };
}

function scanGameFields(infobox: string): {
  occurrences: FieldOccurrence[];
  diagnostics: { pointer: string; code: string }[];
  complete: boolean;
  hasOtherFields: boolean;
} {
  const sink = omissionSink();
  const iterator = bangumiInfoboxLines(infobox);
  let first: IteratorResult<BangumiInfoboxLine>;
  do {
    first = iterator.next();
  } while (!first.done && !first.value.text.trim());
  if (first.done || first.value.text.trim() !== '{{Infobox Game')
    return { occurrences: [], diagnostics: [], complete: false, hasOtherFields: false };

  const occurrences: FieldOccurrence[] = [];
  let fields = 0;
  let depth = 1;
  let active: FieldOccurrence | undefined;
  let closed = false;
  let trailing = false;
  let structurallyInvalid = false;
  let hasOtherFields = false;

  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value;
    const trimmed = row.text.trim();
    if (closed) {
      if (trimmed) trailing = true;
      continue;
    }
    if (depth === 1 && trimmed === '}}') {
      active = undefined;
      depth = 0;
      closed = true;
      continue;
    }
    if (!trimmed) continue;

    if (depth > 1) {
      if (active) active.nested = true;
      const nested = bangumiInfoboxBraceTransition(row.text, depth);
      if (nested.exceeded || nested.invalid) {
        sink.add(active?.pointer ?? '/infobox', nested.exceeded ? 'infobox_depth_limit' : 'unsupported_infobox_structure');
        structurallyInvalid = true;
        break;
      }
      depth = nested.depth;
      continue;
    }

    if (!row.text.startsWith('|')) {
      if (active) active.continued = true;
      const nested = bangumiInfoboxBraceTransition(row.text, depth);
      if (nested.exceeded || nested.invalid) {
        sink.add(active?.pointer ?? '/infobox', nested.exceeded ? 'infobox_depth_limit' : 'unsupported_infobox_structure');
        structurallyInvalid = true;
        break;
      }
      if (nested.depth > depth && active) active.nested = true;
      depth = nested.depth;
      continue;
    }

    active = undefined;
    fields += 1;
    if (fields > bangumiCharacterMeasurementLimits.maxFields) {
      sink.add('/infobox', 'infobox_field_limit');
      structurallyInvalid = true;
      break;
    }
    const pointer = `/infobox/fields/${fields - 1}`;
    const equals = row.text.indexOf('=');
    if (equals < 2) {
      sink.add(pointer, 'unsupported_infobox_structure');
      hasOtherFields = true;
      continue;
    }
    const key = row.text.slice(1, equals).replace(horizontalSpace, '');
    const field = gameField(key);
    const valueStart = row.start + equals + 1;
    const valueEnd = row.end;
    if (!field) {
      hasOtherFields = true;
      const nested = bangumiInfoboxBraceTransition(row.text, depth);
      if (nested.exceeded || nested.invalid) {
        sink.add(pointer, nested.exceeded ? 'infobox_depth_limit' : 'unsupported_infobox_structure');
        structurallyInvalid = true;
        break;
      }
      depth = nested.depth;
      continue;
    }
    const occurrence: FieldOccurrence = {
      field,
      pointer,
      start: valueStart,
      end: valueEnd,
      nested: row.text.slice(equals + 1).includes('{{') || row.text.slice(equals + 1).includes('}}'),
      continued: false,
      tooLarge: utf8Bytes(infobox, valueStart, valueEnd) > bangumiGameWebDestinationLimits.maxFieldBytes,
    };
    occurrences.push(occurrence);
    active = occurrence;
    const nested = bangumiInfoboxBraceTransition(row.text, depth);
    if (nested.exceeded || nested.invalid) {
      sink.add(pointer, nested.exceeded ? 'infobox_depth_limit' : 'unsupported_infobox_structure');
      structurallyInvalid = true;
      break;
    }
    if (nested.depth > depth) occurrence.nested = true;
    depth = nested.depth;
  }

  const complete = closed && depth === 0 && !trailing && !structurallyInvalid;
  if (!complete && !sink.diagnostics.length) sink.add('/infobox', 'unsupported_infobox_structure');
  return {
    occurrences,
    diagnostics: sink.diagnostics,
    complete,
    hasOtherFields,
  };
}

function parseDestination(value: string):
  | { url: string }
  | { code: 'malformed_game_destination' | 'qualified_game_destination' | 'invalid_game_destination_url' } {
  const candidate = value.replace(horizontalSpace, '');
  if (!candidate) return { code: 'malformed_game_destination' };
  let url: string;
  let label: string | undefined;
  if (candidate.startsWith('[[')) {
    const link = /^\[\[([^\[\]|\r\n]+)(?:\|([^\[\]\r\n]*))?\]\]$/u.exec(candidate);
    if (!link) return { code: 'malformed_game_destination' };
    url = link[1]!;
    label = link[2];
  } else if (candidate.startsWith('[')) {
    const link = /^\[([^\s\[\]]+)(?:[\t ]+([^\[\]\r\n]+))?\]$/u.exec(candidate);
    if (!link) return { code: 'malformed_game_destination' };
    url = link[1]!;
    label = link[2];
  } else {
    if (/[\s\[\]]/u.test(candidate)) return { code: 'malformed_game_destination' };
    url = candidate;
  }
  try {
    // Validate with the shared policy; retain the source bytes rather than its URL serialization.
    sourceWebsiteUrl(url);
  } catch {
    return { code: 'invalid_game_destination_url' };
  }
  if (label?.trim()) return { code: 'qualified_game_destination' };
  return { url };
}

/** Only exact Game-template website and descriptive-link occurrences are considered. */
export function projectBangumiGameWebDestinations(infobox: unknown): BangumiGameDestinationProjection {
  if (infobox === undefined) return noInfobox;
  if (typeof infobox !== 'string' || !infobox.isWellFormed()) return unsupportedInfobox('/infobox');
  if (
    infobox.length > bangumiCharacterMeasurementLimits.sourceBytes ||
    Buffer.byteLength(infobox, 'utf8') > bangumiCharacterMeasurementLimits.sourceBytes
  )
    return { ...noInfobox, diagnostics: [{ pointer: '/infobox', code: 'infobox_byte_limit' }] };

  const parsed = scanGameFields(infobox);
  if (!parsed.complete) {
    if (!parsed.diagnostics.length) return noInfobox;
    return { ...noInfobox, diagnostics: parsed.diagnostics };
  }

  const destinations: BangumiGameDestination[] = [];
  const evidence: BangumiGameDestinationEvidence[] = [];
  const diagnostics = [...parsed.diagnostics];
  const sink = omissionSink();
  for (const occurrence of parsed.occurrences) {
    let code: string | undefined;
    let url: string | undefined;
    if (occurrence.tooLarge) code = 'game_destination_value_limit';
    else if (occurrence.nested || occurrence.continued) code = 'malformed_game_destination';
    else {
      const parsedDestination = parseDestination(infobox.slice(occurrence.start, occurrence.end));
      if ('code' in parsedDestination) code = parsedDestination.code;
      else url = parsedDestination.url;
    }

    const property = occurrence.field === 'website' ? 'schema:url' : 'wdt:P973';
    if (!code && url !== undefined) {
      if (destinations.length < bangumiGameWebDestinationLimits.maxDestinations) {
        destinations.push({ field: occurrence.field, pointer: occurrence.pointer, property, url });
        evidence.push({ field: occurrence.field, pointer: occurrence.pointer, outcome: 'admitted', property });
      } else code = 'game_destination_limit';
    }
    if (code) {
      evidence.push({ field: occurrence.field, pointer: occurrence.pointer, outcome: 'withheld', code });
      sink.add(occurrence.pointer, code);
    }
  }
  diagnostics.push(...sink.diagnostics);
  return {
    handledInfobox: !parsed.hasOtherFields,
    destinations,
    evidence,
    diagnostics: diagnostics.slice(0, bangumiCharacterMeasurementLimits.maxDiagnostics),
  };
}
