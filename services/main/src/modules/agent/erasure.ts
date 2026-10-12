import type { Pool } from 'pg';
import type { FusekiClient, CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { withPersonProfileErasureAuthority, type EndedPersonProvision,
  type PersonProfileErasureProof } from '../access/person-profile-erasure.ts';
import { readComponentState, type RevisionReadBudget } from '../work/history.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type GraphLineage } from '../work/activate.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PERSON = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^urn:rezics:sha256:[0-9a-f]{64}$/;
const PUBLIC = 'urn:rezics:search:public';
const PRIVATE = 'urn:rezics:search:private';
const PROFILE = 'https://rezics.com/definition/agent-erasure-v1';
const PROVISION_PROFILE = 'https://rezics.com/definition/agent-provision-v1';
const PROFILE_PREDICATES = [
  'http://www.w3.org/2000/01/rdf-schema#label',
  'https://schema.org/name', 'https://schema.org/alternateName',
  'http://www.w3.org/2004/02/skos/core#prefLabel', 'http://www.w3.org/2004/02/skos/core#altLabel',
  ...['profileBio', 'profileAvatarSelection', 'profileHandle', 'localizedName',
    'originalNameLanguage', 'profileNameFormat', 'profileStateFormat', 'profileDisclosure',
    'head', 'publicProfileHead'].map(name => `${RV}${name}`),
] as const;

export class PersonGraphErasureConflict extends Error {}
export class PersonGraphErasureUnavailable extends Error {}

/** The caller supplies the same counters to every owner in its complete closure. */
export interface PersonProfileInventoryBudget extends RevisionReadBudget {
  graphRevisionsLeft: number;
  indexedUnitsLeft: number;
  journalTargetsLeft: number;
}
export interface PersonProfileRevision {
  revision: string;
  manifest: string | null;
}
export interface PersonProfileIndexUnit {
  graph: typeof PUBLIC | typeof PRIVATE;
  unit: string;
}
export interface PersonProfileGraphInventory {
  person: string;
  provisionId: string;
  head: string;
  profileHead: string | null;
  revisions: PersonProfileRevision[];
  objects: string[];
  units: PersonProfileIndexUnit[];
  /** Work text units and prefix-directory entries are refreshed, never erased. */
  authorUnits: string[];
}

function consume(budget: PersonProfileInventoryBudget, key: keyof Pick<PersonProfileInventoryBudget,
  'graphRevisionsLeft' | 'indexedUnitsLeft' | 'journalTargetsLeft' | 'bytesLeft'>, count: number): void {
  budget.signal.throwIfAborted();
  if (!Number.isSafeInteger(budget[key]) || budget[key] < count) {
    throw new PersonGraphErasureUnavailable(`Person profile closure exceeds shared ${key}`);
  }
  budget[key] -= count;
}

type QueryClient = Pick<FusekiClient, 'query'>;
type Binding = { type: string; value: string };
function uri(value: Binding | undefined): string | null {
  return value?.type === 'uri' ? value.value : null;
}
function anchor(person: EndedPersonProvision): string {
  return `https://rezics.com/id/${person.provisionId}-agent-revision`;
}
function checkedPerson(person: Pick<EndedPersonProvision, 'person' | 'provisionId'>): void {
  if (!PERSON.test(person.person) || !UUID.test(person.provisionId)) {
    throw new PersonGraphErasureConflict('invalid retained Person identity');
  }
}

/** Indexed component inventory, with one lookahead; never treats a Person head as a revision. */
export async function inventoryPersonProfileGraph(fuseki: QueryClient, objectDirectory: string,
  person: EndedPersonProvision, budget: PersonProfileInventoryBudget): Promise<PersonProfileGraphInventory> {
  checkedPerson(person);
  const current = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind ?head ?profileHead WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(person.person)} a rv:Agent ; rv:agentKind ?kind ; rv:head ?head .
      OPTIONAL { ${iri(person.person)} rv:publicProfileHead ?profileHead }
      FILTER NOT EXISTS { ${iri(person.person)} a rv:AgentTombstone }
      FILTER NOT EXISTS { ${iri(person.person)} rv:protectionHead ?hold }
    }
  } LIMIT 2`, 8192);
  consume(budget, 'bytesLeft', Buffer.byteLength(JSON.stringify(current)));
  const row = current.results?.bindings;
  const head = uri(row?.[0]?.head);
  const profileHead = uri(row?.[0]?.profileHead);
  if (row?.length !== 1 || uri(row[0]?.kind) !== `${RV}PersonAgent` || !head
    || (row[0]?.profileHead !== undefined && !profileHead)) {
    throw new PersonGraphErasureUnavailable('Person current head is absent, held or ambiguous');
  }
  const currentFields = await fuseki.query(`SELECT ?p ?o WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(person.person)} ?p ?o }
  } LIMIT 65`, 65_536);
  consume(budget, 'bytesLeft', Buffer.byteLength(JSON.stringify(currentFields)));
  const fields = currentFields.results?.bindings;
  if (!fields?.length || fields.length > 64 || fields.some(field => {
    const predicate = uri(field.p);
    if (predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') return uri(field.o) !== `${RV}Agent`;
    if (predicate === `${RV}agentKind`) return uri(field.o) !== `${RV}PersonAgent`;
    return !PROFILE_PREDICATES.includes(predicate as typeof PROFILE_PREDICATES[number]);
  })) throw new PersonGraphErasureUnavailable('Person current footprint is unsupported or oversized');
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?revision ?model ?operation ?manifest ?profile ?anchor ?otherOwner WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ${iri(person.person)} .
      OPTIONAL { ?revision rv:modelRevision ?model }
      OPTIONAL { ?revision rv:operation ?operation }
      OPTIONAL { ?revision rv:manifest ?manifest }
      OPTIONAL { ?revision rv:component ?otherOwner FILTER(?otherOwner != ${iri(person.person)}) }
      BIND(EXISTS { ?revision a rv:AgentPublicProfileRevision } AS ?profile)
      BIND(EXISTS { ?revision a rv:RevisionAnchor } AS ?anchor)
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision }
    }
  } ORDER BY ?revision LIMIT ${Math.min(64, budget.graphRevisionsLeft) + 1}`, 1_048_576);
  consume(budget, 'bytesLeft', Buffer.byteLength(JSON.stringify(result)));
  const rows = result.results?.bindings;
  if (!rows || !rows.length || rows.length > Math.min(64, budget.graphRevisionsLeft)) {
    throw new PersonGraphErasureUnavailable('Person revision inventory exceeds its shared bound or is absent');
  }
  const revisions: PersonProfileRevision[] = [];
  const manifests = new Set<string>();
  for (const revisionRow of rows) {
    const revision = uri(revisionRow.revision);
    const manifest = uri(revisionRow.manifest);
    const provision = revision === anchor(person);
    if (!revision || revisionRow.anchor?.value !== 'true' || revisionRow.otherOwner
      || (!PERSON.test(revision) && !provision)
      || (provision ? uri(revisionRow.model) !== PROVISION_PROFILE
        || uri(revisionRow.operation) !== `urn:rezics:operation:agent-provision:${person.provisionId}`
        || !manifest : revisionRow.profile?.type !== 'literal' || revisionRow.profile.value !== 'true'
        || !uri(revisionRow.operation)?.startsWith('urn:rezics:operation:agent-profile:')
        || !['agent-profile-address-v1', 'agent-profile-v1', 'agent-profile-v2']
          .map(model => `https://rezics.com/definition/${model}`).includes(uri(revisionRow.model) ?? ''))
      || revisionRow.manifest !== undefined && (!manifest || !SHA.test(manifest))
      || revisions.some(value => value.revision === revision)) {
      throw new PersonGraphErasureUnavailable('Person revision kind, owner or provisioning anchor differs');
    }
    revisions.push({ revision, manifest });
    if (manifest) manifests.add(manifest);
  }
  if (!revisions.some(value => value.revision === head)
    || profileHead && !revisions.some(value => value.revision === profileHead)) {
    throw new PersonGraphErasureUnavailable('Person head is outside its retained profile revisions');
  }
  consume(budget, 'graphRevisionsLeft', revisions.length);

  const objects = new Set<string>();
  for (const manifest of manifests) {
    const references = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?component WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:manifest ${iri(manifest)} ; rv:component ?component . }
    } LIMIT 65`, 65_536);
    consume(budget, 'bytesLeft', Buffer.byteLength(JSON.stringify(references)));
    if (!references.results?.bindings.length || references.results.bindings.length > 64
      || references.results.bindings.some(reference => uri(reference.component) !== person.person
        || !revisions.some(value => value.revision === uri(reference.revision) && value.manifest === manifest))) {
      throw new PersonGraphErasureUnavailable('Person component object is shared outside its exact closure');
    }
    const captured: string[] = [];
    let state: Record<string, unknown>;
    try {
      state = readComponentState(objectDirectory, manifest, person.person, PROVISION_PROFILE,
        budget, digest => captured.push(digest));
    } catch {
      throw new PersonGraphErasureUnavailable('Person component manifest or payload is unavailable');
    }
    if (state.kind !== 'person' || typeof state.displayName !== 'string'
      || state.disclosure !== 'public'
      || Object.keys(state).sort().join(',') !== 'disclosure,displayName,kind'
      || captured.length !== 2 || captured[0] !== manifest.slice(-64)) {
      throw new PersonGraphErasureUnavailable('Person component payload is not its provisioning profile');
    }
    for (const digest of captured) objects.add(`sha256:${digest}`);
  }

  const indexed = await fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?graph ?unit WHERE {
    VALUES ?graph { ${iri(PUBLIC)} ${iri(PRIVATE)} }
    VALUES ?target { ${[person.person, ...revisions.map(value => value.revision)].map(iri).join(' ')} }
    VALUES ?reference { rv:revision rv:contentRevision rv:resource rv:nameResource rv:nameDirectoryResource }
    GRAPH ?graph { ?unit ?reference ?target }
  } ORDER BY ?graph ?unit LIMIT ${Math.min(64, budget.indexedUnitsLeft) + 1}`, 65_536);
  consume(budget, 'bytesLeft', Buffer.byteLength(JSON.stringify(indexed)));
  const indexedRows = indexed.results?.bindings;
  if (!indexedRows || indexedRows.length > Math.min(64, budget.indexedUnitsLeft)) {
    throw new PersonGraphErasureUnavailable('Person search units exceed their shared bound');
  }
  const units = indexedRows.map(value => ({ graph: uri(value.graph) as PersonProfileIndexUnit['graph'],
    unit: uri(value.unit) ?? '' }));
  if (units.some(value => ![PUBLIC, PRIVATE].includes(value.graph)
    || !/^(?:urn:rezics:[A-Za-z0-9:._-]+|https:\/\/rezics\.com\/id\/[0-9a-f-]+)$/.test(value.unit))) {
    throw new PersonGraphErasureUnavailable('Person search-unit inventory differs');
  }
  consume(budget, 'indexedUnitsLeft', units.length);
  const authors = await fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?unit WHERE {
    { { GRAPH ${iri(GRAPHS.current)} { ?credit rv:agent ${iri(person.person)} ; rv:work ?work } }
      UNION { GRAPH <urn:rezics:projection:public-name-repair> { ${iri(person.person)} rv:prefixOwnerWork ?work } } }
    {
    {
      GRAPH ${iri(PUBLIC)} { ?entry rv:prefixWork ?work ; rv:prefixUnit ?matchUnit }
      { BIND(?entry AS ?unit) } UNION { BIND(?matchUnit AS ?unit) }
    } UNION {
      GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:matchUnit ?unit }
    }
    }
  } ORDER BY ?unit LIMIT ${Math.min(64, budget.indexedUnitsLeft) + 1}`, 65_536);
  consume(budget, 'bytesLeft', Buffer.byteLength(JSON.stringify(authors)));
  const authorRows = authors.results?.bindings;
  if (!authorRows || authorRows.length > Math.min(64, budget.indexedUnitsLeft)) {
    throw new PersonGraphErasureUnavailable('Person credited-Work projections exceed their shared bound');
  }
  const authorUnits = authorRows.map(value => uri(value.unit) ?? '');
  for (const unit of authorUnits) {
    // Prefix scopes contain base64, '*', and language separators.
    if (!PERSON.test(unit) && !/^urn:rezics:search:directory:prefix:[A-Za-z0-9_:*-]+$/.test(unit)) {
      throw new PersonGraphErasureUnavailable('Person credited-Work projection identity differs');
    }
  }
  consume(budget, 'indexedUnitsLeft', authorUnits.length);
  consume(budget, 'journalTargetsLeft', 1 + revisions.length + objects.size);
  return { person: person.person, provisionId: person.provisionId, head, profileHead,
    revisions, objects: [...objects].sort(), units, authorUnits };
}

function identity(proof: PersonProfileErasureProof, inventory: PersonProfileGraphInventory): void {
  checkedPerson(inventory);
  if (proof.person !== inventory.person || proof.provisionId !== inventory.provisionId
    || !UUID.test(proof.erasureId) || !UUID.test(proof.accountErasureId)
    || !/^[1-9][0-9]{0,18}$/.test(proof.erasureEpoch)
    || BigInt(proof.erasureEpoch) > 9223372036854775807n || !inventory.revisions.length
    || inventory.revisions.length > 64 || inventory.units.length + inventory.authorUnits.length > 64
    || !inventory.revisions.some(value => value.revision === inventory.head)
    || inventory.profileHead !== null && !inventory.revisions.some(value => value.revision === inventory.profileHead)
    || new Set(inventory.revisions.map(value => value.revision)).size !== inventory.revisions.length) {
    throw new PersonGraphErasureConflict('Person erasure proof or sealed inventory differs');
  }
  for (const revision of inventory.revisions) {
    if (!PERSON.test(revision.revision)
      && revision.revision !== `https://rezics.com/id/${inventory.provisionId}-agent-revision`) {
      throw new PersonGraphErasureConflict('Person erasure revision identity differs');
    }
    if (revision.manifest !== null && !SHA.test(revision.manifest)) {
      throw new PersonGraphErasureConflict('Person erasure manifest identity differs');
    }
  }
  if (inventory.units.some(value => ![PUBLIC, PRIVATE].includes(value.graph))) {
    throw new PersonGraphErasureConflict('Person erasure index graph differs');
  }
  for (const unit of inventory.units.map(value => value.unit)) iri(unit);
  if (inventory.authorUnits.some(unit => !PERSON.test(unit)
    && !/^urn:rezics:search:directory:prefix:[A-Za-z0-9_:*-]+$/.test(unit))) {
    throw new PersonGraphErasureConflict('Person credited-Work projection identity differs');
  }
  if (inventory.objects.length > 128 || inventory.objects.some(value => !/^sha256:[0-9a-f]{64}$/.test(value))
    || new Set(inventory.objects).size !== inventory.objects.length) {
    throw new PersonGraphErasureConflict('Person erasure object inventory differs');
  }
}

