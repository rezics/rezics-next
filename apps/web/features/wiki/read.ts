import { cache } from 'react';
import type { ZoneRouteRead } from '../realm/types.ts';
import { failureOf, reader, settle } from '../work-page/read.ts';
import type { Loaded } from '../work-page/types.ts';
import type { MainClient } from '../discover/types.ts';
import {
  PositionReadError,
  readReadingPositionPage,
  type ReadingPositionItem,
} from './position-picker.ts';

// Server reads a position-aware Zone makes. Each sends the reading position (`all` or an occurrence IRI; omitted,
// Main chooses for the reader) and trusts what comes back: records revealed later are withheld before delivery, so
// nothing here filters, counts or hides a record.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }>
  ? NonNullable<Data>
  : never;
export type Evidence = Ok<ReturnType<MainClient['v1']['wiki']['evidence']>['get']>;

/**
 * What Main resolves a path under the Zone to, read as the signed-in reader (their own progress is the default
 * position) at `position`. The Zone's other reads are public; a position needs the reader.
 */
export const readPositionedRoute = cache(
  async (
    zone: string,
    path: string,
    cursor: string | undefined,
    position: string | undefined,
  ): Promise<Loaded<ZoneRouteRead>> => {
    const { main, actingSubject } = await reader();
    return settle(
      () =>
        main.v1
          .zones({ id: zone })
          .routes.get({ query: { path, cursor, actingSubject, position } }),
      cursor,
    );
  },
);

/** One occurrence of the chooser: Main's order, with the Work it belongs to (a volume, or the franchise itself). */
export type ChooserItem = Pick<
  ReadingPositionItem,
  'occurrence' | 'work' | 'structure' | 'role' | 'labels' | 'displayLabel' | 'ordinal'
>;
export interface Chooser {
  /** The Work the occurrences are positions in. */
  work: string;
  /** What the read resolved to for this reader: `all`, `start` or the occurrence they are up to. */
  resolved: string;
  /** `resume` is only the chapter the reader is on. `positions` is a page of the disclosed order. */
  scope?: 'resume' | 'positions';
  items: ChooserItem[];
  /** The Work has more positions than this read listed. */
  more: boolean;
  /** Continuation for the chooser; a preview is never the whole reading order. */
  nextCursor?: string | null;
}
/** The positions a reader may choose in a Work, in reading order, and where Main put them by default. */
export const readChooser = cache(
  async (work: string, position: string | undefined, cursor?: string): Promise<Loaded<Chooser>> => {
    const { main, actingSubject } = await reader();
    try {
      const data = await readReadingPositionPage(main, {
        work,
        actingSubject,
        position,
        cursor,
        limit: 50,
      });
      return {
        ok: true,
        data: {
          work,
          resolved: data.resolved,
          scope: data.scope === 'resume' || data.scope === 'positions' ? data.scope : undefined,
          items: data.items,
          more: !data.complete,
          nextCursor: data.nextCursor,
        },
      };
    } catch (error) {
      return {
        ok: false,
        failure: error instanceof PositionReadError ? failureOf(error.status) : 'unavailable',
      };
    }
  },
);

/** Pages of the disclosed order read for one chapter's neighbours (each page is at most 50 positions). */
export const READING_ORDER_PAGES = 4;

/**
 * Chapters around one occurrence, in the order the positions read already discloses.
 * The reader's own progress, requested with no position, is only that chapter. Passing the occurrence asks for the
 * opening positions page, which omits a chapter the reader may not see. Stops once that chapter and one later
 * chapter are listed, the work ends, or the page bound is reached. A failed read returns what was listed so far.
 */
export const readReadingOrder = cache(async (work: string, occurrence: string): Promise<ChooserItem[]> => {
  const items: ChooserItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < READING_ORDER_PAGES; page++) {
    const read = await readChooser(work, occurrence, cursor);
    if (!read.ok || read.data.scope === 'resume') break;
    items.push(...read.data.items);
    const chapters = items.filter((item) => item.role === 'chapter');
    const index = chapters.findIndex((item) => item.occurrence === occurrence);
    const settled = index >= 0 && (index < chapters.length - 1 || !read.data.more);
    if (settled || !read.data.nextCursor) break;
    cursor = read.data.nextCursor;
  }
  return items;
});

/** A claim's source passage and what Main permits of it at `position`; a withheld quotation arrives as null. */
export const readEvidence = cache(
  async (id: string, position: string | undefined): Promise<Loaded<Evidence>> => {
    const { main, actingSubject } = await reader();
    return settle(() => main.v1.wiki.evidence({ id }).get({ query: { actingSubject, position } }));
  },
);

/** A label a composition gives an occurrence, in the language it was written in. */
export interface OccurrenceLabel {
  language: string;
  value: string;
}

/** At most this many pages of a composition are read for its labels (Main's pages are 100 occurrences). */
const LABEL_PAGES = 10;

/** The labels of a composition's occurrences (`Chapter 3`), by occurrence IRI. A resource summary names a chapter after its Work. */
export const readLabels = cache(
  async (
    structure: string,
    needed?: readonly string[],
  ): Promise<Map<string, OccurrenceLabel[]>> => {
    const { main, actingSubject } = await reader();
    const labels = new Map<string, OccurrenceLabel[]>();
    const id = structure.slice(-36);
    let after: string | undefined;
    for (let page = 0; needed || page < LABEL_PAGES; page++) {
      const read = await settle(
        () => main.v1.compositions({ id }).get({ query: { actingSubject, after, limit: 100 } }),
        after,
      );
      if (!read.ok) break;
      for (const item of read.data.occurrences)
        if (item.state === 'active' && (!needed || needed.includes(item.occurrence))) {
          labels.set(item.occurrence, item.labels);
        }
      if (needed?.every((id) => labels.has(id))) break;
      if (read.data.next === after) break;
      after = read.data.next ?? undefined;
      if (!after) break;
    }
    return labels;
  },
);
