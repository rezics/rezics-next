/** Upload dialect v1, based on the retained AniList GraphQL reference, not an official export format. */
export type JsonObject = Record<string, unknown>;
export const ANILIST_LIMITS = { bytes: 1_048_576, rows: 200, page: 20, uploads: 5, depth: 24 } as const;
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export class AniListInputError extends Error {
  constructor() {
    super('Invalid or oversized AniList upload');
  }
}
export type AniListRow = {
  evidence: JsonObject;
  group: JsonObject | null;
  identifiers: { source: 'anilist' | 'myanimelist'; externalId: string }[];
  fields: { field: string; validity: 'valid' | 'unknown' | 'invalid'; reason: string }[];
  scoreLexeme?: string;
};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const statuses = ['CURRENT', 'PLANNING', 'COMPLETED', 'DROPPED', 'PAUSED', 'REPEATING'];
const scales: Record<string, number> = { POINT_100: 100, POINT_10: 10, POINT_10_DECIMAL: 10, POINT_5: 5, POINT_3: 3 };

type SourceNode =
  | { kind: 'object'; properties: Map<string, SourceNode> }
  | { kind: 'array'; items: SourceNode[] }
  | { kind: 'scalar'; raw: string };

function sourceTree(source: string): SourceNode {
  let cursor = 0;
  const whitespace = () => {
    while (/\s/.test(source[cursor] ?? '')) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (cursor < source.length) {
      const char = source[cursor++]!;
      if (char === '\\') cursor++;
      else if (char === '"') return JSON.parse(source.slice(start, cursor)) as string;
    }
    throw new AniListInputError();
  };
  const value = (depth: number): SourceNode => {
    whitespace();
    if (depth > ANILIST_LIMITS.depth) throw new AniListInputError();
    if (source[cursor] === '{') {
      cursor++;
      const properties = new Map<string, SourceNode>();
      whitespace();
      while (source[cursor] !== '}') {
        whitespace();
        const key = string();
        whitespace();
        if (source[cursor++] !== ':') throw new AniListInputError();
        properties.set(key, value(depth + 1));
        whitespace();
        if (source[cursor] === '}') break;
        if (source[cursor++] !== ',') throw new AniListInputError();
      }
      cursor++;
      return { kind: 'object', properties };
    }
    if (source[cursor] === '[') {
      cursor++;
      const items: SourceNode[] = [];
      whitespace();
      while (source[cursor] !== ']') {
        items.push(value(depth + 1));
        whitespace();
        if (source[cursor] === ']') break;
        if (source[cursor++] !== ',') throw new AniListInputError();
      }
      cursor++;
      return { kind: 'array', items };
    }
    const start = cursor;
    if (source[cursor] === '"') string();
    else while (cursor < source.length && !/[\s,\]}]/.test(source[cursor]!)) cursor++;
    if (cursor === start) throw new AniListInputError();
    return { kind: 'scalar', raw: source.slice(start, cursor) };
  };
  const tree = value(0);
  whitespace();
  if (cursor !== source.length) throw new AniListInputError();
  return tree;
}

function sourceRows(tree: SourceNode): SourceNode[] {
  const property = (node: SourceNode, key: string) =>
    node.kind === 'object' ? node.properties.get(key) : undefined;
  let payload = property(tree, 'data') ?? tree;
  payload = property(payload, 'MediaListCollection') ?? payload;
  if (payload.kind === 'array') return payload.items;
  const lists = property(payload, 'lists');
  if (lists?.kind !== 'array') return [];
  return lists.items.flatMap((group) => {
    const entries = property(group, 'entries');
    return entries?.kind === 'array' ? entries.items : [];
  });
}

function hasAtMostDecimalPlaces(raw: string, maximum: number): boolean {
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return false;
  const digits = match[1]! + (match[2] ?? '');
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) return false;
  const places = (match[2]?.length ?? 0) - exponent;
  if (places <= 0) return true;
  if (!/[1-9]/.test(digits)) return true;
  if (places > digits.length + maximum) return false;
  const fraction =
    places >= digits.length ? `${'0'.repeat(places - digits.length)}${digits}` : digits.slice(digits.length - places);
  return fraction.replace(/0+$/, '').length <= maximum;
}

