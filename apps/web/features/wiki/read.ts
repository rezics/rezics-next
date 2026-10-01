import { cache } from 'react';
import type { ZoneRouteRead } from '../realm/types.ts';
import { reader, settle } from '../work-page/read.ts';
import type { Loaded } from '../work-page/types.ts';
import type { MainClient } from '../discover/types.ts';

// Server reads a position-aware Zone makes. Each sends the reading position (`all` or an occurrence IRI; omitted,
// Main chooses for the reader) and trusts what comes back: records revealed later are withheld before delivery, so
// nothing here filters, counts or hides a record.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type Evidence = Ok<ReturnType<MainClient['v1']['wiki']['evidence']>['get']>;

/**
 * What Main resolves a path under the Zone to, read as the signed-in reader (their own progress is the default
 * position) at `position`. The Zone's other reads are public; a position needs the reader.
 */
export const readPositionedRoute = cache(async (zone: string, path: string, cursor: string | undefined,
  position: string | undefined): Promise<Loaded<ZoneRouteRead>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.zones({ id: zone }).routes.get({ query: { path, cursor, actingSubject, position } }), cursor);
});

/** One occurrence of the chooser: Main's order, with the Work it belongs to (a volume, or the franchise itself). */
export interface ChooserItem { occurrence: string; work: string; role: 'part' | 'chapter' | 'group' }
export interface Chooser {
  /** The Work the occurrences are positions in. */
  work: string;
  /** What the read resolved to for this reader: `all`, `start` or the occurrence they are up to. */
  resolved: string;
  items: ChooserItem[];
  /** The Work has more positions than this read listed. */
  more: boolean;
}
interface ChooserPage { resolved: string; items: ChooserItem[]; next: string | null }

/** At most this many pages of the chooser are read (Main's pages are 100 positions each). */
const CHOOSER_PAGES = 5;

/** The positions a reader may choose in a Work, in reading order, and where Main put them by default. */
export const readChooser = cache(async (work: string, position: string | undefined): Promise<Loaded<Chooser>> => {
  const { main, actingSubject } = await reader();
  const items: ChooserItem[] = [];
  let resolved = 'start';
  let cursor: string | undefined;
  for (let page = 0; page < CHOOSER_PAGES; page++) {
    const read = await settle(() => main.v1['reading-positions']({ work }).get({ query: {
      actingSubject, position, cursor, limit: 100 } }) as Promise<{ data: ChooserPage | null; error: { status: number } | null }>,
    cursor);
    if (!read.ok) return read;
    resolved = read.data.resolved;
    items.push(...read.data.items.map(({ occurrence, work: owner, role }) => ({ occurrence, work: owner, role })));
    cursor = read.data.next ?? undefined;
    if (!cursor) return { ok: true, data: { work, resolved, items, more: false } };
  }
  return { ok: true, data: { work, resolved, items, more: true } };
});

/** A claim's source passage and what Main permits of it at `position`; a withheld quotation arrives as null. */
export const readEvidence = cache(async (id: string, position: string | undefined): Promise<Loaded<Evidence>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.wiki.evidence({ id }).get({ query: { actingSubject, position } }));
});
