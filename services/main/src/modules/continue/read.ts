import type { VerifiedPrincipal } from '../access/admission.ts';
import { readFollowTargets } from '../follows/read.ts';
import { decodeReadCursor, encodeReadCursor, readDependencyToken, WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadSession, WorkReadUnavailable } from '../work/read-session.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { GRAPHS, iri, MAX_WORK_SEMANTIC_TYPES, WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { inOrder, settle, unwrap } from '../feed/settled.ts';
import { CONTINUE_COST } from './contract.ts';
import { continueChapters } from './chapters.ts';

/** Reading entries in shelf order, then follows in identity order. Each page
 * advances over examined candidates, including hidden or exhausted Books. */
export async function readContinue(session: WorkReadSession, principal: VerifiedPrincipal,
  agent: string, limit = 6, token?: string) {
  const { follows, libraryStatus: status, homePersonal } = session.deps;
  const canRead = session.deps.access.canReadAsBaselineMember;
  if (!follows || !status || !homePersonal || !canRead) throw new WorkReadUnavailable('Continue is unavailable');
  // A denied reader reports unavailable before any private owner answers.
  const [allowed, rest] = await inOrder(canRead.call(session.deps.access, principal, agent),
    settle(inOrder(status.fence(agent), homePersonal.read(principal, agent),
      follows.read(principal, agent, '', 'work', 1))));
  if (!allowed) throw new WorkReadUnavailable('Continue is unavailable');
  const [fence, personal, followFence] = unwrap(rest);
  const binding = ['continue-v2', principal.issuer, principal.subject, agent, limit];
  const position = { ...session.position,
    dependencyToken: readDependencyToken([fence, personal.revision, followFence.revision]) };
  const cursor = decodeReadCursor(token, binding, position);
  const phase = cursor?.order === 'followed' ? 'followed' : 'reading';
  if (cursor && !['reading', 'followed'].includes(cursor.order)) throw new WorkReadInvalid('Invalid Continue cursor');
  let readingAfter: { work: string; changedAt: string } | undefined;
  if (phase === 'reading' && cursor?.after) {
    try {
      readingAfter = JSON.parse(cursor.after);
      if (!readingAfter || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(readingAfter.work)
        || !Number.isFinite(Date.parse(readingAfter.changedAt))) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Invalid Continue cursor'); }
  }
  const readingWindow = phase === 'reading' ? await status.page(agent, 'reading', limit + 1, readingAfter) : [];
  const reading = readingWindow.slice(0, limit);
  const followLimit = phase === 'followed' ? limit : readingWindow.length <= limit ? limit - reading.length : 0;
  const followed = followLimit
    ? await follows.read(principal, agent, phase === 'followed' ? cursor?.after ?? '' : '', 'work', followLimit) : followFence;
  const followRows = followLimit ? followed.rows.slice(0, followLimit) : [];
  const followedSet = new Set(followRows.map(row => row.target));
  const works = [...new Set([...reading.map(row => row.work), ...followRows.map(row => row.target)])]
    .slice(0, CONTINUE_COST.maxCandidates);
  const statuses = new Map((await status.batch(agent, works)).map(row => [row.work, row]));
  const hidden = new Set(personal.exclusions.filter(rule => rule.kind === 'continue' && rule.strength === 'hide')
    .map(rule => rule.target));
  const publicSession = new WorkReadSession(session.deps, new Request(session.request.url),
    { language: session.options.language }, session.position);
  const candidates = works.filter(work => !hidden.has(work)
    && (reading.some(row => row.work === work) || statuses.get(work)?.status !== 'reading' && followedSet.has(work)));
  const targets = await readFollowTargets(publicSession, candidates, 'work');
  const { chapters, progress } = await continueChapters(session, agent,
    candidates.filter(work => targets.has(work)));
  const read = candidates.flatMap(work => {
    const target = targets.get(work);
    const next = chapters.get(work);
    if (!target || !next) return [];
    const state = statuses.get(work);
    const saved = progress.get(work);
    return [{ work, title: target.name, cover: target.icon,
        source: state?.status === 'reading' ? 'reading' as const : 'followed' as const,
        lastPosition: saved ? { occurrence: saved.occurrence, position: saved.position,
          completed: saved.completed, updatedAt: saved.changedAt } : null,
        nextUnread: { occurrence: next.occurrence, title: next.title,
          href: `/w/${work.slice(-36)}/read/${next.occurrence.slice(-36)}?language=${encodeURIComponent(next.language)}` },
        unreadCount: next.unreadCount,
        updatedAt: saved?.changedAt ?? state?.changedAt ?? new Date(0).toISOString() }];
  });
  const [fenced, personalNow, followsNow, stillAllowed] = await inOrder(status.fence(agent),
    homePersonal.fence(principal, agent), follows.read(principal, agent, '', 'work', 1),
    canRead.call(session.deps.access, principal, agent));
  if (fenced !== fence || personalNow.revision !== personal.revision || followsNow.revision !== followed.revision
    || followed.revision !== followFence.revision || !stillAllowed) {
    throw new WorkReadMoved('Continue changed');
  }
  const shown = read.slice(0, limit);
  const expiresAt = cursor?.expiresAt ?? Date.now() + READ_BASIS_RETENTION_MS;
  const lastReading = reading.at(-1);
  const nextCursor = phase === 'reading' && readingWindow.length > limit && lastReading
      ? encodeReadCursor(binding, position, JSON.stringify({ work: lastReading.work,
        changedAt: lastReading.changedAt }), 'reading', expiresAt)
      : !followLimit ? encodeReadCursor(binding, position, '', 'followed', expiresAt)
      : followed.rows.length > followLimit
        ? encodeReadCursor(binding, position, followRows.at(-1)!.target, 'followed', expiresAt) : null;
  // One type batch, so each Work keeps the cover it has on every other page.
  const typeRows = shown.length ? await publicSession.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${shown.map(item => iri(item.work)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } }
  } LIMIT ${shown.length * MAX_WORK_SEMANTIC_TYPES + 1}`, shown.length * MAX_WORK_SEMANTIC_TYPES) : [];
  return { profile: 'home-continue-v1' as const, sourcePosition: session.position, nextCursor, complete: nextCursor === null,
    items: shown.map(item => ({ ...item, types: typeRows.filter(row => row.work?.value === item.work)
      .flatMap(row => row.type ? [row.type.value] : []).sort() })),
    scanned: { reading: reading.length, followed: followRows.length, limit: CONTINUE_COST.maxCandidates } };
}

/** A direct Work read never consults the ranked Continue preview, follows or
 * Home exclusions. It shares Continue's chapter order and progress logic, and
 * also resumes the Book profile's catalog chapters without a Content publication. */
export async function readWorkResume(session: WorkReadSession, principal: VerifiedPrincipal,
  agent: string, work: string) {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) {
    throw new WorkReadInvalid('Invalid resume Work');
  }
  const status = session.deps.libraryStatus;
  const canRead = session.deps.access.canReadAsBaselineMember;
  if (!status || !canRead || !await canRead.call(session.deps.access, principal, agent)) {
    throw new WorkReadUnavailable('Work resume is unavailable');
  }
  const summary = (await session.summaries([work]))[0];
  if (summary?.status !== 'available' || summary.type !== 'work'
    || !await session.deps.access.canReadWork(principal, agent, work)) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const { chapters, progress, structures } = await continueChapters(session, agent, [work], 'resume');
  const next = chapters.get(work), saved = progress.get(work);
  // Fence the same Person's latest progress without re-reading the chapters.
  // A save racing this request must not produce an already-read resume link.
  const structure = structures.get(work);
  if (structure) {
    const current = (await status.progress(agent, [structure])).get(structure);
    if (JSON.stringify(current) !== JSON.stringify(saved)) throw new WorkReadMoved('Work progress changed');
  }
  if (!await canRead.call(session.deps.access, principal, agent)
    || !await session.deps.access.canReadWork(principal, agent, work)) {
    throw new WorkReadMoved('Reader authority changed');
  }
  return { profile: 'work-resume-v1' as const, work, sourcePosition: session.position,
    lastPosition: saved ? { occurrence: saved.occurrence, position: saved.position,
      completed: saved.completed, updatedAt: saved.changedAt } : null,
    nextUnread: next ? { occurrence: next.occurrence, title: next.title,
      href: `/w/${work.slice(-36)}/read/${next.occurrence.slice(-36)}?language=${encodeURIComponent(next.language)}` } : null,
    unreadCount: next?.unreadCount ?? null };
}
