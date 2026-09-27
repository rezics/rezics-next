import type { VerifiedPrincipal } from '../access/admission.ts';
import { readFollowTarget } from '../follows/read.ts';
import { readChapter, readContents } from '../work-contents/read.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { CONTINUE_COST } from './contract.ts';

export async function readContinue(session: WorkReadSession, principal: VerifiedPrincipal,
  agent: string, limit = 6) {
  const { follows, libraryStatus: status, homePersonal } = session.deps;
  if (!follows || !status || !homePersonal || !session.deps.access.canReadAsBaselineMember
    || !await session.deps.access.canReadAsBaselineMember(principal, agent)) {
    throw new WorkReadUnavailable('Continue is unavailable');
  }
  const fence = await status.fence(agent);
  const personal = await homePersonal.read(principal, agent);
  const reading = await status.page(agent, 'reading', CONTINUE_COST.candidatesPerSource);
  const followed = await follows.read(principal, agent, '', 'work', CONTINUE_COST.candidatesPerSource);
  const followedSet = new Set(followed.rows.map(row => row.target));
  const works = [...new Set([...reading.map(row => row.work), ...followed.rows.map(row => row.target)])]
    .slice(0, CONTINUE_COST.maxCandidates);
  const statuses = new Map((await status.batch(agent, works)).map(row => [row.work, row]));
  const hidden = new Set(personal.exclusions.filter(rule => rule.kind === 'continue' && rule.strength === 'hide')
    .map(rule => rule.target));
  const items: { work: string; title: Awaited<ReturnType<typeof readFollowTarget>>['name'];
    cover: Awaited<ReturnType<typeof readFollowTarget>>['icon']; source: 'reading' | 'followed';
    lastPosition: { occurrence: string; position: string | null; completed: boolean; updatedAt: string } | null;
    nextUnread: { occurrence: string; title: string | null; href: string };
    unreadCount: { value: number; kind: 'exact' | 'lower-bound' }; updatedAt: string }[] = [];
  const publicSession = new WorkReadSession(session.deps, new Request(session.request.url),
    { language: session.options.language }, session.position);
  for (const work of works) {
    if (hidden.has(work)) continue;
    const state = statuses.get(work);
    if (state?.status !== 'reading' && !followedSet.has(work)) continue;
    try {
      const target = await readFollowTarget(publicSession, work, 'work');
      const privateSession = new WorkReadSession(session.deps, session.request,
        { actingSubject: agent, limit: CONTINUE_COST.chaptersPerWork }, session.position);
      privateSession.principal = principal;
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
      if (!next) continue;
      items.push({ work, title: target.name, cover: target.icon,
        source: state?.status === 'reading' ? 'reading' : 'followed',
        lastPosition: progress ? { occurrence: progress.occurrence, position: progress.position,
          completed: progress.completed, updatedAt: progress.changedAt } : null,
        nextUnread: { occurrence: next.occurrence, title: next.title,
          href: `/w/${work.slice(-36)}/read/${next.occurrence.slice(-36)}${page.language
            ? `?language=${encodeURIComponent(page.language)}` : ''}` },
        unreadCount: { value: unread, kind: countKind },
        updatedAt: progress?.changedAt ?? state?.changedAt ?? new Date(0).toISOString() });
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }
  if (await status.fence(agent) !== fence || (await homePersonal.read(principal, agent)).revision !== personal.revision
    || (await follows.read(principal, agent, '', 'work', 1)).revision !== followed.revision
    || !await session.deps.access.canReadAsBaselineMember(principal, agent)) {
    throw new WorkReadMoved('Continue changed');
  }
  items.sort((a, b) => Number(b.source === 'reading') - Number(a.source === 'reading')
    || b.updatedAt.localeCompare(a.updatedAt) || b.work.localeCompare(a.work));
  return { profile: 'home-continue-v1' as const, items: items.slice(0, limit), sourcePosition: session.position,
    scanned: { reading: reading.length, followed: followed.rows.length, limit: CONTINUE_COST.maxCandidates } };
}
