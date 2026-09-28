import { SeedApiError, type SeedApi } from './api.ts';
import { seedKey } from './plan.ts';

const short = (id: string) => id.slice(-36);

export interface OutlineItem { occurrence: string; parent: string; role: 'group' | 'chapter';
  label: { value: string; language: string } | null; target: string | null; selectedRevision: string | null;
  division?: 'volume' | 'part' | 'extras' | null }
interface Level { compositionRevision: string; nextCursor: string | null; items: OutlineItem[] }
/** Who reads the outline: its author (who also sees unpublished chapters), or the public. */
export interface OutlineReader { token: string; actingSubject: string }

/**
 * A Book's composition in reading order: the top level, each group followed by
 * its chapters, one Main contents read per page of each level. A Book with no
 * composition yet reads as empty.
 */
export async function readBookOutline(api: Pick<SeedApi, 'get' | 'getPublic'>, work: string, language: string,
  reader?: OutlineReader): Promise<{ head: string | null; items: OutlineItem[] }> {
  const level = async (parent?: string) => {
    const items: OutlineItem[] = [];
    let cursor: string | null = null;
    let head: string | null = null;
    do {
      const query = new URLSearchParams({ language, limit: '20', ...(parent ? { parent } : {}),
        ...(cursor ? { cursor } : {}), ...(reader ? { actingSubject: reader.actingSubject } : {}) });
      const path = `/v1/works/${short(work)}/contents?${query}`;
      const page: Level = reader ? await api.get(path, reader.token) : await api.getPublic(path);
      items.push(...page.items);
      head = page.compositionRevision;
      cursor = page.nextCursor;
    } while (cursor);
    return { head, items };
  };
  let top: Awaited<ReturnType<typeof level>>;
  try { top = await level(); }
  catch (error) {
    if (error instanceof SeedApiError && error.status === 404) return { head: null, items: [] };
    throw error;
  }
  const items: OutlineItem[] = [];
  for (const item of top.items) {
    items.push(item);
    if (item.role === 'group') items.push(...(await level(item.occurrence)).items);
  }
  return { head: top.head, items };
}

/** One group a Book is divided into, and its chapter Works in reading order. */
export interface PlannedGroup { title: string; division: 'volume' | 'part' | 'extras'; chapters: readonly string[] }

/**
 * Divides a Book into its planned volumes, parts or extras: a missing group is
 * made at its place among the others (the first before everything, each later
 * one after the one before it), then each group's chapters are moved into it in
 * order. Groups are known by title and chapters by Work, so a replay on a Book
 * that already stands as planned sends nothing; each change names the head it
 * was made on.
 */
export async function arrangeBook(api: Pick<SeedApi, 'get' | 'getPublic' | 'post'>, input: {
  work: string; structure: string; language: string; reader: OutlineReader; groups: readonly PlannedGroup[];
  key: string;
}): Promise<{ changes: number }> {
  let outline = await readBookOutline(api, input.work, input.language, input.reader);
  let changes = 0;
  const groupOf = (title: string) => outline.items.find(item => item.role === 'group'
    && item.parent === input.structure && item.label?.value === title);
  const change = async (operations: object[], step: string) => {
    if (!outline.head) throw new Error(`Book ${input.key} has no composition to arrange`);
    await api.post(`/v1/compositions/${short(input.structure)}/changes`, { profile: 'book-composition',
      expectedHead: outline.head, actingSubject: input.reader.actingSubject, operations },
    input.reader.token, seedKey('book-arrange', `${input.key}:${step}:${short(outline.head)}`));
    changes++;
    outline = await readBookOutline(api, input.work, input.language, input.reader);
  };
  for (const [index, group] of input.groups.entries()) {
    if (groupOf(group.title)) continue;
    const previous = index ? groupOf(input.groups[index - 1]!.title) : undefined;
    await change([{ op: 'insert', parent: input.structure, position: previous ? { after: previous.occurrence } : 'first',
      role: 'group', division: group.division, label: { value: group.title, language: input.language } }],
    `group-${index}`);
  }
  for (const [index, group] of input.groups.entries()) {
    const owner = groupOf(group.title)!;
    const wanted = group.chapters.map(work => outline.items.find(item => item.role === 'chapter'
      && item.target === work)?.occurrence).filter((occurrence): occurrence is string => Boolean(occurrence));
    // Planned chapters stand in the group in order; any other chapter already there is left where it is.
    const current = outline.items.filter(item => item.role === 'chapter' && item.parent === owner.occurrence
      && wanted.includes(item.occurrence)).map(item => item.occurrence);
    if (wanted.length === current.length && wanted.every((occurrence, at) => current[at] === occurrence)) continue;
    // Main applies a change's moves in order, so each lands after the one before it.
    await change(wanted.slice(0, 16).map((occurrence, at) => ({ op: 'move', occurrence, parent: owner.occurrence,
      position: at ? { after: wanted[at - 1]! } : 'first' })), `chapters-${index}`);
  }
  return { changes };
}
