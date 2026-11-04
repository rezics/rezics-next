import type { ConversionDiagnostic } from './index.ts';
import { scanBangumiGameInfobox, type BangumiGameInfoboxScan } from './bangumi-game-player-count.ts';
import { bangumiPublicationTime, type PublicationTime } from './bangumi-subject-profile.ts';

const publicationKey = '发行日期';

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
}, scan: BangumiGameInfoboxScan = scanBangumiGameInfobox(record)): BangumiGamePublication {
  if (!scan.handledInfobox) return empty;
  if (scan.overflow) return omission('/infobox', 'infobox_field_limit');
  if (scan.malformed) return omission('/infobox', 'unsupported_infobox_structure');
  const dates = scan.fields.filter((field) => field.key === publicationKey);
  if (dates.length > 1) return omission(`/infobox/${publicationKey}`, 'ambiguous_publication_date');
  if (dates.length === 0) return empty;

  const occurrence = dates[0]!;
  const time = occurrence.nested || occurrence.continued ? undefined : bangumiPublicationTime(occurrence.value.trim());
  if (!time) return omission(`/infobox/${publicationKey}`, 'unsupported_publication_date');
  return {
    facts: [{ property: 'schema:datePublished', content: time, field: 'date' }],
    diagnostics: [],
  };
}

function omission(pointer: string, code: string): BangumiGamePublication {
  return { facts: [], diagnostics: [{ pointer, code }] };
}
