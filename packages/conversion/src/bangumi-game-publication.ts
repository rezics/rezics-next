import type { ConversionDiagnostic } from './index.ts';
import { bangumiPublicationTime, type PublicationTime } from './bangumi-subject-profile.ts';

const gameTemplateHead = '{{Infobox Game';
const publicationKey = '发行日期';
const fieldLimit = 64;

export type BangumiGamePublicationFact = {
  readonly property: 'schema:datePublished';
  readonly content: PublicationTime;
  readonly field: 'date';
};

export type BangumiGamePublication = {
  readonly facts: readonly BangumiGamePublicationFact[];
  readonly diagnostics: readonly ConversionDiagnostic[];
};

const empty: BangumiGamePublication = { facts: [], diagnostics: [] };

/** One unqualified Game-template publication date, with the precision supplied by Bangumi. */
export function bangumiGamePublication(record: {
  readonly type: number;
  readonly infobox?: string;
}): BangumiGamePublication {
  if (record.type !== 4 || record.infobox === undefined) return empty;

  let cursor = 0;
  let foundTemplate = false;
  let closed = false;
  let depth = 0;
  let fields = 0;
  let malformed = false;
  let overflow = false;
  const dates: { value: string; nested: boolean }[] = [];

  while (cursor <= record.infobox.length) {
    const newline = record.infobox.indexOf('\n', cursor);
    const end = newline < 0 ? record.infobox.length : newline;
    const line = record.infobox.slice(cursor, end).replace(/\r$/u, '');
    cursor = newline < 0 ? record.infobox.length + 1 : newline + 1;

    if (!foundTemplate) {
      if (!line.trim()) continue;
      if (line.trim() !== gameTemplateHead) return empty;
      foundTemplate = true;
      depth = 1;
      continue;
    }
    if (closed) {
      if (line.trim()) malformed = true;
      if (malformed) break;
      continue;
    }

    if (depth === 1 && line.startsWith('|')) {
      if (fields === fieldLimit) {
        overflow = true;
        break;
      }
      fields += 1;
      const equals = line.indexOf('=');
      if (equals >= 2 && equals <= 128 && line.slice(1, equals).trim() === publicationKey) {
        const value = line.slice(equals + 1).trim();
        dates.push({ value, nested: value.includes('{{') || value.includes('}}') });
      }
    }

    for (let index = 0; index < line.length; ) {
      if (line.startsWith('{{', index)) {
        depth += 1;
        if (depth > 2) malformed = true;
        index += 2;
      } else if (line.startsWith('}}', index)) {
        depth -= 1;
        if (depth < 0) malformed = true;
        if (depth === 0) closed = true;
        index += 2;
      } else index += 1;
      if (malformed) break;
    }
    if (malformed) break;
  }

  if (overflow) return omission('/infobox', 'infobox_field_limit');
  if (malformed || !foundTemplate || !closed) return omission('/infobox', 'unsupported_infobox_structure');
  if (dates.length > 1) return omission(`/infobox/${publicationKey}`, 'ambiguous_publication_date');
  if (dates.length === 0) return empty;

  const occurrence = dates[0]!;
  const time = occurrence.nested ? undefined : bangumiPublicationTime(occurrence.value);
  if (!time) return omission(`/infobox/${publicationKey}`, 'unsupported_publication_date');
  return {
    facts: [{ property: 'schema:datePublished', content: time, field: 'date' }],
    diagnostics: [],
  };
}

function omission(pointer: string, code: string): BangumiGamePublication {
  return { facts: [], diagnostics: [{ pointer, code }] };
}
