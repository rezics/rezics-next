import { familyReceiptIri, readSemanticTerminal, SemanticTargetUnavailable } from '../semantic/command.ts';
import { semanticValueRdf } from '../semantic/value.ts';
import { term } from '../context/command.ts';
import { GRAPHS, RV, iri, lit, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { readExactOccurrence, RELATION_CHANGE_FAMILY, type ExactDefinition } from './change.ts';
import { canonicalAttribution, checkedParticipationsV2, RELATION_V2_PROFILE } from './v2-schema.ts';
import type { RelationAttributionVerifier } from './attribution.ts';

/** Recover exact allocations and the actual original command receipt, never an occurrence/revision ID relabelled as one. */
export async function readAttributedOccurrence(env: WorkActivationEnvironment, occurrence: string, revision: string) {
  const read = await readExactOccurrence(env, occurrence, revision);
  if (!read) throw new SemanticTargetUnavailable('relation occurrence is unavailable');
  if (read.state.profile !== 'relation-change-v2') throw new SemanticTargetUnavailable('authored relation occurrence is unavailable');
  if (!read.modelGeneration || !read.operation || !read.manifest) throw new PendingActivation('exact occurrence revision owner metadata is unavailable');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?admission WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:component ${iri(occurrence)} ; rv:revision ${iri(revision)} ; rv:operation ${iri(read.operation)} ;
      rv:dataEpoch ${lit(read.sourcePosition.dataEpoch)} ; rv:sequence ${read.sourcePosition.sequence} ; rv:admissionId ?admission }
  } LIMIT 2`)).results?.bindings ?? [];
  const receipt = rows[0]?.receipt?.value, admission = rows[0]?.admission?.value;
  if (rows.length !== 1 || !receipt || !admission || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admission)
    || receipt !== familyReceiptIri(admission, RELATION_CHANGE_FAMILY)) throw new PendingActivation('exact relation command receipt is unavailable');
  const terminal = await readSemanticTerminal(env, receipt);
  if (!terminal || terminal.outcome !== 'succeeded' || terminal.component !== occurrence || terminal.revision !== revision
    || (terminal.expectedHead ?? null) !== read.predecessor || terminal.dataEpoch !== read.sourcePosition.dataEpoch
    || terminal.sequence !== read.sourcePosition.sequence) throw new PendingActivation('relation receipt differs from its sealed revision');
  const proofs = read.state.attributionProofs;
  const expectedSupports = read.state.participations.flatMap(participation => (participation.attributionSupports ?? [])
    .map(support => ({ participation: participation.iri, support })));
  if (!Array.isArray(proofs) || proofs.length !== expectedSupports.length
    || expectedSupports.some(({ participation, support }, index) => proofs[index]?.participation !== participation
      || canonicalAttribution(proofs[index]?.proof.basis) !== canonicalAttribution(support.basis)
      || canonicalAttribution(proofs[index]?.proof.evidence) !== canonicalAttribution(support.evidence))) {
    throw new PendingActivation('sealed participation attribution map is unavailable');
  }
  const triples: string[] = [];
  for (const item of read.state.participations) {
    const value = semanticValueRdf(item.participant, () => {
      if (!item.node) throw new PendingActivation('exact external participation node is unavailable');
      return item.node;
    });
    const pairs = [
      ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', term(`${RV}RelationParticipation`)],
      [`${RV}modelRevision`, iri(RELATION_V2_PROFILE)], [`${RV}occurrence`, iri(occurrence)],
      [`${RV}role`, term(item.role)], [`${RV}participant`, value.object],
      [`${RV}attributionSupports`, lit(canonicalAttribution(item.attributionSupports ?? []))],
      ...(item.position === undefined ? [] : [['https://schema.org/position', String(item.position)]]),
      ...(item.creditedName ? [[`${RV}creditedName`, semanticValueRdf({ kind: 'language-string', ...item.creditedName }, () => '').object]] : []),
      ...(item.sourceIdentity ? [[`${RV}sourceIdentity`, lit(canonicalAttribution(item.sourceIdentity))]] : []),
    ];
    triples.push(...pairs.map(([predicate, object]) => `${iri(item.iri)} ${term(predicate!)} ${object} .`),
      ...(value.node?.triples.map(triple => `${triple} .`) ?? []));
    triples.push(`FILTER NOT EXISTS { ${iri(item.iri)} ?p ?o . FILTER NOT EXISTS {
      VALUES (?expectedP ?expectedO) { ${pairs.map(([predicate, object]) => `(${term(predicate!)} ${object})`).join(' ')} }
      FILTER(?p = ?expectedP && sameTerm(?o, ?expectedO)) } }`);
    if (value.node && item.participant.kind === 'external') {
      const external = [
        ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', term(`${RV}ExternalReference`)],
        [`${RV}externalProvider`, lit(item.participant.provider)],
        [`${RV}externalNamespace`, lit(item.participant.namespace)],
        [`${RV}externalKey`, lit(item.participant.key)],
      ];
      triples.push(`FILTER NOT EXISTS { ${iri(item.node!)} ?externalP ?externalO . FILTER NOT EXISTS {
        VALUES (?expectedExternalP ?expectedExternalO) { ${external.map(([p, o]) => `(${term(p!)} ${o})`).join(' ')} }
        FILTER(?externalP = ?expectedExternalP && sameTerm(?externalO, ?expectedExternalO)) } }`);
    }
  }
  const revisionPairs = [
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', term(`${RV}RelationOccurrenceRevision`)],
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', term(`${RV}RevisionAnchor`)],
    [`${RV}component`, iri(occurrence)], [`${RV}modelRevision`, iri(RELATION_V2_PROFILE)],
    [`${RV}shapeRevision`, iri(RELATION_V2_PROFILE)], [`${RV}modelGeneration`, iri(read.modelGeneration)],
    [`${RV}manifest`, iri(read.manifest)], [`${RV}operation`, iri(read.operation)],
    [`${RV}datasetId`, '<urn:rezics:dataset:product>'], [`${RV}dataEpoch`, lit(read.sourcePosition.dataEpoch)],
    [`${RV}sequence`, read.sourcePosition.sequence], [`${RV}relationDefinition`, iri(read.state.definition)],
    [`${RV}lifecycle`, term(`${RV}${read.state.lifecycle === 'active' ? 'Active' : 'Retired'}`)],
    [`${RV}participantCount`, String(read.state.participations.length)],
    [`${RV}attributionProofs`, lit(canonicalAttribution(proofs))],
    ...(read.predecessor ? [[`${RV}predecessor`, iri(read.predecessor)]] : []),
    ...read.state.participations.map(item => [`${RV}participation`, iri(item.iri)]),
  ];
  triples.push(...revisionPairs.map(([p, o]) => `${iri(revision)} ${term(p!)} ${o} .`),
    `FILTER NOT EXISTS { ${iri(revision)} ?p ?o . FILTER NOT EXISTS {
      VALUES (?expectedP ?expectedO) { ${revisionPairs.map(([p, o]) => `(${term(p!)} ${o})`).join(' ')} }
      FILTER(?p = ?expectedP && sameTerm(?o, ?expectedO)) } }`);
  const verified = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(revision)} rv:component ${iri(occurrence)} ; rv:modelRevision ${iri(RELATION_V2_PROFILE)} ;
      rv:shapeRevision ${iri(RELATION_V2_PROFILE)} ; rv:modelGeneration ${iri(read.modelGeneration)} ;
      rv:participantCount ${read.state.participations.length} ; rv:relationDefinition ${iri(read.state.definition)} ;
      rv:attributionProofs ${lit(canonicalAttribution(proofs))} ;
      rv:lifecycle ${term(`${RV}${read.state.lifecycle === 'active' ? 'Active' : 'Retired'}`)} .
    ${read.state.participations.map(item => `${iri(revision)} rv:participation ${iri(item.iri)} .`).join('\n')}
    FILTER NOT EXISTS { ${iri(revision)} rv:participation ?extra FILTER(?extra NOT IN (${read.state.participations.map(item => iri(item.iri)).join(', ')})) }
    ${triples.join('\n')}
    ${iri(read.modelGeneration)} a rv:ModelGeneration .
  } }`);
  if (verified.boolean !== true) throw new PendingActivation('relation revision children differ from their exact immutable manifest');
  return { ...read, manifest: read.manifest, modelGeneration: read.modelGeneration, operation: read.operation, receipt };
}

/** Exact definition, field, citation and correspondence verification before every V2 field emission. */
export async function validateAttributedOccurrence(env: WorkActivationEnvironment,
  read: Awaited<ReturnType<typeof readAttributedOccurrence>>, definition: ExactDefinition,
  attribution: RelationAttributionVerifier) {
  if (read.state.definition !== definition.revision) throw new PendingActivation('relation definition differs from its sealed revision');
  const parts = read.state.participations.map(({ iri: _iri, node: _node, ...item }) => item);
  const checked = checkedParticipationsV2(definition.roles, parts);
  if (canonicalAttribution(checked) !== canonicalAttribution(parts)) throw new PendingActivation('relation allocations differ from the exact definition');
  const verified = await attribution(definition, checked);
  const retained = (proof: typeof verified.proofs[number] | undefined) => {
    if (!proof) return null;
    const { validationToken: _token, ...value } = proof;
    return value;
  };
  if (verified.proofs.some((proof, index) => canonicalAttribution(retained(proof))
    !== canonicalAttribution(retained(read.state.attributionProofs![index]?.proof)))) {
    throw new PendingActivation('current attribution no longer names the sealed source revision and command receipt');
  }
  return verified;
}
