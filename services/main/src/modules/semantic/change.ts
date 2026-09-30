import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPHS, ID, IdempotencyConflict, PendingActivation, RV, WORK_SEMANTIC_TYPES, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import { assertSemanticDispatchable, checkedSemanticTerminal, ensureModelGeneration,
  familyReceiptIri, readComponent, readSemanticTerminal, SemanticChangeRejected, SemanticTargetUnavailable,
  sealComponentState, sealSemanticRejection, sendSemanticWrite, StaleSemanticHead, validationsFor,
  type SemanticAdmission, type SemanticTerminal } from './command.ts';
import { checkedNativeIri, DEFINITION_KINDS, definitionKindIri, MODEL_COMPONENT, PROFILES, SEMANTIC_CHANGE_LIMITS,
  semanticPredicateOutcome, semanticTypeOutcome, type DefinitionKind, type Lifecycle } from './schema.ts';
import { checkedSemanticValue, semanticValueRdf, type SemanticValue, type ValueRdf } from './value.ts';
import { modelGenerationHeadGuard } from './generation-guard.ts';

const RDFS_RESOURCE = 'http://www.w3.org/2000/01/rdf-schema#Resource';
export const SEMANTIC_CHANGE_FAMILY = 'semantic-change';

/** Types routed to another owner's canonical shape can never be added generically. */
export const CANONICAL_TYPES: ReadonlySet<string> = new Set((JSON.parse(readFileSync(
  join(import.meta.dir, '../../../../../generated/model/manifest.json'), 'utf8')) as {
  canonical: { type: string }[] }).canonical.map(entry => entry.type));

export interface SemanticProperty { predicate: string; value: SemanticValue }
/** A stored assertion keeps its identified value node so history resolves exactly. */
export interface StoredProperty extends SemanticProperty { node?: string }

export interface ResourceState {
  component: 'resource';
  types: string[];
  properties: StoredProperty[];
  lifecycle: Lifecycle;
}

export interface RelationRole { key: string; minParticipants: number; maxParticipants: number; ordered: boolean }

export interface DefinitionState {
  component: 'definition';
  kind: DefinitionKind;
  lifecycle: Lifecycle;
  successor: string | null;
  roles: RelationRole[];
}

export type ComponentState = ResourceState | DefinitionState;
export type ComponentInput = Omit<ResourceState, 'properties'> & { properties: SemanticProperty[] }
  | DefinitionState;

export interface SemanticChangeIntent {
  admission: SemanticAdmission;
  /** Absent for a create; the owner allocates the identity. */
  target?: string;
  /** The semantic head, or the existing Work head for its first description. */
  expectedHead: string | null;
  state: ComponentInput;
}

