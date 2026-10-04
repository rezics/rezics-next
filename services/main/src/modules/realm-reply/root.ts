import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { TargetReadSession } from '../target/resolve.ts';
import type { ResolvedTarget } from '../target/contract.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadMissing } from '../work/read-session.ts';

/** Exact target revision or an unerased published Work draft; no text selection
 * is required for a target's own revision. */
export async function replyRoot(session: TargetReadSession, resource: string, revision: string,
  contextRevision?: string | null): Promise<boolean> {
  // Access baseline is imported by summary owners; defer resolver initialization
  // until the capability is used, outside that module cycle.
  const { resolveTargets } = await import('../target/resolve.ts');
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)) return false;
  const [target] = await resolveTargets(session, [resource], 'discussion');
  await assertReplyRatingContext(session, target!, contextRevision);
  return replyRootRevision(session, target!, revision);
}

async function replyRootRevision(session: TargetReadSession, target: ResolvedTarget, revision: string) {
  if (target.revision === revision) return true;
  if (target.base !== 'work') return false;
  const rows = await session.query(`SELECT ?decision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ;
      rv:work ${iri(target.resource)} ; rv:publicationHead ?decision }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:PublicationDecision ;
      rv:component ?contribution ; rv:work ${iri(target.resource)} ; rv:disclosure rv:Public ;
      rv:selectedDraft ${iri(revision)} .
      ${iri(revision)} a rv:RevisionAnchor ; rv:component ?contribution .
      FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } }
  } LIMIT 2`, 2);
  return rows.length === 1;
}

/** Retained replies keep their original root after metadata or Structure edits.
 * Current target authority and erasure still govern disclosure and reply edits. */
export async function readReplyRoot(session: TargetReadSession, resource: string, revision: string,
  contextRevision?: string | null): Promise<boolean> {
  const { resolveTargets } = await import('../target/resolve.ts');
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)) return false;
  const [target] = await resolveTargets(session, [resource], 'discussion');
  await assertReplyRatingContext(session, target!, contextRevision);
  // A projection is immutable and has exactly its own revision as a root.
  // An arbitrary retained revision must not become a discussion of it.
  if (target!.base === 'projection') return target!.revision === revision;
  const rows = await session.query(`SELECT ?root WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { BIND(${iri(revision)} AS ?root)
      ?root ?predicate ?object . FILTER NOT EXISTS { ?root a rv:ErasedRevision } }
  } LIMIT 1`, 1);
  return rows.length === 1;
}

/** Replies may pin a semantic Context or a rating question. Only a revision
 * authored by the rating owner invokes question acceptance; unscoped replies
 * keep their ordinary exact-resource root. */
async function assertReplyRatingContext(session: TargetReadSession, target: ResolvedTarget,
  revision?: string | null) {
  if (!revision) return;
  const { TARGET_CONTEXT_PROFILES, targetContextPattern, assertRatingContextTarget } = await import('../rating/target.ts');
  const rows = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(revision)} a rv:RevisionAnchor ; rv:component ?context ; rv:modelRevision ?profile .
    VALUES ?profile { ${TARGET_CONTEXT_PROFILES.map(iri).join(' ')} }
  } } LIMIT 2`, 2);
  if (!rows.length) return;
  if (rows.length !== 1 || !rows[0]?.context) throw new WorkReadMissing('Reply question is unavailable');
  const context = rows[0].context.value;
  await assertRatingContextTarget(session, context, target);
  const live = await session.query(`SELECT ?realm WHERE {
    ${targetContextPattern(context, '?realm', iri(revision))}
  } LIMIT 2`, 2);
  if (live.length !== 1) throw new WorkReadMissing('Reply question is unavailable');
}

/** Access keeps its graph-only baseline signature. Restricted roots require
 * authenticated resolution and explicit authority. Two position probes, one
 * summary, one exact target revision and one retained-root probe, plus at most
 * nine Access-owned semantic part decisions supplied by the caller; no bodies. */
export async function publicReplyRoot(graph: Pick<FusekiClient, 'query'>,
  resource: string, revision: string, access?: TargetReadSession['deps']['access']): Promise<boolean> {
  const { publicTargetRead, TargetNotBound } = await import('../target/resolve.ts');
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(resource)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)) return false;
  try { return await publicTargetRead(graph, session => {
    session.deps.access = access;
    return readReplyRoot(session, resource, revision);
  }); }
  catch (error) {
    if (error instanceof WorkReadMissing || error instanceof TargetNotBound) return false;
    throw error;
  }
}

export async function readableReplyRoot(environment: WorkActivationEnvironment,
  resource: string, revision: string, access?: TargetReadSession['deps']['access'],
  principal: TargetReadSession['principal'] = null, actingSubject?: string): Promise<boolean> {
  const { targetRead, TargetNotBound } = await import('../target/resolve.ts');
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (!native.test(resource) || !native.test(revision)) return false;
  try {
    return await targetRead(environment, { access, principal, actingSubject },
      session => readReplyRoot(session, resource, revision));
  } catch (error) {
    if (error instanceof WorkReadMissing || error instanceof TargetNotBound) return false;
    throw error;
  }
}
