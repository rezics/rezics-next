import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { MAIN_LANGUAGE_LIMIT, chooseMainLanguage } from '../work/selection-heads.ts';
import type { FeedViewerState } from './contract.ts';
import type { FeedReader } from './read.ts';
import type { FeedReadFrame } from './frame.ts';
import { feedCompositions, type FeedComposition } from './compositions.ts';
import type { OccurrenceRecord } from '../structure/format.ts';

type Available = Extract<FeedViewerState, { status: 'available' }>;
type Target = { activity: string; work: string | null; occurrence?: string };
export const VIEWER_STATE_COST = { activities: 8, chaptersPerWork: 6 } as const;

/** Four selected-key Content statements, one composition/header graph batch,
 * one language batch and one publication batch. Saved progress seeks its exact
 * immutable position; neither completed prefixes nor the reader's entire
 * shelf are scanned. Object reads grow with emitted Books and tree height. */
export class FeedViewerStateReader {
  async read(reader: FeedReader, targets: readonly Target[], session: WorkReadSession,
    frame?: FeedReadFrame, supplied?: ReadonlyMap<string, FeedComposition>): Promise<ReadonlyMap<string, Available>> {
    if (targets.length > VIEWER_STATE_COST.activities) throw new WorkReadUnavailable('Feed viewer batch exceeds budget');
    const status = session.deps.libraryStatus, canRead = session.deps.access.canReadAsBaselineMember;
    if (!status || !canRead || !(frame ? frame.owner !== null : await canRead.call(session.deps.access, reader.principal, reader.agent)))
      throw new WorkReadUnavailable('Reader state is unavailable');
    const works = [...new Set(targets.flatMap(target => target.work ? [target.work] : []))];
    const [shelves, compositions] = await Promise.all([status.batch(reader.agent, works),
      supplied ?? feedCompositions(session, works)]);
    const books = new Map([...compositions].filter(([work, value]) => works.includes(work) && value.header.profile === 'book-composition'));
    const structures = [...books.values()].map(book => book.header.structure);
    const progress = await status.progress(reader.principal, structures);
    const revisions = [...new Set([...progress.values()].flatMap(row => row.selectedRevision ? [row.selectedRevision] : []))];
    const languages = books.size ? await session.query(`SELECT ?part ?work ?revision ?language WHERE {
      { VALUES (?work ?main) { ${[...books].map(([work,book]) => `(${iri(work)} ${iri(book.header.mainVersion)})`).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?selection . }
        GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:language ?language . }
        BIND("main" AS ?part) }
      UNION { VALUES ?revision { ${revisions.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:ContentPublicationDecision ; rv:contentRevision ?revision ; rv:contentLanguage ?language . }
        BIND("progress" AS ?part) }
    } LIMIT ${books.size * MAIN_LANGUAGE_LIMIT + revisions.length + 1}`, books.size * MAIN_LANGUAGE_LIMIT + revisions.length) : [];
    const byWork = new Map(shelves.map(row => [row.work,row]));
    const next = new Map<string, { record: OccurrenceRecord; language: string }>();
    const paths = new Map<string, string | null>();
    for (const [work, book] of books) {
      const saved = progress.get(book.header.structure);
      const mainLanguages = languages.filter(row => row.work?.value === work && row.language)
        .map(row => ({ language: row.language!.value, selection: '' }));
      const selected = chooseMainLanguage(mainLanguages, saved?.selectedRevision
        ? languages.find(row => row.revision?.value === saved.selectedRevision)?.language?.value : undefined);
      if (!selected) continue;
      const cards = targets.filter(target => target.work === work && target.occurrence).map(target => target.occurrence!);
      const records = await book.lookup([...new Set([...cards, ...(saved ? [saved.occurrence] : [])])]);
      const current = saved ? records.get(saved.occurrence) : undefined;
      for (const [id, record] of records) paths.set(id, await book.path(record));
      if (byWork.get(work)?.status !== 'reading' && !saved && !cards.length) continue;
      const record = saved ? !current || current.state !== 'active' ? null
        : saved.completed ? await book.next(current) : current : await book.next();
      if (record?.target) next.set(work, { record, language: selected.language.toLowerCase() });
    }
    const publications = next.size ? await session.query(`SELECT DISTINCT ?work ?occurrence ?revision WHERE {
      VALUES (?work ?occurrence ?target ?language) { ${[...next].map(([work,item]) =>
        `(${iri(work)} ${iri(item.record.occurrence)} ${iri(item.record.target!)} ${lit(item.language.toLowerCase())})`).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?target ; rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:ContentPublicationDecision ; rv:contentRevision ?revision ; rv:contentLanguage ?recordedLanguage .
        ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?decision ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
      FILTER(LCASE(STR(?recordedLanguage)) = ?language)
    } LIMIT ${next.size + 1}`, next.size) : [];
    const result = new Map<string, Available>();
    for (const target of targets) {
      const work = target.work, state = work ? byWork.get(work) : undefined;
      const book = work ? books.get(work) : undefined, saved = book ? progress.get(book.header.structure) : undefined;
      const candidate = work ? next.get(work) : undefined;
      const published = candidate && publications.find(row => row.work?.value === work && row.occurrence?.value === candidate.record.occurrence);
      const available = published && (candidate!.record.selection?.mode !== 'fixed-revision'
        || candidate!.record.selection.revision === published.revision?.value);
      const cardPath = target.occurrence ? paths.get(target.occurrence) : null;
      const savedPath = saved ? paths.get(saved.occurrence) : null;
      const hidden = !!target.occurrence && state?.status !== 'read'
        && (!saved || !cardPath || !savedPath || cardPath > savedPath);
      result.set(target.activity, { status: 'available',
        ...(available && candidate && work ? { nextUnread: { work, occurrence: candidate.record.occurrence, language: candidate.language } } : {}),
        shelf: state?.status && work ? { id: work, status: state.status } : null,
        progress: saved ? { composition: saved.structure, occurrence: saved.occurrence,
          selectedRevision: saved.selectedRevision, completed: saved.completed, position: saved.position } : null,
        spoiler: { policy: 'hide-unread', hidden } });
    }
    const [shelvesNow, progressNow, allowed] = await Promise.all([status.batch(reader.agent, works),
      status.progress(reader.principal, structures), frame ? true : canRead.call(session.deps.access, reader.principal, reader.agent)]);
    if (!allowed || JSON.stringify(shelvesNow) !== JSON.stringify(shelves)
      || JSON.stringify([...progressNow]) !== JSON.stringify([...progress])) throw new WorkReadMoved('Reader state changed');
    return result;
  }
}
