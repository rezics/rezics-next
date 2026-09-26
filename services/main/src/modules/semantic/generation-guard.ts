import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import { MODEL_COMPONENT, PROFILES } from './schema.ts';

export interface ActiveModelGeneration {
  generation: string;
  manifest: string;
  generationNumber: string;
  predecessor: string | null;
  entailmentProfile: 'NoEntailment';
  receipt: string;
}

export class ModelGenerationUnavailable extends Error {}
export class ModelGenerationChanged extends Error {}

/**
 * Main's active generation is the exact immutable revision named by the guarded
 * ModelComponent head, admitted by semantic-model-generation-v1, and committed
 * with its succeeded graph receipt. Two bounded indexed graph lookups; no
 * corpus/history scan or fixture-local object-store dependency.
 */
export async function readActiveModelGeneration(fuseki: FusekiClient): Promise<ActiveModelGeneration> {
  const head = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} a rv:ModelComponent ; rv:generationHead ?generation }
  } LIMIT 2`);
  const rows = head.results?.bindings ?? [];
  const generation = rows[0]?.generation?.value;
  if (rows.length !== 1 || !generation || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(generation)) {
    throw new ModelGenerationUnavailable('active model generation head is missing or ambiguous');
  }
  const receipt = `urn:rezics:receipt:${hash(`${generation}\0model-generation`)}`;
  const expectedDigest = hash(JSON.stringify({ family: 'model-generation-v1',
    manifest: generation.slice('urn:rezics:model-generation:'.length) }));
  const exact = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?number ?predecessor ?entailment ?digest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} a rv:ModelGeneration, rv:RevisionAnchor ;
      rv:component ${iri(MODEL_COMPONENT)} ; rv:manifest ?manifest ; rv:generationNumber ?number ;
      rv:entailmentProfile ?entailment ; rv:identityInference rv:Excluded ;
      rv:validationPosture rv:RejectOnViolation ; rv:modelRevision ${iri(PROFILES.generation)} ;
      rv:shapeRevision ${iri(PROFILES.generation)} ; rv:operation ?operation ;
      rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(generation)} rv:predecessor ?predecessor } }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:operation ?operation ;
      rv:requestDigest ?digest ; rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  } LIMIT 2`);
  const revisions = exact.results?.bindings ?? [];
  const row = revisions[0];
  const manifest = row?.manifest?.value;
  const generationNumber = row?.number?.value;
  const predecessor = row?.predecessor?.value ?? null;
  if (revisions.length !== 1 || !manifest || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest)
    || !generationNumber || !/^[1-9][0-9]*$/.test(generationNumber)
    || row?.entailment?.value !== `${RV}NoEntailment`
    || row?.digest?.value !== expectedDigest
    || (predecessor !== null && !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(predecessor))) {
    throw new ModelGenerationUnavailable('active model generation lacks its exact profile revision and receipt');
  }
  return { generation, manifest, generationNumber, predecessor, entailmentProfile: 'NoEntailment', receipt };
}

/** Include this binding in the same TDB2 update WHERE as every prepared write. */
export function modelGenerationHeadGuard(generation: string): string {
  if (!/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(generation)) {
    throw new ModelGenerationUnavailable('model generation is not an exact generation revision');
  }
  const receipt = `urn:rezics:receipt:${hash(`${generation}\0model-generation`)}`;
  return `GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} a rv:ModelGeneration, rv:RevisionAnchor ;
      rv:component ${iri(MODEL_COMPONENT)} ; rv:entailmentProfile rv:NoEntailment ;
      rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
      rv:modelRevision ${iri(PROFILES.generation)} ; rv:shapeRevision ${iri(PROFILES.generation)} ;
      rv:operation ?modelGenerationOperation ; rv:dataEpoch ?modelGenerationEpoch ;
      rv:sequence ?modelGenerationSequence }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:operation ?modelGenerationOperation ; rv:outcome rv:Succeeded ;
      rv:dataEpoch ?modelGenerationEpoch ; rv:sequence ?modelGenerationSequence }
    GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(generation)} }`;
}

/** Reject a staged/prepared operation when the current head no longer names its basis. */
export async function assertModelGenerationCurrent(fuseki: FusekiClient, expected: string): Promise<void> {
  const active = await readActiveModelGeneration(fuseki);
  if (active.generation !== expected) throw new ModelGenerationChanged('model generation changed after preparation');
}
