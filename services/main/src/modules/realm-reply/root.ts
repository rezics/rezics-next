import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { TargetReadSession } from '../target/resolve.ts';
import type { ResolvedTarget } from '../target/contract.ts';
import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { WorkReadMissing } from '../work/read-session.ts';

/** Exact target revision or an unerased published Work draft; no text selection
 * is required for a target's own revision. */
export async function replyRoot(session: TargetReadSession, resource: string, revision: string): Promise<boolean> {
  // Access baseline is imported by summary owners; defer resolver initialization
  // until the capability is used, outside that module cycle.
  const { resolveTargets } = await import('../target/resolve.ts');
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)) return false;
  const [target] = await resolveTargets(session, [resource], 'discussion');
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

export type ReplyRootProof = (resource: string, revision: string) => Promise<boolean>;

/** Reuse a resolved root within one fenced read. The caller re-resolves target
 * authority before returning. At most one extra probe per distinct Work draft,
 * so a full discussion page does not repeat summary/authority reads per reply. */
export function replyRootProof(session: TargetReadSession, target: ResolvedTarget): ReplyRootProof {
  const revisions = new Map<string, Promise<boolean>>();
  return async (resource, revision) => {
    if (resource !== target.resource || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)) return false;
    let result = revisions.get(revision);
    if (!result) {
      result = replyRootRevision(session, target, revision);
      revisions.set(revision, result);
    }
    return result;
  };
}

/** Access keeps its graph-only baseline signature. Restricted roots require
 * authenticated resolution and explicit authority. Two position probes, one
 * summary, one exact revision and at most one Work draft probe; no bodies. */
export async function publicReplyRoot(graph: Pick<FusekiClient, 'query'>,
  resource: string, revision: string): Promise<boolean> {
  const { publicTargetRead, TargetNotBound } = await import('../target/resolve.ts');
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(resource)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)) return false;
  try { return await publicTargetRead(graph, session => replyRoot(session, resource, revision)); }
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
      session => replyRoot(session, resource, revision));
  } catch (error) {
    if (error instanceof WorkReadMissing || error instanceof TargetNotBound) return false;
    throw error;
  }
}
