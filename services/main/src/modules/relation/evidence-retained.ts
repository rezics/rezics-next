import { readRetainedCreditAssociationHead, readSealedRetainedCreditAssociation,
  RetainedCreditReadMoved, RetainedCreditReadUnavailable } from '../work/credit-association-read.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readRetainedRelationOwner, selectRetainedRelationHead, type RetainedRelationOwner } from './retained-read.ts';

export interface RetainedAssociationEvidenceOccurrence extends RetainedRelationOwner {
  kind: 'retained-credit';
}

/** Resolve the original credit and exact sealed compatibility head. This is
 * public-read admission, not the draft identity reader used to author coverage.
 * The independently adopted occurrence assertion is still required by the caller. */
export async function readRetainedAssociationEvidenceOccurrence(session: WorkReadSession,
  occurrence: string, revision: string): Promise<RetainedAssociationEvidenceOccurrence | null> {
  const work = session.deps, env = work.environment;
  try {
    if (!await selectRetainedRelationHead(env, occurrence, revision)) return null;
    const sealed = await readSealedRetainedCreditAssociation(env, occurrence, revision);
    const targets = [occurrence, revision, sealed.state.work];
    if ((await session.disclosure(targets.map(resource => ({ owner: 'graph', resource, component: 'record' }))))
      .some(value => value !== 'visible')) throw new WorkReadMissing('Association is unavailable');
    const { principal } = session, { actingSubject } = session.options;
    if (!principal || !actingSubject) {
      // This legacy owner currently has no anonymous read entry point. A saved
      // import principal or source custodian cannot stand in for the visitor.
      throw new WorkReadUnavailable('Retained association reader is unavailable');
    }
    const canRead = () => work.access.canReadWork(principal, actingSubject, sealed.state.work);
    const allowed = await canRead();
    session.observeDependency(`association-evidence-work:${sealed.state.work}`, allowed, canRead);
    if (!allowed) throw new WorkReadMissing('Association is unavailable');
    const currentHead = await readRetainedCreditAssociationHead(env, occurrence, sealed.state.work);
    if (currentHead !== revision) {
      if (currentHead && session.options.cursor) throw new WorkReadMoved('Retained association head changed');
      throw new WorkReadMissing('Association is unavailable');
    }
    const check = async () => {
      const owned = await readRetainedRelationOwner(work, principal, actingSubject, occurrence, revision, true);
      if (!owned) throw new WorkReadMissing('Association is unavailable');
      if (owned.currentAssociationHead !== revision || owned.currentPosition.dataEpoch !== session.position.dataEpoch
        || owned.currentPosition.sequence !== session.position.sequence) throw new WorkReadMoved('Retained association basis changed');
      return { ...owned, kind: 'retained-credit' as const };
    };
    const owned = await check();
    session.observeDependency(`association-evidence-retained:${occurrence}:${revision}`, owned, async () => {
      try { return await check(); }
      catch (error) {
        if (error instanceof RetainedCreditReadUnavailable || error instanceof RetainedCreditReadMoved || error instanceof WorkReadMissing) {
          throw new WorkReadMoved('Retained association support or disclosure changed');
        }
        throw error;
      }
    });
    return owned;
  } catch (error) {
    if (error instanceof RetainedCreditReadMoved) throw new WorkReadMoved('Retained association changed');
    if (error instanceof RetainedCreditReadUnavailable) throw new WorkReadUnavailable('Retained association owner is unavailable');
    throw error;
  }
}