export interface SemanticChangeResult {
  component: string;
  revision: string;
  predecessor: string | null;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

const fail = (code: SemanticChangeRejected['code'], message: string): never => {
  throw new SemanticChangeRejected(code, message);
};

function checkedTypes(types: readonly unknown[]): string[] {
  // The component already supplies rdfs:Resource. An attached description needs
  // no invented descriptive type in addition to its owner's existing types.
  if (!Array.isArray(types) || types.length > SEMANTIC_CHANGE_LIMITS.typesPerResource
    || new Set(types).size !== types.length) fail('invalid', 'semantic type set is invalid');
  for (const type of types) {
    if (typeof type !== 'string') fail('invalid', 'semantic type is invalid');
    const outcome = semanticTypeOutcome(type as string);
    if (outcome !== 'admitted') fail(outcome === 'invalid' ? 'invalid' : outcome, 'semantic type is not admitted');
    if (CANONICAL_TYPES.has(type as string)) fail('reserved-owner', 'semantic type belongs to another owner');
  }
  return [...types as string[]].sort();
}

function keyOf(property: SemanticProperty): string {
  return JSON.stringify([property.predicate, property.value]);
}

/** Canonical, bounded component state; the digest and manifest use this form. */
export function checkedComponentState(input: unknown): ComponentInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid', 'state is invalid');
  const row = input as Record<string, unknown>;
  const lifecycle = row.lifecycle ?? 'active';
  if (lifecycle !== 'active' && lifecycle !== 'retired') fail('invalid', 'lifecycle is invalid');
  if (row.component === 'resource') {
    if (Object.keys(row).some(key => !['component', 'types', 'properties', 'lifecycle'].includes(key))) {
      fail('invalid', 'resource state has unsupported fields');
    }
    const properties = (row.properties ?? []) as unknown[];
    if (!Array.isArray(properties) || properties.length > SEMANTIC_CHANGE_LIMITS.assertionsPerChange) {
      fail('too-large', 'too many assertions');
    }
    const checked = properties.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => key !== 'predicate' && key !== 'value')) fail('invalid', 'assertion is invalid');
      const { predicate, value } = item as Record<string, unknown>;
      if (typeof predicate !== 'string') return fail('invalid', 'predicate is invalid');
      const outcome = semanticPredicateOutcome(predicate);
      if (outcome !== 'admitted' || predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
        fail(outcome === 'invalid' || outcome === 'admitted' ? 'invalid' : outcome, 'predicate is not admitted');
      }
      return { predicate, value: checkedSemanticValue(value) };
    });
    if (new Set(checked.map(keyOf)).size !== checked.length) fail('invalid', 'assertion repeats');
    if (checked.filter(item => STRUCTURED.has(item.value.kind) || item.value.kind === 'language-string'
      && item.value.direction).length > SEMANTIC_CHANGE_LIMITS.valueNodesPerChange) {
      fail('too-large', 'too many structured values');
    }
    return { component: 'resource', types: checkedTypes(row.types as unknown[]),
      properties: checked.sort((a, b) => keyOf(a).localeCompare(keyOf(b))), lifecycle: lifecycle as Lifecycle };
  }
  if (row.component === 'definition') {
    if (Object.keys(row).some(key => !['component', 'kind', 'lifecycle', 'successor', 'roles'].includes(key))) {
      fail('invalid', 'definition state has unsupported fields');
    }
    if (!DEFINITION_KINDS.includes(row.kind as DefinitionKind)) fail('invalid', 'definition kind is invalid');
    const successor = row.successor ?? null;
    if (successor !== null && (typeof successor !== 'string' || !checkedNative(successor))) {
      fail('invalid', 'successor is invalid');
    }
    if (successor !== null && lifecycle !== 'retired') fail('invalid', 'only a retired definition names a successor');
    const roles = (row.roles ?? []) as unknown[];
    if (!Array.isArray(roles) || roles.length > 16 || (row.kind === 'relation') !== roles.length > 0) {
      fail('invalid', 'relation definitions declare 1-16 roles; other kinds declare none');
    }
    const checkedRoles = roles.map(item => {
      const role = item as Record<string, unknown>;
      if (!role || typeof role !== 'object' || Object.keys(role).some(key =>
        !['key', 'minParticipants', 'maxParticipants', 'ordered'].includes(key))
        || typeof role.key !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(role.key)
        || !Number.isInteger(role.minParticipants) || !Number.isInteger(role.maxParticipants)
        || (role.minParticipants as number) < 0 || (role.maxParticipants as number) < 1
        || (role.minParticipants as number) > (role.maxParticipants as number)
        || (role.maxParticipants as number) > 64 || typeof role.ordered !== 'boolean') {
        return fail('invalid', 'relation role is invalid');
      }
      return { key: role.key, minParticipants: role.minParticipants as number,
        maxParticipants: role.maxParticipants as number, ordered: role.ordered };
    }).sort((a, b) => a.key.localeCompare(b.key));
    if (new Set(checkedRoles.map(role => role.key)).size !== checkedRoles.length) fail('invalid', 'role repeats');
    return { component: 'definition', kind: row.kind as DefinitionKind, lifecycle: lifecycle as Lifecycle,
      successor: successor as string | null, roles: checkedRoles };
  }
  return fail('invalid', 'component is invalid');
}

function checkedNative(value: string): boolean {
  try { checkedNativeIri(value); return true; } catch { return false; }
}

export function semanticChangeDigest(target: string | undefined, expectedHead: string | null,
  state: ComponentInput): string {
  if (target !== undefined) checkedNativeIri(target);
  if (expectedHead !== null) checkedNativeIri(expectedHead);
  if ((target === undefined) !== (expectedHead === null)) fail('invalid', 'a create has no head; an edit names one');
  return hash(JSON.stringify({ family: 'semantic-change-v1', target: target ?? null, expectedHead,
    state: checkedComponentState(state) }));
}

const STRUCTURED = new Set(['quantity', 'temporal', 'external']);