export function personProfileErasureReceipt(erasureId: string, person: string): string {
  if (!UUID.test(erasureId) || !PERSON.test(person)) throw new PersonGraphErasureConflict('invalid Person erasure identity');
  return `urn:rezics:receipt:erasure-graph:${hash(`person-profile\0${erasureId}\0${person}`)}`;
}
function digest(proof: PersonProfileErasureProof, inventory: PersonProfileGraphInventory): string {
  return hash(JSON.stringify({ family: 'person-profile-erasure-v1', erasureId: proof.erasureId,
    epoch: proof.erasureEpoch, accountErasureId: proof.accountErasureId, inventory }));
}
function predicateIri(value: string): string { return `<${value}>`; }

/** Exact current allowlist and profile-literal history; attribution edges are retained. */
export function personProfileErasureUpdate(lineage: GraphLineage, proof: PersonProfileErasureProof,
  inventory: PersonProfileGraphInventory): string {
  identity(proof, inventory);
  const receipt = personProfileErasureReceipt(proof.erasureId, proof.person);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0event`)}`;
  return `PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
  DELETE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
    GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} ?currentP ?currentO ; a rv:Agent }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision ?profileP ?profileO }
    GRAPH ?indexGraph { ?unit ?indexP ?indexO }
  } INSERT {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
    GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} a rv:AgentTombstone ; rv:agentKind rv:PersonAgent ;
      rv:erasureId ${lit(proof.erasureId)} ; rv:erasureEpoch ${proof.erasureEpoch} }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${inventory.revisions.map(value => `${iri(value.revision)} a rv:ErasedRevision ; rv:erasureEpoch ${proof.erasureEpoch} .`).join('\n')}
    }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest(proof, inventory))} ;
      rv:outcome rv:Succeeded ; rv:erasureId ${lit(proof.erasureId)} ; rv:erasureEpoch ${proof.erasureEpoch} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?next }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:GraphErasureEvent ; rv:ordinal 0 ; rv:action "erasure.graph" ;
      rv:agent ${iri(proof.person)} ; rv:receipt ${iri(receipt)} ; rv:erasureId ${lit(proof.erasureId)} ;
      rv:erasureEpoch ${proof.erasureEpoch} }
  } WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?n }
    GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} a rv:Agent ; rv:agentKind rv:PersonAgent ; rv:head ${iri(inventory.head)} }
    ${inventory.profileHead ? `GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} rv:publicProfileHead ${iri(inventory.profileHead)} }`
      : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} rv:publicProfileHead ?newHead } }`}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} rv:protectionHead ?hold } }
    FILTER NOT EXISTS { VALUES ?ownedRevision { ${inventory.revisions.map(value => iri(value.revision)).join(' ')} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
        ?ownedRevision a rv:RevisionAnchor ; rv:component ${iri(proof.person)} } } }
    FILTER NOT EXISTS { VALUES ?ownedRevision { ${inventory.revisions.map(value => iri(value.revision)).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?ownedRevision rv:component ?anotherOwner }
      FILTER(?anotherOwner != ${iri(proof.person)}) }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    OPTIONAL { VALUES ?currentP { ${PROFILE_PREDICATES.map(predicateIri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} ?currentP ?currentO } }
    OPTIONAL { VALUES ?revision { ${inventory.revisions.map(value => iri(value.revision)).join(' ')} }
      VALUES ?profileP { ${PROFILE_PREDICATES.filter(value => !value.endsWith('/head') && !value.endsWith('/publicProfileHead')).map(predicateIri).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ${iri(proof.person)} ; ?profileP ?profileO } }
    ${inventory.units.length ? `OPTIONAL { VALUES (?indexGraph ?unit) {
      ${inventory.units.map(value => `(${iri(value.graph)} ${iri(value.unit)})`).join('\n')} }
      GRAPH ?indexGraph { ?unit ?indexP ?indexO } }` : ''}
    BIND(?n + 1 AS ?next)
  }`;
}

/** Final owner probe includes history and index absence, even when a receipt was retained. */
export async function personProfileGraphErased(fuseki: QueryClient, proof: PersonProfileErasureProof,
  inventory: PersonProfileGraphInventory): Promise<boolean> {
  identity(proof, inventory);
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} a rv:AgentTombstone ; rv:agentKind rv:PersonAgent ;
      rv:erasureId ${lit(proof.erasureId)} ; rv:erasureEpoch ${proof.erasureEpoch} }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(personProfileErasureReceipt(proof.erasureId, proof.person))}
      rv:outcome rv:Succeeded ; rv:requestDigest ${lit(digest(proof, inventory))} ;
      rv:erasureId ${lit(proof.erasureId)} ; rv:erasureEpoch ${proof.erasureEpoch} }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} ?p ?o }
      FILTER(?p NOT IN (<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>, rv:agentKind, rv:erasureId, rv:erasureEpoch)) }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} a ?kind }
      FILTER(?kind != rv:AgentTombstone) }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} rv:agentKind ?kind }
      FILTER(?kind != rv:PersonAgent) }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} rv:erasureId ?id }
      FILTER(?id != ${lit(proof.erasureId)}) }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(proof.person)} rv:erasureEpoch ?epoch }
      FILTER(?epoch != ${proof.erasureEpoch}) }
    FILTER NOT EXISTS { VALUES ?revision { ${inventory.revisions.map(value => iri(value.revision)).join(' ')} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision ; rv:erasureEpoch ${proof.erasureEpoch} } } }
    FILTER NOT EXISTS { VALUES ?revision { ${inventory.revisions.map(value => iri(value.revision)).join(' ')} }
      VALUES ?p { ${PROFILE_PREDICATES.map(predicateIri).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision ?p ?o } }
    FILTER NOT EXISTS { VALUES ?graph { ${iri(PUBLIC)} ${iri(PRIVATE)} }
      VALUES ?target { ${[proof.person, ...inventory.revisions.map(value => value.revision)].map(iri).join(' ')} }
      VALUES ?reference { rv:revision rv:contentRevision rv:resource rv:nameResource rv:nameDirectoryResource }
      GRAPH ?graph { ?unit ?reference ?target } }
  }`, 8192);
  return result.boolean === true;
}

