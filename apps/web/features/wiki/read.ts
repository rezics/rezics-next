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
export interface ChooserItem { occurrence: string; work: string; structure: string; role: 'part' | 'chapter' | 'group' }
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
    items.push(...read.data.items.map(({ occurrence, work: owner, structure, role }) => ({ occurrence, work: owner, structure, role })));
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

/** A label a composition gives an occurrence, in the language it was written in. */
export interface OccurrenceLabel { language: string; value: string }

/** At most this many pages of a composition are read for its labels (Main's pages are 100 occurrences). */
const LABEL_PAGES = 10;

/** The labels of a composition's occurrences (`Chapter 3`), by occurrence IRI. A resource summary names a chapter after its Work. */
export const readLabels = cache(async (structure: string): Promise<Map<string, OccurrenceLabel[]>> => {
  const { main, actingSubject } = await reader();
  const labels = new Map<string, OccurrenceLabel[]>();
  const id = structure.slice(-36);
  let after: string | undefined;
  for (let page = 0; page < LABEL_PAGES; page++) {
    const read = await settle(() => main.v1.compositions({ id }).get({ query: { actingSubject, after, limit: 100 } }), after);
    if (!read.ok) break;
    for (const item of read.data.occurrences) if (item.state === 'active') labels.set(item.occurrence, item.labels);
    after = read.data.next ?? undefined;
    if (!after) break;
  }
  return labels;
});
