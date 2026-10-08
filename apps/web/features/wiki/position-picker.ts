import type { EntityPickerItem, EntityPickerLoad, EntityPickerPage } from '@rezics/ui/entity-picker';
import type { ZoneText } from '@rezics/zone-sdk';
import { problemCode, type MainClient } from '../discover/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { idOf } from '../work-page/route.ts';
import type { WikiMessages } from './messages.ts';
import { withPosition } from './position.ts';

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }>
  ? NonNullable<Data>
  : never;
export type ReadingPositionPage = Ok<ReturnType<MainClient['v1']['reading-positions']>['get']>;
export type ReadingPositionItem = ReadingPositionPage['items'][number];
export interface PositionPickerItem extends EntityPickerItem {
  href: string;
  text: ZoneText;
  current: boolean;
}
/** Main's problem code when an episode series cannot jump by number yet. */
export const readingSeekUnavailable = 'reading_seek_unavailable';

export class PositionReadError extends Error {
  readonly code?: string;
  constructor(readonly status: number, code?: string) {
    super('Reading positions unavailable');
    this.code = code;
  }
}

/** The sentence for a numeric jump Main refused, or null when the failure stays the generic unavailable state. */
export function positionChooserNotice(
  code: string | undefined,
  copy: Pick<WikiMessages, 'numberSeekUnavailable'>,
): string | null {
  return code === readingSeekUnavailable ? copy.numberSeekUnavailable : null;
}

export interface PositionLoadMemory {
  /** The query whose numeric jump was refused, still sitting in the field. */
  refusedQuery: string | null;
  /** The first page of the unfiltered list, so paging can continue under that query. */
  browseFirst: EntityPickerPage<PositionPickerItem> | null;
}

/**
 * A refused numeric jump keeps the typed query and answers with the chapter list instead of failing the chooser.
 * Title search and any other error use the ordinary page or the ordinary failure.
 */
export async function loadPositionPickerPage(
  query: { q: string; cursor: string | null },
  fetchPage: EntityPickerLoad<PositionPickerItem>,
  memory: PositionLoadMemory,
): Promise<PositionLoadMemory & { page: EntityPickerPage<PositionPickerItem> }> {
  const refused = memory.refusedQuery !== null && query.q === memory.refusedQuery;
  try {
    const page = await fetchPage(refused ? { q: '', cursor: query.cursor } : query);
    return {
      page,
      refusedQuery: refused ? query.q : null,
      browseFirst: !query.q && !query.cursor ? page : memory.browseFirst,
    };
  } catch (error) {
    if (!(error instanceof PositionReadError) || error.code !== readingSeekUnavailable || !query.q || query.cursor)
      throw error;
    // The field keeps the number; the list underneath is the browsable order, not an empty failure.
    const browseFirst = memory.browseFirst ?? await fetchPage({ q: '', cursor: null });
    return { page: browseFirst, refusedQuery: query.q, browseFirst };
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('value' in error)) return undefined;
  return problemCode(error.value);
}

/** The content's own language survives interface-language selection. */
export function pickPositionLabel(
  labels: readonly { value: string; language: string }[] | undefined,
  locale: string,
): ZoneText | null {
  if (!labels?.length) return null;
  const base = (tag: string) => tag.split('-')[0]!.toLowerCase();
  const chosen =
    labels.find((label) => label.language === locale) ??
    labels.find((label) => base(label.language) === base(locale)) ??
    labels.find((label) => base(label.language) === 'en') ??
    labels[0]!;
  return zoneContentText(chosen.value, chosen.language);
}

/** Main searches every carried language and applies disclosure before the page bound. */
export async function readReadingPositionPage(
  main: MainClient,
  input: {
    work: string;
    position?: string;
    actingSubject?: string;
    q?: string;
    cursor?: string;
    limit?: number;
    language?: string;
    /** Answer the chapters either side of this occurrence instead of a page. */
    around?: string;
    /** Answer the first chapter the reader may see from where this record is revealed. */
    firstSeen?: string;
  },
): Promise<ReadingPositionPage> {
  const { work, ...query } = input;
  const read = () =>
    main.v1['reading-positions']({ work: work.slice(-36) }).get({
      query: {
        ...query,
        // A lookup answers one bounded read and takes no page size.
        ...(input.around || input.firstSeen ? {} : { limit: input.limit ?? 50 }),
      },
    });
  let answer = await read();
  if (answer.error?.status === 409 && !input.cursor) answer = await read();
  if (answer.error || !answer.data)
    throw new PositionReadError(answer.error?.status ?? 503, errorCode(answer.error));
  const page = answer.data;
  if (
    (!page.complete && page.search?.status !== 'indexing' && (!page.nextCursor || page.nextCursor === input.cursor)) ||
    (page.complete && (page.nextCursor !== null || page.search?.status === 'indexing'))
  )
    throw new PositionReadError(503);
  return page;
}

/** No labels or local filtering are loaded after pagination; a hidden name stays hidden. */
export function positionPickerPage(
  page: Pick<ReadingPositionPage, 'items' | 'nextCursor' | 'complete' | 'search'>,
  here: string,
  locale: string,
  current: string | null,
): EntityPickerPage<PositionPickerItem> {
  return {
    nextCursor: page.nextCursor,
    complete: page.complete,
    updating: page.search?.status === 'indexing',
    items: page.items.map((item) => {
      const value = idOf(item.occurrence);
      if (!value) throw new PositionReadError(503);
      const text =
        pickPositionLabel(item.labels, locale) ??
        zoneContentText(
          item.displayLabel ?? (item.ordinal ? String(item.ordinal) : value.slice(0, 8)),
        );
      return {
        value,
        label: text.value,
        text,
        current: value === current,
        href: withPosition(here, { kind: 'at', occurrence: value }),
      };
    }),
  };
}
