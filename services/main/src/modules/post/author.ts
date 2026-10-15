import type { DocumentSnapshot } from '@rezics/document';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, prepareComponent, PendingActivation } from '../work/activate.ts';
import { readWorkTerminalReceipt, workReceiptIri } from '../work/receipt.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { derivedId } from '../structure/graph.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { saveAdmittedContentDraft } from '../content-publication/draft.ts';
import { authoredDocumentBody } from '../../../../content/src/document-body.ts';

/** Native Post custody uses the same admitted creator/maintainer proof as placed Posts. */
export async function authorPost(deps: MainWorkDependencies, request: Request, input: {
  title: { value: string; language: string }; language: string; document: DocumentSnapshot; actingSubject: string;
}, key: string) {
  if (!deps.contentAuthoring) throw new PendingActivation('Content authoring is unavailable');
  const body = authoredDocumentBody({ document: input.document }, 262_144);
  const digest = hash(JSON.stringify({ family: 'authored-post-v1', ...input, document: body.document }));
  await assertGraphAdmissionOpen(deps.environment.fuseki, deps.environment.lineage);
  const principal = await deps.account.verify(request, ['work:create', 'work:edit']);
  const admission = await deps.access.register({ principal, actingSubject: input.actingSubject,
    action: 'work.create', scope: 'work:create:root', idempotencyKey: key, requestDigest: digest });
  const env = deps.environment;
  let terminal = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (!terminal) {
    await deps.access.claim(admission.id, digest, principal);
    const post = derivedId(`${admission.id}\0post`), revision = derivedId(`${admission.id}\0post-head`);
    const receipt = workReceiptIri(admission.id), operation = `urn:rezics:operation:${hash(admission.id)}`;
    const manifest = prepareComponent(env.objectDirectory, post,
      { publisher: input.actingSubject, labels: [input.title] }, 'https://rezics.com/definition/post-v1');
    const validations = await profileValidations(env.fuseki, 'post-v1', [
      { shape: 'https://rezics.com/definition/post-v1/post-shape', focus: [post], graphs: [GRAPHS.current] },
    ], { post, publisher: input.actingSubject, revision });
    await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${iri(post)} a rv:Post ; rv:publisher ${iri(input.actingSubject)} ;
            rdfs:label ${lit(input.title.value)}@${input.title.language} ; rv:head ${iri(revision)} . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(post)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
            rv:modelRevision <https://rezics.com/definition/post-v1> ; rv:shapeRevision <https://rezics.com/definition/post-v1> ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
            rv:action "work.create" ; rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
            rv:admittedScope ${lit(admission.scope)} ; rv:requestDigest ${lit(digest)} ;
            rv:work ${iri(post)} ; rv:mainVersion ${iri(post)} ; rv:workRevision ${iri(revision)} ; rv:mainRevision ${iri(revision)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
        } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n .
            FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(post)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`,
    }, admission);
    terminal = await readWorkTerminalReceipt(env.fuseki, admission.id);
  }
  if (!terminal || terminal.outcome !== 'succeeded') throw new PendingActivation('Post custody is not settled');
  await deps.access.recordGraphOutcome(admission.id, terminal);
  const post = terminal.work!, variantId = `urn:rezics:variant:${derivedId(`${admission.id}\0post-variant`).slice('https://rezics.com/id/'.length)}`;
  const saved = await saveAdmittedContentDraft(env, deps.contentAuthoring, deps.account, deps.access, request, {
    resourceId: post, variant: { id: variantId, resourceId: post,
      language: { kind: 'tag', tag: input.language, originalTag: input.language }, direction: 'ltr' },
    expectedHead: null, document: body.document, actingSubject: input.actingSubject,
    idempotencyKey: `authored-post-draft:${admission.id}`,
  });
  return { post, variantId, revisionId: saved.revisionId, byteDigest: saved.byteDigest,
    author: input.actingSubject, replayed: admission.replayed && saved.replayed };
}
