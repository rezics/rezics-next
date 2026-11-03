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
};
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const statuses = ['CURRENT', 'PLANNING', 'COMPLETED', 'DROPPED', 'PAUSED', 'REPEATING'];
const scales: Record<string, number> = { POINT_100: 100, POINT_10: 10, POINT_10_DECIMAL: 10, POINT_5: 5, POINT_3: 3 };
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
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new AniListInputError();
        stack.push([child, depth + 1]);
      }
    }
  }
  let payload = document;
  if (object(payload) && Object.hasOwn(payload, 'data')) payload = payload.data;
  if (object(payload) && Object.hasOwn(payload, 'MediaListCollection')) payload = payload.MediaListCollection;
  const items: { evidence: unknown; group: JsonObject | null }[] = [];
  if (Array.isArray(payload)) items.push(...payload.map((evidence) => ({ evidence, group: null })));
  else if (object(payload) && Array.isArray(payload.lists)) {
    for (const group of payload.lists) {
      if (!object(group) || !Array.isArray(group.entries)) throw new AniListInputError();
      const { entries, ...metadata } = group;
      for (const evidence of entries) items.push({ evidence, group: metadata });
    }
  } else throw new AniListInputError();
  if (!items.length || items.length > ANILIST_LIMITS.rows) throw new AniListInputError();
  const rows: AniListRow[] = items.map(({ evidence, group }) => {
    if (!object(evidence)) throw new AniListInputError();
    const media = object(evidence.media) ? evidence.media : {};
    const identifiers: AniListRow['identifiers'] = [];
    for (const id of [evidence.mediaId, media.id]) {
      if (positive(id) && !identifiers.some((i) => i.source === 'anilist' && i.externalId === String(id)))
        identifiers.push({ source: 'anilist', externalId: String(id) });
    }
    // A list entry id is never a media id. MAL ids are accepted only in the documented Media.idMal field.
    if (positive(media.idMal)) identifiers.push({ source: 'myanimelist', externalId: String(media.idMal) });
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
        valid =
          typeof value === 'number' &&
          !!scoreFormat &&
          scales[scoreFormat] !== undefined &&
          value >= 0 &&
          value <= scales[scoreFormat]! &&
          (scoreFormat === 'POINT_10_DECIMAL' ? Number.isInteger(value * 10) : Number.isInteger(value));
        reason = scoreFormat
          ? `Original ${scoreFormat}; no local vote admission`
          : 'Unknown score scale; no conversion';
      } else if (field === 'startedAt' || field === 'completedAt') {
        valid =
          object(value) &&
          Object.entries(value).every(
            ([part, n]) =>
              ['year', 'month', 'day'].includes(part) &&
              (n === null || (positive(n) && n <= (part === 'year' ? 9999 : part === 'month' ? 12 : 31))),
          );
        if (valid && object(value) && positive(value.year) && positive(value.month) && positive(value.day))
          valid = new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCMonth() === value.month - 1;
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
    return { evidence, group, identifiers, fields };
  });
  // Keep wrappers, group metadata, source user ids and unfamiliar fields, including incomplete chunk markers.
  return { document, scoreFormat: scoreFormat ?? null, rows };
}