/** Resource references in a state; Access must admit each before dispatch (MODEL10). */
export function referencedResources(state: ComponentInput): string[] {
  if (state.component !== 'resource') return state.successor ? [state.successor] : [];
  return [...new Set(state.properties.flatMap(item => item.value.kind === 'resource' ? [item.value.ref] : []))].sort();
}

/** RDF for owned assertions. Unchanged structured values reuse their immutable node. */
export function propertyRdf(properties: readonly SemanticProperty[], prior: readonly StoredProperty[]): {
  stored: StoredProperty[]; rdf: (ValueRdf & { predicate: string })[] } {
  const reusable = new Map(prior.filter(item => item.node).map(item => [keyOf(item), item.node!]));
  const stored: StoredProperty[] = [];
  const rdf = properties.map(property => {
    const existing = reusable.get(keyOf(property));
    const value = semanticValueRdf(property.value, () => existing ?? `${ID}${Bun.randomUUIDv7()}`);
    stored.push({ ...property, ...(value.node ? { node: value.node.iri } : {}) });
    return { ...value, predicate: property.predicate,
      ...(value.node && existing ? { node: undefined } : {}) };
  });
  return { stored, rdf };
}

function storedRdf(properties: readonly StoredProperty[]): string[] {
  return properties.map(property => `<${property.predicate}> ${semanticValueRdf(property.value,
    () => property.node ?? fail('invalid', 'stored structured value has no node')).object}`);
}

export function checkedStoredState(state: Record<string, unknown>): ComponentState {
  try {
    if (state.component === 'resource') {
      const input = checkedComponentState({ component: 'resource', types: state.types, lifecycle: state.lifecycle,
        properties: (state.properties as StoredProperty[]).map(({ predicate, value }) => ({ predicate, value })) });
      const nodes = (state.properties as StoredProperty[]).map(item => item.node);
      if (input.component !== 'resource' || nodes.some(node => node !== undefined && !checkedNative(node))) {
        throw new Error('stored resource state differs');
      }
      const byKey = new Map((state.properties as StoredProperty[]).map(item => [keyOf(item), item.node]));
      return { ...input, properties: input.properties.map(item => ({ ...item,
        ...(byKey.get(keyOf(item)) ? { node: byKey.get(keyOf(item))! } : {}) })) };
    }
    return checkedComponentState(state) as DefinitionState;
  } catch { throw new RevisionCorrupt('stored semantic state is invalid'); }
}

interface CurrentComponent { head: string; manifest: string; state: ComponentState }

/** Exact current component: graph head, its retained manifest and a projection check. */
export async function readCurrentComponent(env: WorkActivationEnvironment, target: string,
  component: ComponentState['component']): Promise<CurrentComponent | null> {
  const headPredicate = component === 'resource' ? 'semanticHead' : 'definitionHead';
  const revisionType = component === 'resource' ? 'SemanticRevision' : 'DefinitionRevision';
  const profile = component === 'resource' ? PROFILES.resource : PROFILES.definition;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(target)} rv:${headPredicate} ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:${revisionType} ; rv:component ${iri(target)} ; rv:manifest ?manifest } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.head || !rows[0].manifest) throw new RevisionCorrupt('semantic head is ambiguous');
  const state = checkedStoredState(await readComponent(env, rows[0].manifest.value, target, profile));
  if (state.component !== component) throw new RevisionCorrupt('semantic head names another component');
  const expected = new Set(ownedTriples(target, state, rows[0].head.value));
  // Open resource: predicates other components own on this subject are preserved and ignored.
  const owned = new Set([...expected].map(triple => triple.slice(0, triple.indexOf('> ') + 1)));
  const projection = await env.fuseki.query(`SELECT ?p ?o WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(target)} ?p ?o . FILTER(?p IN (${[...owned].join(', ')}))
    FILTER(?p != <${TYPE}> || ?o IN (${state.component === 'resource'
      ? [RDFS_RESOURCE, ...state.types].map(type => `<${type}>`).join(', ')
      : `<${RV}SemanticDefinition>`})) } } LIMIT ${expected.size + 1}`);
  const actual = new Set((projection.results?.bindings ?? [])
    .map(row => `<${row.p!.value}> ${term(row.o!)}`));
  if (actual.size !== expected.size || [...expected].some(item => !actual.has(item))) {
    throw new RevisionCorrupt('semantic projection differs from its retained head');
  }
  return { head: rows[0].head.value, manifest: rows[0].manifest.value, state };
}

