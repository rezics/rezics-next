import type { Pool } from 'pg';
import { profileValidations } from '../../infrastructure/profile.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { checkMergeAuthority } from '../identity-merge/authority.ts';
import { itemCommandKey, mergeDigest, MergeConflict, MergeUnavailable, type MergeTask } from '../identity-merge/contract.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';

export const mergeIdentityReceiptIri = (task: MergeTask) => `urn:rezics:receipt:identity-merge:${itemCommandKey(task.key,'identity-merge','$stage').slice(6)}`;
export async function readMergeIdentityReceipt(env: WorkActivationEnvironment, task: MergeTask) {
  const receipt = mergeIdentityReceiptIri(task);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ?digest ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  } LIMIT 2`,4096)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || rows[0]?.digest?.value !== mergeDigest(task) || rows[0].epoch?.value !== task.dataEpoch
    || !/^\d+$/.test(rows[0].sequence?.value ?? '')) throw new MergeUnavailable('Identity receipt differs');
  return receipt;
}

/** First ordered owner command. Navigation changes before person-state repair;
 * facts, exact revisions, Main Versions and authority bindings never move. */
export async function commandWorkMerge(env: WorkActivationEnvironment, pool: Pool, task: MergeTask) {
  const existing = await readMergeIdentityReceipt(env,task);
  if (existing) return existing;
  return controlTransaction(pool,async client => {
    await checkMergeAuthority(client,task,env.fuseki,'identity-merge');
    const { source,survivor,operation } = task.plan, receipt = mergeIdentityReceiptIri(task), digest = mergeDigest(task);
    const batch = `urn:rezics:outbox:${hash(receipt)}`,event = `urn:rezics:event:${hash(receipt)}`;
    const validations = await profileValidations(env.fuseki,'work-metadata-v1',[
      { shape: 'https://rezics.com/definition/work-metadata-v1/work-shape',focus: [source.resource],graphs: [GRAPHS.current] },
    ]);
    const edge = `${iri(source.resource)} rv:mergedInto ${iri(survivor.resource)} .`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        ${operation === 'unmerge' ? `GRAPH ${iri(GRAPHS.current)} { ${edge} }` : ''} }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        ${operation === 'merge' ? `GRAPH ${iri(GRAPHS.current)} { ${edge} }` : ''}
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:action "identity.merge" ; rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(task.dataEpoch)} ; rv:sequence ?next ;
          rv:mergeTask ${lit(task.key)} ; rv:editorialApplication ${lit(task.application)} ;
          rv:sourceRevision ${iri(source.revision)} ; rv:survivorRevision ${iri(survivor.revision)} ; rv:sourceWork ${iri(source.resource)} ; rv:survivorWork ${iri(survivor.resource)} ;
          rv:mergeOperation ${lit(operation)} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(task.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} a rv:WorkIdentityChangedEvent ;
          rv:ordinal 0 ; rv:action "identity.merge" ; rv:receipt ${iri(receipt)} . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(task.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(source.resource)} a schema:CreativeWork ; rv:head ${iri(source.revision)} ; rv:mainVersion ?sourceMain .
          ${iri(survivor.resource)} a schema:CreativeWork ; rv:head ${iri(survivor.revision)} ; rv:mainVersion ?survivorMain .
          ${operation === 'merge' ? `FILTER NOT EXISTS { ${iri(source.resource)} rv:mergedInto ?old }
            FILTER NOT EXISTS { ${iri(survivor.resource)} rv:mergedInto ?nextIdentity }
            FILTER NOT EXISTS { ${iri(survivor.resource)} rv:mergedInto+ ${iri(source.resource)} }`
            : edge}
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const result = await env.fuseki.commandWithReceipt({ receipt,digest,update,validations,deadlineMs: 10_000 });
    const committed = await readMergeIdentityReceipt(env,task);
    if (!committed) {
      if (result.status === 'guard-unmatched' || result.status === 'conflict') throw new MergeConflict('Identity heads or resolution changed');
      throw new MergeUnavailable(`Identity command ${result.status}`);
    }
    return committed;
  });
}
