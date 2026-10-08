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

/** The chapters either side of one chapter that the reader may see, and whether their position has reached it. */
export interface ChapterNeighbours {
  previous: ChooserItem | null;
  next: ChooserItem | null;
  /**
   * How the previous side settled. `none` is the first chapter. `bound` means the scan window ran out,
   * which does not say that this chapter is first.
   */
  previousStatus: 'found' | 'none' | 'bound';
  reached: boolean;
}

type LookupPage = Awaited<ReturnType<typeof readReadingPositionPage>>;
const itemAt = (page: LookupPage, step: { status: string; occurrence?: string } | undefined) =>
  step?.status === 'found' ? (page.items.find((item) => item.occurrence === step.occurrence) ?? null) : null;

/**
 * Main's bounded read of the chapters around one: the previous and next chapter the reader may see, in reading
 * order across volumes. A side Main could not settle within its scan window, or that has no chapter, is null.
 * A chapter the reader may not see is `missing`, as one that does not exist. `position` is what every other
 * read of the page sends (omitted, Main chooses for the reader).
 */
export const readNeighbours = cache(
  async (
    work: string,
    occurrence: string,
    position: string | undefined,
  ): Promise<Loaded<ChapterNeighbours>> => {
    const { main, actingSubject } = await reader();
    try {
      const page = await readReadingPositionPage(main, { work, actingSubject, position, around: occurrence });
      const neighbours = page.neighbours;
      if (!neighbours) return { ok: false, failure: 'unavailable' };
      const side = neighbours.previous;
      const previousStatus = side.status === 'none' ? 'none' as const
        : side.status === 'bound' ? 'bound' as const : 'found' as const;
      return {
        ok: true,
        data: {
          previous: itemAt(page, neighbours.previous),
          next: itemAt(page, neighbours.next),
          previousStatus,
          reached: neighbours.reached,
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

/**
 * The first chapter the reader may see from where a record is revealed in the Work, or null when Main has no
 * such chapter within its bound, the record is not placed by position, or the read failed.
 */
export const readFirstAppearance = cache(
  async (work: string, record: string, position: string | undefined): Promise<ChooserItem | null> => {
    const { main, actingSubject } = await reader();
    try {
      const page = await readReadingPositionPage(main, { work, actingSubject, position, firstSeen: record });
      return itemAt(page, page.appearance);
    } catch {
      return null;
    }
  },
);

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