/** Authority belongs to Access; native typed-footprint admission remains required at dispatch. */
export async function erasePersonProfileGraph(access: Pool, relay: Pool, fuseki: FusekiClient,
  lineage: GraphLineage, proof: PersonProfileErasureProof, inventory: PersonProfileGraphInventory): Promise<void> {
  identity(proof, inventory);
  await withPersonProfileErasureAuthority(access, relay, proof, async () => {
    const expected = [
      { owner: 'graph', kind: 'person_head', ref: inventory.person },
      ...inventory.revisions.map(value => ({ owner: 'graph', kind: 'person_profile_revision', ref: value.revision })),
      ...inventory.objects.map(ref => ({ owner: 'object', kind: 'object', ref })),
    ];
    const sealed = await relay.query(`SELECT 1 FROM jsonb_to_recordset($2::jsonb)
      AS expected(owner text, kind text, ref text) WHERE NOT EXISTS (
        SELECT 1 FROM relay.erasure_target t WHERE t.erasure_id = $1
          AND t.owner = expected.owner AND t.target_kind = expected.kind AND t.target_ref = expected.ref)
      LIMIT 1`, [proof.erasureId, JSON.stringify(expected)]);
    if (sealed.rowCount) throw new PersonGraphErasureConflict('Person closure differs from the sealed journal targets');
    if (await personProfileGraphErased(fuseki, proof, inventory)) return;
    const validations: CommandValidation[] = await profileValidations(fuseki, 'agent-erasure-v1', [
      { shape: `${PROFILE}/tombstone-shape`, focus: [proof.person], graphs: [GRAPHS.current] },
    ]);
    try {
      await fuseki.commandWithReceipt({ receipt: personProfileErasureReceipt(proof.erasureId, proof.person),
        digest: digest(proof, inventory), update: personProfileErasureUpdate(lineage, proof, inventory),
        validations, deadlineMs: 10_000 });
    } catch {
      // The command may have committed before transport failed; absence is the owner proof.
    }
    if (!await personProfileGraphErased(fuseki, proof, inventory)) {
      throw new PersonGraphErasureUnavailable('Person graph erasure remains unproven');
    }
  });
}