export function term(binding: { type: string; value: string; datatype?: string; 'xml:lang'?: string }): string {
  if (binding.type === 'uri') return `<${binding.value}>`;
  if (binding['xml:lang']) return `${JSON.stringify(binding.value)}@${binding['xml:lang']}`;
  return `${JSON.stringify(binding.value)}^^<${binding.datatype ?? 'http://www.w3.org/2001/XMLSchema#string'}>`;
}

const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Every current-graph triple the component owns on its subject. */
export function ownedTriples(target: string, state: ComponentState, head: string): string[] {
  if (state.component === 'resource') {
    return [`<${TYPE}> <${RDFS_RESOURCE}>`, ...state.types.map(type => `<${TYPE}> <${type}>`),
      `<${RV}semanticHead> <${head}>`, ...storedRdf(state.properties)];
  }
  return [`<${TYPE}> <${RV}SemanticDefinition>`, `<${RV}definitionKind> <${definitionKindIri(state.kind)}>`,
    `<${RV}definitionHead> <${head}>`, ...(state.successor ? [`<${RV}successor> <${state.successor}>`] : [])];
}

export async function readSemanticChangeTerminal(env: WorkActivationEnvironment, admissionId: string):
Promise<SemanticTerminal | null> {
  return readSemanticTerminal(env, familyReceiptIri(admissionId, SEMANTIC_CHANGE_FAMILY));
}

/** The structural attachment guard is not a semantic predecessor. Read the
 * immutable anchor so first attachment and receipt replay report the same lineage. */
export async function semanticPredecessor(env: WorkActivationEnvironment, terminal: SemanticTerminal): Promise<string | null> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(terminal.revision!)} rv:predecessor ?predecessor }
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length > 1) throw new RevisionCorrupt('semantic predecessor is ambiguous');
  return rows[0]?.predecessor?.value ?? null;
}

async function resultOf(env: WorkActivationEnvironment, terminal: SemanticTerminal, replayed: boolean): Promise<SemanticChangeResult> {
  return { component: terminal.component!, revision: terminal.revision!, predecessor: await semanticPredecessor(env, terminal),
    receipt: terminal.receipt, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence, replayed };
}

/**
 * Create or revise one semantic component (a Resource's semantic description or a
 * versioned definition) under the expected head. The update guards the head, the
 * pinned model generation, referenced targets and receipt absence in one TDB2 write.
 */
