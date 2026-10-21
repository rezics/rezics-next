import type { VerifiedPrincipal } from '../access/admission.ts';
import { ContextCommandUnavailable } from '../context/problems.ts';
import type { RetainedRelationReadDependencies } from '../relation/retained-change.ts';
import { readRetainedRelationOwner, selectRetainedRelationHead } from '../relation/retained-read.ts';
import { DATASET, GRAPHS, iri, lit } from '../work/activate.ts';
import type { RetainedStatementCoverageReader } from './v2-coverage.ts';

/** Authored Statements can precede public activation. Resolve only the exact
 * credit-owner identity/support; adoption remains its own DecisionSlot command. */
export function retainedStatementCoverageReader(work: RetainedRelationReadDependencies,
  principal: VerifiedPrincipal | null, actingSubject?: string): RetainedStatementCoverageReader {
  return async (occurrence, revision) => {
    if (!await selectRetainedRelationHead(work.environment, occurrence, revision)) return null;
    if (!principal || !actingSubject) throw new ContextCommandUnavailable('retained Statement coverage needs a verified owner reader');
    const exact = await readRetainedRelationOwner(work, principal, actingSubject, occurrence, revision);
    if (!exact || exact.currentAssociationHead !== revision) {
      throw new ContextCommandUnavailable('covered retained credit binding changed');
    }
    // This is a coverage view of existing allocations, not a new occurrence or
    // permission to adopt a replacement binding. The live position guards the
    // original owner/support state atomically with the Statement command.
    const guard = `GRAPH ${iri(GRAPHS.current)} {
        ${iri(occurrence)} rv:associationHead ${iri(revision)} ; rv:work ${iri(exact.state.work)} .
        ${iri(exact.state.work)} a <https://schema.org/CreativeWork> }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RetainedCreditAssociationRevision ;
        rv:component ${iri(occurrence)} ; rv:manifest ${iri(exact.manifest)} }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(exact.receipt)} rv:outcome rv:Succeeded ;
        rv:component ${iri(occurrence)} ; rv:revision ${iri(revision)} ; rv:operation ${iri(exact.operation)} }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(exact.currentPosition.dataEpoch)} ;
        rv:sequence ?retainedCoverageSequence
        FILTER(STR(?retainedCoverageSequence) = ${lit(exact.currentPosition.sequence)})
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }`;
    return { occurrence, revision, definition: exact.definition, guard,
      state: { definition: exact.state.mapping.revision, applicability: [...exact.state.applicability],
        participations: exact.state.participations.map(({ id, ...part }) => ({ ...part, iri: id })) },
      native: { receipt: exact.receipt, manifest: exact.manifest, modelGeneration: exact.modelGeneration,
        attribution: { sourceValidation: exact.sourceValidation, attribution: exact.attribution } } };
  };
}
