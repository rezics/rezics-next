import { readChapter, readContents } from '../work-contents/read.ts';
import { nextChapter } from '../structure/reading-order.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMoved, WorkReadSession, WorkReadUnavailable }
  from '../work/read-session.ts';
import type { FeedViewerState } from './contract.ts';
import { inOrder, settle, unwrap } from './settled.ts';
import type { FeedReader } from './read.ts';

type Available = Extract<FeedViewerState, { status: 'available' }>;
type Target = { activity: string; work: string | null; occurrence?: string };
/** At most eight Works and the first six chapters per Work. A missing composition
 * yields no next-chapter action; incomplete pagination never claims caught up.
 * A Book with volumes resolves its next chapter by one exact chapter read (after
 * a bounded reading-order walk when the reader has not started it). */
export const VIEWER_STATE_COST = { activities: 8, chaptersPerWork: 6 } as const;

export class FeedViewerStateReader {
  async read(reader: FeedReader, targets: readonly Target[], session: WorkReadSession): Promise<ReadonlyMap<string, Available>> {
    if (targets.length > VIEWER_STATE_COST.activities) throw new WorkReadUnavailable('Feed viewer batch exceeds budget');
    const status = session.deps.libraryStatus;
    const canRead = session.deps.access.canReadAsBaselineMember;
    if (!status || !canRead) throw new WorkReadUnavailable('Reader state is unavailable');
    const works = [...new Set(targets.flatMap(target => target.work ? [target.work] : []))];
    // Independent owner reads run together; each dependent stage waits only for its inputs.
    const [allowed, rest] = await inOrder(canRead.call(session.deps.access, reader.principal, reader.agent),
      settle(inOrder(status.fence(reader.agent), status.batch(reader.agent, works),
      works.length ? session.query(`SELECT ?work ?structure WHERE { VALUES ?work {
      ${works.map(iri).join(' ')} } GRAPH ${iri(GRAPHS.current)} {
      ?work rv:mainVersion ?main . ?structure a rv:Structure ; rv:structureOf ?main ;
        rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?generation .
      ?generation rv:generationState rv:Active . } } LIMIT ${VIEWER_STATE_COST.activities + 1}`,
      VIEWER_STATE_COST.activities + 1) : [])));
    if (!allowed) throw new WorkReadUnavailable('Reader state is unavailable');
    const [fence, shelves, rows] = unwrap(rest);
    const structures = new Map(rows.map(row => [row.work!.value, row.structure!.value]));
    if (structures.size !== rows.length) throw new WorkReadUnavailable('Work composition is ambiguous');
    const progress = await status.progress(reader.principal, [...structures.values()]);
    const revisions = [...new Set([...progress.values()].flatMap(row =>
      row.selectedRevision ? [row.selectedRevision] : []))];
    const unkeyed = [...progress.values()].filter(row => !row.selectedRevision).map(row => row.occurrence);
    const [languageRows, occurrenceRows] = await inOrder(revisions.length ? session.query(`SELECT DISTINCT ?revision ?language WHERE {
      VALUES ?revision { ${revisions.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:ContentPublicationDecision ;
        rv:contentRevision ?revision ; rv:contentLanguage ?language . }
    } LIMIT ${VIEWER_STATE_COST.activities + 1}`, VIEWER_STATE_COST.activities + 1) : [],
    unkeyed.length ? session.query(`SELECT ?occurrence
      (MIN(LCASE(STR(?language))) AS ?firstLanguage)
      (MAX(LCASE(STR(?language))) AS ?lastLanguage) WHERE {
      VALUES ?occurrence { ${unkeyed.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?placement a rv:OccurrencePlacement ; rv:occurrence ?occurrence ; schema:item ?target .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
        ?variant a rv:ContentVariant ; rv:resource ?target ;
          rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?decision a rv:ContentPublicationDecision ; rv:contentLanguage ?language .
        ?eligibility a rv:ContentSearchEligibilityDecision ;
          rv:publicationDecision ?decision ; rv:disclosure rv:Public . }
    } GROUP BY ?occurrence LIMIT ${VIEWER_STATE_COST.activities + 1}`,
    VIEWER_STATE_COST.activities + 1) : []);
    const progressLanguages = new Map(languageRows.map(row => [row.revision!.value, row.language!.value]));
    const occurrenceLanguages = new Map(occurrenceRows.flatMap(row =>
      row.firstLanguage?.value === row.lastLanguage?.value && row.firstLanguage
        ? [[row.occurrence!.value, row.firstLanguage.value] as const] : []));
    const byWork = new Map(shelves.map(row => [row.work, row]));
    const chapterCards = new Set(targets.filter(target => target.occurrence).map(target => target.work));
    const privateSession = new WorkReadSession(session.deps, session.request,
      { language: session.options.language, actingSubject: reader.agent,
        limit: VIEWER_STATE_COST.chaptersPerWork }, session.position);
    privateSession.principal = reader.principal;
    const chapters = new Map<string, Awaited<ReturnType<typeof readContents>>>();
    await Promise.all(works.map(async work => {
      if (!structures.has(work)) return;
      if (byWork.get(work)?.status !== 'reading' && !progress.has(structures.get(work)!)
        && !chapterCards.has(work)) return;
      const read = progress.get(structures.get(work)!);
      const language = read?.selectedRevision ? progressLanguages.get(read.selectedRevision)
        : read ? occurrenceLanguages.get(read.occurrence) : undefined;
      try { chapters.set(work, await readContents(privateSession, work, language ? { language } : {})); }
      catch { /* An unreadable composition has no next chapter for this Work. */ }
    }));
    const result = new Map<string, Available>();
    // A saved position beyond the first page resolves by one exact chapter read per Work.
    const distantNext = new Map<string, { occurrence: string; language?: string } | null>();
    await Promise.all(works.map(async work => {
      const read = progress.get(structures.get(work) ?? '');
      const page = chapters.get(work);
      const entries = page?.items.filter(item => item.role === 'chapter' && item.availability === 'available') ?? [];
      const lastIndex = read ? entries.findIndex(item => item.occurrence === read.occurrence) : -1;
      const next = read && lastIndex >= 0 ? entries[read.completed ? lastIndex + 1 : lastIndex] : undefined;
      // In a Book with volumes, the top level alone does not say which chapter comes next.
      const grouped = page?.items.some(item => item.role === 'group') ?? false;
      if (!read && page?.items[0]?.role === 'group') {
        try {
          const first = await nextChapter(session.deps.environment, { structure: structures.get(work)!,
            canReadTarget: async () => true });
          const opened = first ? await readChapter(privateSession, first.record.occurrence,
            { language: page.language ?? undefined }) : null;
          distantNext.set(work, opened ? { occurrence: opened.occurrence, language: opened.language } : null);
        } catch { distantNext.set(work, null); }
        return;
      }
      if (!read || !(grouped || lastIndex < 0 || read.completed && !next && !!page?.nextCursor)) return;
      try {
        const language = read.selectedRevision ? progressLanguages.get(read.selectedRevision)
          : occurrenceLanguages.get(read.occurrence);
        const current = await readChapter(privateSession, read.occurrence,
          { language: language ?? page?.language ?? undefined });
        distantNext.set(work, read.completed
          ? current.next ? { occurrence: current.next, language: current.language } : null
          : { occurrence: current.occurrence, language: current.language });
      } catch { distantNext.set(work, null); }
    }));
    for (const target of targets) {
      const work = target.work;
      const state = work ? byWork.get(work) : null;
      const read = work ? progress.get(structures.get(work) ?? '') : null;
      const page = work ? chapters.get(work) : null;
      const entries = page?.items.filter(item => item.role === 'chapter' && item.availability === 'available') ?? [];
      const lastIndex = read ? entries.findIndex(item => item.occurrence === read.occurrence) : -1;
      const nextIndex = read ? lastIndex < 0 ? -1 : read.completed ? lastIndex + 1 : lastIndex : 0;
      const next = work && distantNext.has(work) ? undefined : entries[nextIndex];
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
    const [fenced, stillAllowed] = await inOrder(status.fence(reader.agent),
      canRead.call(session.deps.access, reader.principal, reader.agent));
    if (fenced !== fence || !stillAllowed) throw new WorkReadMoved('Reader state changed');
    return result;
  }
}