export async function changeSemanticComponent(env: WorkActivationEnvironment,
  intent: SemanticChangeIntent): Promise<SemanticChangeResult> {
  const state = checkedComponentState(intent.state);
  const digest = semanticChangeDigest(intent.target, intent.expectedHead, state);
  const receipt = familyReceiptIri(intent.admission.id, SEMANTIC_CHANGE_FAMILY);
  const existing = await assertSemanticDispatchable(env, intent.admission, receipt, digest);
  if (existing) return checkedResult(env, existing, intent, true);
  const generation = await ensureModelGeneration(env);
  const target = intent.target ?? `${ID}${Bun.randomUUIDv7()}`;
  if (intent.target && state.component === 'resource'
    && state.types.some(type => WORK_SEMANTIC_TYPES.some(ownedType => ownedType === type))) {
    const isWork = await env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target)} a <https://schema.org/CreativeWork> } }`);
    if (isWork.boolean) fail('reserved-owner', 'Work kinds belong to the Work type command');
  }
  const current = intent.target ? await readCurrentComponent(env, target, state.component) : null;
  // A first description attaches to the existing Work under its structural head.
  // Later edits compare only the independently owned semantic head.
  const attachment = intent.target && !current && state.component === 'resource'
    ? await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(target)} a schema:CreativeWork ; rv:head ?head .
        FILTER NOT EXISTS { ${iri(target)} rv:semanticHead ?semanticHead }
        FILTER NOT EXISTS { ${iri(target)} rv:protectionHead ?protection }
      } FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } } } LIMIT 2`)
    : null;
  const workHead = attachment?.results?.bindings;
  if (intent.target && !current && (workHead?.length !== 1 || !workHead[0]?.head)) {
    // Another first attachment may commit between the component and Work reads.
    // Resolve that race as stale rather than reporting the existing Work missing.
    const raced = state.component === 'resource' ? await readCurrentComponent(env, target, state.component) : null;
    if (raced && raced.head !== intent.expectedHead) return sealStale(env, intent, receipt, digest, target, state);
    throw new SemanticTargetUnavailable('semantic component is unavailable');
  }
  if (workHead?.[0]?.head?.value !== undefined && workHead[0].head.value !== intent.expectedHead) {
    return sealStale(env, intent, receipt, digest, target, state);
  }
  if (current && current.head !== intent.expectedHead) return sealStale(env, intent, receipt, digest, target, state);
  if (current?.state.component === 'definition' && state.component === 'definition'
    && current.state.kind !== state.kind) fail('invalid', 'a definition keeps its kind');
  const addedTypes = state.component === 'resource' ? state.types.filter(type =>
    current?.state.component !== 'resource' || !current.state.types.includes(type)) : [];
  if (intent.target && addedTypes.length) {
    const overlap = await env.fuseki.query(`SELECT ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target)} a ?type . VALUES ?type { ${addedTypes.map(type => `<${type}>`).join(' ')} }
    } } LIMIT 1`);
    if (overlap.results?.bindings.length) fail('reserved-owner', 'semantic type already belongs to another component');
  }
  const prior = current?.state.component === 'resource' ? current.state.properties : [];
  const { stored, rdf } = state.component === 'resource' ? propertyRdf(state.properties, prior)
    : { stored: [], rdf: [] };
  const exact: ComponentState = state.component === 'resource' ? { ...state, properties: stored } : state;
  const profile = state.component === 'resource' ? PROFILES.resource : PROFILES.definition;
  const manifest = await sealComponentState(env, target, profile, exact);
  const revision = `${ID}${Bun.randomUUIDv7()}`;
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  const old = current ? ownedTriples(target, current.state, current.head)
    .filter(triple => !(state.component === 'resource' && triple === `<${TYPE}> <${RDFS_RESOURCE}>`)) : [];
  const next = ownedTriples(target, exact, revision)
    .filter(triple => !(current && state.component === 'resource' && triple === `<${TYPE}> <${RDFS_RESOURCE}>`));
  const revisionType = state.component === 'resource' ? 'SemanticRevision' : 'DefinitionRevision';
  const nodes = rdf.flatMap(item => item.node ? [item.node] : []);
  const references = referencedResources(state);
  const anchor = `${iri(revision)} a rv:${revisionType}, rv:RevisionAnchor ; rv:component ${iri(target)} ;
    ${current ? `rv:predecessor ${iri(current.head)} ;` : ''} rv:lifecycle rv:${state.lifecycle === 'active' ? 'Active' : 'Retired'} ;
    ${state.component === 'definition' ? `rv:definitionKind <${definitionKindIri(state.kind)}> ;
      ${state.successor ? `rv:successor ${iri(state.successor)} ;` : ''}` : ''}
    rv:operation ${iri(operation)} ; rv:manifest ${iri(manifest)} ; rv:modelGeneration ${iri(generation)} ;
    rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ; rv:datasetId ${iri('urn:rezics:dataset:product')} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`;
  const validationProfile = state.component === 'resource' ? 'semantic-resource-v1' : 'semantic-definition-v1';
  const validations = [
    ...await validationsFor(env, validationProfile, [
      { role: state.component === 'resource' ? 'resource' : 'definition', focus: [target] },
      { role: 'revision', focus: [revision] }]),
    ...await valueValidations(env, rdf),
  ];
  await sendSemanticWrite(env, {
    receipt, digest, admission: intent.admission, validations,
    deletes: old.length ? `GRAPH ${iri(GRAPHS.current)} { ${old.map(triple => `${iri(target)} ${triple} .`).join('\n')} }` : '',
    inserts: `GRAPH ${iri(GRAPHS.current)} { ${next.map(triple => `${iri(target)} ${triple} .`).join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${anchor}
        ${rdf.flatMap(item => item.node ? item.node.triples.map(triple => `${triple} .`) : []).join('\n')} }`,
    where: `${modelGenerationHeadGuard(generation)}
      ${current ? `GRAPH ${iri(GRAPHS.current)} { ${old.map(triple => `${iri(target)} ${triple} .`).join('\n')} }`
        : workHead ? `GRAPH ${iri(GRAPHS.current)} {
            ${iri(target)} a <https://schema.org/CreativeWork> ; rv:head ${iri(intent.expectedHead!)} . }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(target)} rv:semanticHead ?otherHead } }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(target)} rv:protectionHead ?protection } }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.expectedHead!)} a rv:ErasedRevision } }`
          : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(target)} ?anyP ?anyO } }`}
      ${references.map(ref => `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} a ?refType } }`).join('\n')}
      ${intent.target && addedTypes.length ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(target)} a ?ownedType . VALUES ?ownedType { ${addedTypes.map(type => `<${type}>`).join(' ')} } } }` : ''}
      ${state.component === 'definition' && state.successor ? `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(state.successor)} a rv:SemanticDefinition } }` : ''}
      ${nodes.map(node => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(node.iri)} ?nodeP ?nodeO } }`).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?revP ?revO } }`,
    receiptFields: `rv:operation ${iri(operation)} ; rv:component ${iri(target)} ; rv:revision ${iri(revision)} ;
      ${intent.expectedHead ? `rv:expectedHead ${iri(intent.expectedHead)} ;` : ''}`,
  });
  const committed = await readSemanticTerminal(env, receipt);
  if (committed) return checkedResult(env, committed, intent, committed.revision !== revision);
  const changedGeneration = await sealSemanticRejection(env, receipt, digest, intent.admission, 'generation-changed',
    `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(generation)} } }`);
  if (changedGeneration) {
    const terminal = checkedSemanticTerminal(changedGeneration, intent.admission, digest);
    return checkedResult(env, terminal, intent, terminal.revision !== revision);
  }
  if (intent.target) {
    const now = await readCurrentComponent(env, target, state.component).catch(() => null);
    if (now && now.head !== intent.expectedHead) return sealStale(env, intent, receipt, digest, target, state);
  }
  if (references.length) {
    const sealed = await sealSemanticRejection(env, receipt, digest, intent.admission, 'unavailable-reference',
      `FILTER (${references.map(ref => `NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(ref)} a ?t } }`)
        .join(' || ')})`);
    if (sealed) return checkedResult(env, sealed, intent, false);
  }
  throw new PendingActivation('semantic change guard did not match');
}