export function parseAniList(upload: string, scoreFormat?: string) {
  if (Buffer.byteLength(upload) > ANILIST_LIMITS.bytes) throw new AniListInputError();
  let document: unknown;
  try {
    document = JSON.parse(upload);
  } catch {
    throw new AniListInputError();
  }
  const stack: [unknown, number][] = [[document, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (depth > ANILIST_LIMITS.depth) throw new AniListInputError();
    if (typeof value === 'string' && (!value.isWellFormed() || value.includes('\0'))) throw new AniListInputError();
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype' ||
          !key.isWellFormed() ||
          key.includes('\0')
        )
          throw new AniListInputError();
        stack.push([child, depth + 1]);
      }
    }
  }
  const rawRows = sourceRows(sourceTree(upload));
  let payload = document;
  if (object(payload) && Object.hasOwn(payload, 'data')) payload = payload.data;
  if (object(payload) && Object.hasOwn(payload, 'MediaListCollection')) payload = payload.MediaListCollection;
  const items: { evidence: unknown; group: JsonObject | null }[] = [];
  if (Array.isArray(payload)) items.push(...payload.map((evidence) => ({ evidence, group: null })));
  else if (object(payload) && Array.isArray(payload.lists)) {
    for (const group of payload.lists) {
      if (!object(group) || !Array.isArray(group.entries)) throw new AniListInputError();
      const { entries, ...metadata } = group;
      if (Buffer.byteLength(JSON.stringify(metadata)) > 8192) throw new AniListInputError();
      for (const evidence of entries) items.push({ evidence, group: metadata });
    }
  } else throw new AniListInputError();
  if (!items.length || items.length > ANILIST_LIMITS.rows) throw new AniListInputError();
  const rows: AniListRow[] = items.map(({ evidence, group }, ordinal) => {
    if (!object(evidence)) throw new AniListInputError();
    if (
      Object.keys(evidence).length > 128 ||
      Object.keys(evidence).some((key) => key.length > 100) ||
      Buffer.byteLength(JSON.stringify(evidence)) > 65536
    )
      throw new AniListInputError();
    const media = object(evidence.media) ? evidence.media : {};
    const identifiers: AniListRow['identifiers'] = [];
    for (const id of [evidence.mediaId, media.id]) {
      if (positive(id) && !identifiers.some((i) => i.source === 'anilist' && i.externalId === String(id)))
        identifiers.push({ source: 'anilist', externalId: String(id) });
    }
    // A list entry id is never a media id. MAL ids are accepted only in the documented Media.idMal field.
    if (positive(media.idMal)) identifiers.push({ source: 'myanimelist', externalId: String(media.idMal) });
    const rawEvidence = rawRows[ordinal];
    const rawScore = rawEvidence?.kind === 'object' ? rawEvidence.properties.get('score') : undefined;
    const fields: AniListRow['fields'] = Object.entries(evidence).map(([field, value]) => {
      let valid = true;
      let reason = 'No native admission for this field; retained privately';
      if (field === 'status') {
        valid = typeof value === 'string' && statuses.includes(value);
        reason = 'Review native state role mapping';
      } else if (['progress', 'progressVolumes', 'repeat', 'updatedAt', 'createdAt', 'priority'].includes(field))
        valid = count(value);
      else if (['private', 'hiddenFromStatusLists'].includes(field)) valid = typeof value === 'boolean';
      else if (field === 'notes') valid = typeof value === 'string';
      else if (field === 'mediaId' || field === 'id' || field === 'userId') valid = positive(value);
      else if (field === 'score') {
        const scoreLexeme = rawScore?.kind === 'scalar' && typeof value === 'number' ? rawScore.raw : undefined;
        valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          !!scoreFormat &&
          scales[scoreFormat] !== undefined &&
          value >= 0 &&
          value <= scales[scoreFormat]! &&
          !!scoreLexeme &&
          hasAtMostDecimalPlaces(scoreLexeme, scoreFormat === 'POINT_10_DECIMAL' ? 1 : 0);
        reason = value === null
          ? 'The source score is null and remains unknown.'
          : !scoreFormat
            ? 'The source score scale is unknown; its original value is retained.'
            : valid
              ? `Original ${scoreFormat}; no exact conversion to native units. Owner choice is required.`
              : `Invalid value for original ${scoreFormat}; its original evidence is retained.`;
      } else if (field === 'startedAt' || field === 'completedAt') {
        valid =
          object(value) &&
          Object.entries(value).every(
            ([part, n]) =>
              ['year', 'month', 'day'].includes(part) &&
              (n === null || (positive(n) && n <= (part === 'year' ? 9999 : part === 'month' ? 12 : 31))),
          );
        if (valid && object(value) && positive(value.month) && positive(value.day))
          valid =
            new Date(Date.UTC(positive(value.year) ? value.year : 2000, value.month - 1, value.day)).getUTCMonth() ===
            value.month - 1;
        reason = 'Fuzzy components retained exactly; no historical session admission';
      }
      if (field === 'progress')
        reason = `Original ${media.type === 'ANIME' ? 'episodes' : media.type === 'MANGA' ? 'chapters' : 'unknown measure'}; no historical session admission`;
      if (field === 'progressVolumes') reason = 'Original volumes; no historical session admission';
      return {
        field,
        validity: value === null || (field === 'score' && !scoreFormat) ? 'unknown' : valid ? 'valid' : 'invalid',
        reason,
      };
    });
    return {
      evidence,
      group,
      identifiers,
      fields,
      ...(rawScore?.kind === 'scalar' && typeof evidence.score === 'number' ? { scoreLexeme: rawScore.raw } : {}),
    };
  });
  // Keep wrappers, group metadata, source user ids and unfamiliar fields, including incomplete chunk markers.
  return { document, scoreFormat: scoreFormat ?? null, rows };
}
