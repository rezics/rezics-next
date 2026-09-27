import { readChapter, readContents } from '../work-contents/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable, WorkReadMissing }
  from '../work/read-session.ts';
import type { FeedViewerState } from './contract.ts';
import type { FeedReader } from './read.ts';

type Available = Extract<FeedViewerState, { status: 'available' }>;
type Target = { activity: string; work: string | null; occurrence?: string };
/** At most eight Works and the first six chapters per Work. A missing composition
 * yields no next-chapter action; incomplete pagination never claims caught up. */
export const VIEWER_STATE_COST = { activities: 8, chaptersPerWork: 6 } as const;

export class FeedViewerStateReader {
  async read(reader: FeedReader, targets: readonly Target[], session: WorkReadSession): Promise<ReadonlyMap<string, Available>> {
    if (targets.length > VIEWER_STATE_COST.activities) throw new WorkReadUnavailable('Feed viewer batch exceeds budget');
    const status = session.deps.libraryStatus;
    if (!status || !session.deps.access.canReadAsBaselineMember
      || !await session.deps.access.canReadAsBaselineMember(reader.principal, reader.agent)) {
      throw new WorkReadUnavailable('Reader state is unavailable');
    }
    const works = [...new Set(targets.flatMap(target => target.work ? [target.work] : []))];
    const fence = await status.fence(reader.agent);
    const shelves = await status.batch(reader.agent, works);
    const rows = works.length ? await session.query(`SELECT ?work ?structure WHERE { VALUES ?work {
      ${works.map(iri).join(' ')} } GRAPH ${iri(GRAPHS.current)} {
      ?work rv:mainVersion ?main . ?structure a rv:Structure ; rv:structureOf ?main ;
        rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?generation .
      ?generation rv:generationState rv:Active . } } LIMIT ${VIEWER_STATE_COST.activities + 1}`,
    VIEWER_STATE_COST.activities + 1) : [];
    const structures = new Map(rows.map(row => [row.work!.value, row.structure!.value]));
    if (structures.size !== rows.length) throw new WorkReadUnavailable('Work composition is ambiguous');
    const progress = await status.progress(reader.principal, [...structures.values()]);
    const byWork = new Map(shelves.map(row => [row.work, row]));
    const chapterCards = new Set(targets.filter(target => target.occurrence).map(target => target.work));
    const privateSession = new WorkReadSession(session.deps, session.request,
      { language: session.options.language, actingSubject: reader.agent,
        limit: VIEWER_STATE_COST.chaptersPerWork }, session.position);
    privateSession.principal = reader.principal;
    const chapters = new Map<string, Awaited<ReturnType<typeof readContents>>>();
    for (const work of works) {
      if (!structures.has(work)) continue;
      if (byWork.get(work)?.status !== 'reading' && !progress.has(structures.get(work)!)
        && !chapterCards.has(work)) continue;
      try { chapters.set(work, await readContents(privateSession, work, {})); }
      catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
    }
    const result = new Map<string, Available>();
    const distantNext = new Map<string, { occurrence: string; language?: string } | null>();
    for (const target of targets) {
      const work = target.work;
      const state = work ? byWork.get(work) : null;
      const read = work ? progress.get(structures.get(work) ?? '') : null;
      const page = work ? chapters.get(work) : null;
      const entries = page?.items.filter(item => item.role === 'chapter' && item.availability === 'available') ?? [];
      const lastIndex = read ? entries.findIndex(item => item.occurrence === read.occurrence) : -1;
      const nextIndex = read ? lastIndex < 0 ? -1 : read.completed ? lastIndex + 1 : lastIndex : 0;
      const next = entries[nextIndex];
      if (work && read && (lastIndex < 0 || read.completed && !next && !!page?.nextCursor)
        && !distantNext.has(work)) {
        try {
          const current = await readChapter(privateSession, read.occurrence, { language: page?.language ?? undefined });
          distantNext.set(work, read.completed
            ? current.next ? { occurrence: current.next, language: current.language } : null
            : { occurrence: current.occurrence, language: current.language });
        } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; distantNext.set(work, null); }
      }
      const distant = work ? distantNext.get(work) : null;
      const itemIndex = target.occurrence ? entries.findIndex(item => item.occurrence === target.occurrence) : -1;
      let hidden = false;
      if (target.occurrence && state?.status !== 'read') {
        if (!read) hidden = true;
        else if (lastIndex >= 0) hidden = itemIndex < 0 || itemIndex > lastIndex;
        else hidden = itemIndex < 0 && target.occurrence !== read.occurrence;
      }
      result.set(target.activity, { status: 'available',
        ...(work && (next || distant) ? { nextUnread: { work, occurrence: next?.occurrence ?? distant!.occurrence,
          ...((page?.language ?? distant?.language) ? { language: page?.language ?? distant?.language } : {}) } } : {}),
        shelf: state?.status && work ? { id: work, status: state.status } : null,
        progress: read ? { composition: read.structure, occurrence: read.occurrence,
          selectedRevision: read.selectedRevision, completed: read.completed, position: read.position } : null,
        spoiler: { policy: 'hide-unread', hidden } });
    }
    if (await status.fence(reader.agent) !== fence
      || !await session.deps.access.canReadAsBaselineMember(reader.principal, reader.agent)) {
      throw new WorkReadMoved('Reader state changed');
    }
    return result;
  }
}
