import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, readDependencyToken,
  WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readContributionHead } from '../studio/contribution-head.ts';

/** A Work-keyed physical page, followed by exact Access checks. Denied rows
 * consume the window too, so sparse authority never causes an inventory scan. */
export async function readWorkContributions(session: WorkReadSession, work: string) {
  const principal = session.principal, actor = session.options.actingSubject;
  if (!principal || !actor) throw new AccountAssertionDenied('Contribution listing requires authentication');
  // Work visibility admits discovery; it never grants access to a draft.
  const authority = () => session.deps.access.canReadWork(principal, actor, work);
  const visible = await authority();
  session.observeDependency('work-contribution-discovery', visible, authority);
  if (!visible) throw new WorkReadMissing('Work is unavailable');
  const index = session.deps.templateSeek;
  if (!index) throw new WorkReadUnavailable('Contribution directory is unavailable');
  const keys = [{ graph: GRAPHS.current, predicate: `${RV}work`, anchor: work, type: `${RV}TextContribution` }];
  const basis = await session.dependency('work-contributions', () => index.keys(session.position.dataEpoch, keys));
  const position = { ...session.position, dependencyToken: readDependencyToken(basis) };
  const binding = ['work-contributions-v1', work, principal.issuer, principal.subject, actor];
  const cursor = decodeReadCursor(session.options.cursor, binding, position);
  const limit = session.options.limit ?? 20;
  const page = await index.candidates(position.dataEpoch, keys,
    cursor ? { key: cursor.order, id: cursor.after } : null, limit, {}, limit + 1);
  const items = [];
  for (const candidate of page.rows) {
    const authority = () => session.deps.access.canReadContributionDraft(principal, actor, candidate.id);
    const allowed = await authority();
    session.observeDependency(`contribution-authority:${candidate.id}`, allowed, authority);
    if (!allowed) continue;
    const head = await readContributionHead(session.deps.environment, candidate.id);
    session.observeDependency(`contribution-head:${candidate.id}`, head,
      () => readContributionHead(session.deps.environment, candidate.id));
    if (!head || head.work !== work) throw new WorkReadMoved('Contribution directory changed');
    // Protection and erasure must be checked independently of retained grants.
    const live = await session.query(`SELECT ?draft WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(candidate.id)} rv:draftHead ?draft .
      FILTER NOT EXISTS { ${iri(candidate.id)} rv:protectionHead ?protection }
      FILTER NOT EXISTS { ${iri(work)} rv:protectionHead ?workProtection }
    } GRAPH ${iri(GRAPHS.revisions)} { ?draft a rv:RevisionAnchor ; rv:component ${iri(candidate.id)} .
      FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
    ${unerased(iri(work))} } LIMIT 2`, 1);
    if (live.length && live[0]!.draft!.value === head.draftHead) items.push(head);
  }
  const last = page.rows.at(-1);
  return { ...pageResult(session, items, page.more && last
    ? encodeReadCursor(binding, position, last.id, last.key) : null), sourcePosition: position, complete: !page.more };
}
