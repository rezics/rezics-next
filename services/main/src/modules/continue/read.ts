import type { VerifiedPrincipal } from '../access/admission.ts';
import { readFollowTargets } from '../follows/read.ts';
import { readChapter, readContents } from '../work-contents/read.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { GRAPHS, iri, MAX_WORK_SEMANTIC_TYPES, WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { inOrder, settle, unwrap } from '../feed/settled.ts';
import { CONTINUE_COST } from './contract.ts';

/** The owner heads load together, every candidate's public target is one
 * batch, and each Work's contents and progress load concurrently. Items are
 * sorted after, so read order never changes the result. */
export async function readContinue(session: WorkReadSession, principal: VerifiedPrincipal,
  agent: string, limit = 6) {
  const { follows, libraryStatus: status, homePersonal } = session.deps;
  const canRead = session.deps.access.canReadAsBaselineMember;
  if (!follows || !status || !homePersonal || !canRead) throw new WorkReadUnavailable('Continue is unavailable');
  // A denied reader reports unavailable before any private owner answers.
  const [allowed, rest] = await inOrder(canRead.call(session.deps.access, principal, agent),
    settle(inOrder(status.fence(agent), homePersonal.read(principal, agent),
      status.page(agent, 'reading', CONTINUE_COST.candidatesPerSource),
      follows.read(principal, agent, '', 'work', CONTINUE_COST.candidatesPerSource))));
  if (!allowed) throw new WorkReadUnavailable('Continue is unavailable');
  const [fence, personal, reading, followed] = unwrap(rest);
  const followedSet = new Set(followed.rows.map(row => row.target));
  const works = [...new Set([...reading.map(row => row.work), ...followed.rows.map(row => row.target)])]
    .slice(0, CONTINUE_COST.maxCandidates);
  const statuses = new Map((await status.batch(agent, works)).map(row => [row.work, row]));
  const hidden = new Set(personal.exclusions.filter(rule => rule.kind === 'continue' && rule.strength === 'hide')
    .map(rule => rule.target));
  const publicSession = new WorkReadSession(session.deps, new Request(session.request.url),
    { language: session.options.language }, session.position);
  const candidates = works.filter(work => !hidden.has(work)
    && (statuses.get(work)?.status === 'reading' || followedSet.has(work)));
  const targets = await readFollowTargets(publicSession, candidates, 'work');
  const privateSession = new WorkReadSession(session.deps, session.request,
    { actingSubject: agent, limit: CONTINUE_COST.chaptersPerWork }, session.position);
  privateSession.principal = principal;
  const read = await inOrder(...candidates.map(async work => {
    const target = targets.get(work);
    if (!target) return null;
    const state = statuses.get(work);
    try {
      const page = await readContents(privateSession, work, {});
      let chapterItems = page.items;
      if (!chapterItems.some(item => item.role === 'chapter' && item.availability === 'available')) {
        const group = chapterItems.find(item => item.role === 'group');
        if (group) {
          const nested = await readContents(privateSession, work, { parent: group.occurrence });
          chapterItems = nested.items;
        }
      }
      const chapters = chapterItems.filter(item => item.role === 'chapter' && item.availability === 'available');
      const progress = (await status.progress(principal, [page.composition])).get(page.composition);
      const index = progress ? chapters.findIndex(item => item.occurrence === progress.occurrence) : -1;
      const nextIndex = progress ? index + Number(progress.completed) : 0;
      let next = chapters[nextIndex] ? { occurrence: chapters[nextIndex]!.occurrence,
        title: chapters[nextIndex]!.label?.value ?? null } : null;
      let unread = chapters.length - nextIndex;
      let countKind: 'exact' | 'lower-bound' = page.nextCursor || page.items.some(item => item.role === 'group')
        ? 'lower-bound' : 'exact';
      if (progress && (index < 0 || !next && page.nextCursor)) {
        // Exact chapter reads navigate from the saved occurrence even when it
        // is beyond this first page. Their single-neighbor result is a lower bound.
        const current = await readChapter(privateSession, progress.occurrence, { language: page.language ?? undefined });
        const selected = progress.completed && current.next
          ? await readChapter(privateSession, current.next, { language: page.language ?? undefined }) : current;
        next = progress.completed && !current.next ? null
          : { occurrence: selected.occurrence, title: selected.label?.value ?? null };
        unread = 1; countKind = 'lower-bound';
      }
      if (!next) return null;
      return { work, title: target.name, cover: target.icon,
        source: state?.status === 'reading' ? 'reading' as const : 'followed' as const,
        lastPosition: progress ? { occurrence: progress.occurrence, position: progress.position,
          completed: progress.completed, updatedAt: progress.changedAt } : null,
        nextUnread: { occurrence: next.occurrence, title: next.title,
          href: `/w/${work.slice(-36)}/read/${next.occurrence.slice(-36)}${page.language
            ? `?language=${encodeURIComponent(page.language)}` : ''}` },
        unreadCount: { value: unread, kind: countKind },
        updatedAt: progress?.changedAt ?? state?.changedAt ?? new Date(0).toISOString() };
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
      return null;
    }
  }));
  const items = read.filter(item => item !== null);
  const [fenced, personalNow, followsNow, stillAllowed] = await inOrder(status.fence(agent),
    homePersonal.read(principal, agent), follows.read(principal, agent, '', 'work', 1),
    canRead.call(session.deps.access, principal, agent));
  if (fenced !== fence || personalNow.revision !== personal.revision || followsNow.revision !== followed.revision
    || !stillAllowed) {
    throw new WorkReadMoved('Continue changed');
  }
  items.sort((a, b) => Number(b.source === 'reading') - Number(a.source === 'reading')
    || b.updatedAt.localeCompare(a.updatedAt) || b.work.localeCompare(a.work));
  const shown = items.slice(0, limit);
  // One type batch, so each Work keeps the cover it has on every other page.
  const typeRows = shown.length ? await publicSession.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${shown.map(item => iri(item.work)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } }
  } LIMIT ${shown.length * MAX_WORK_SEMANTIC_TYPES + 1}`, shown.length * MAX_WORK_SEMANTIC_TYPES) : [];
  return { profile: 'home-continue-v1' as const, sourcePosition: session.position,
    items: shown.map(item => ({ ...item, types: typeRows.filter(row => row.work?.value === item.work)
      .flatMap(row => row.type ? [row.type.value] : []).sort() })),
    scanned: { reading: reading.length, followed: followed.rows.length, limit: CONTINUE_COST.maxCandidates } };
}