export async function valueValidations(env: WorkActivationEnvironment, rdf: readonly ValueRdf[]) {
  const byRole = new Map<string, string[]>();
  for (const item of rdf) if (item.node) byRole.set(item.node.shape, [...byRole.get(item.node.shape) ?? [], item.node.iri]);
  return byRole.size ? validationsFor(env, 'value-exact-v1', [...byRole].map(([role, focus]) => ({ role, focus }))) : [];
}

async function sealStale(env: WorkActivationEnvironment, intent: SemanticChangeIntent, receipt: string,
  digest: string, target: string, state: ComponentInput): Promise<SemanticChangeResult> {
  const head = state.component === 'resource' ? 'semanticHead' : 'definitionHead';
  const terminal = await sealSemanticRejection(env, receipt, digest, intent.admission, 'stale-head',
    `{ GRAPH ${iri(GRAPHS.current)} { ${iri(target)} rv:${head} ?currentHead } }
     ${state.component === 'resource' ? `UNION { GRAPH ${iri(GRAPHS.current)} {
       ${iri(target)} a <https://schema.org/CreativeWork> ; rv:head ?currentHead .
       FILTER NOT EXISTS { ${iri(target)} rv:semanticHead ?semanticHead } } }` : ''}
     FILTER(?currentHead != ${iri(intent.expectedHead!)})`);
  if (!terminal) throw new PendingActivation('stale semantic outcome is not sealed');
  return checkedResult(env, terminal, intent, false);
}

async function checkedResult(env: WorkActivationEnvironment, terminal: SemanticTerminal, intent: SemanticChangeIntent,
  replayed: boolean): Promise<SemanticChangeResult> {
  const checked = checkedSemanticTerminal(terminal, intent.admission, intent.admission.requestDigest);
  if ((intent.target !== undefined && checked.component !== intent.target)
    || (checked.expectedHead ?? null) !== intent.expectedHead) {
    throw new IdempotencyConflict('semantic receipt targets another intent');
  }
  return resultOf(env, checked, replayed);
}

export { StaleSemanticHead };
