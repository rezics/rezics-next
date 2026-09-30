import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import { checkedStoredState, readCurrentComponent, type ComponentState, type DefinitionState,
  type ResourceState, type StoredProperty } from './change.ts';
import { readComponent } from './command.ts';
import { PROFILES } from './schema.ts';
import { semanticValueExport, type ReferenceAvailability, type SemanticValue } from './value.ts';
import { propertyRevelationRecord } from '../reading-position/store.ts';

/** Read-side availability of a referenced native Resource (MODEL10). */
export type ReferenceCheck = (ref: string) => Promise<boolean>;
type PublicValue = SemanticValue | { kind: 'unavailable-reference' };
type PublicState = (Omit<ResourceState, 'properties'> & {
  properties: (Omit<StoredProperty, 'value'> & { value: PublicValue })[]
}) | (DefinitionState & { successorUnavailable?: boolean });

export interface SemanticRead {
  component: string;
  revision: string;
  predecessor: string | null;
  modelGeneration: string;
  state: PublicState;
  references: Record<string, ReferenceAvailability>;
  export: Record<string, unknown>;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

function exportOf(component: string, state: PublicState): Record<string, unknown> {
  if (state.component === 'definition') {
    return { '@id': component, '@type': [`${RV}SemanticDefinition`] };
  }
  const properties: Record<string, unknown[]> = {};
  for (const { predicate, value } of state.properties) {
    (properties[predicate] ??= []).push(value.kind === 'unavailable-reference'
      ? { '@type': [`${RV}UnavailableReference`] } : semanticValueExport(value));
  }
  return { '@id': component, '@type': [...state.types], ...properties };
}

/**
 * Exact revision of one semantic component. It resolves only through the anchor
 * and its immutable manifest; a missing or corrupt object is unavailable, never
 * the current head. References disclose only available/unavailable per viewer.
 */
export async function readSemanticRevision(env: WorkActivationEnvironment, component: string, revision: string,
  canRead: ReferenceCheck, visibleRecords?: (records: readonly string[]) => Promise<ReadonlySet<string>>): Promise<SemanticRead | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?type ?manifest ?predecessor ?generation ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a ?type ; rv:component ${iri(component)} ; rv:manifest ?manifest ;
      rv:modelGeneration ?generation ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER(?type IN (rv:SemanticRevision, rv:DefinitionRevision))
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor } } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RevisionCorrupt('semantic revision is ambiguous');
  const row = rows[0]!;
  const definition = row.type!.value === `${RV}DefinitionRevision`;
  const state = checkedStoredState(await readComponent(env, row.manifest!.value, component,
    definition ? PROFILES.definition : PROFILES.resource));
  if ((state.component === 'definition') !== definition) throw new RevisionCorrupt('revision names another component');
  const availability = await references(state, canRead);
  const disclosed = visibleRecords ? await visibleRecords([component,
    ...Object.keys(availability).filter(ref => availability[ref]?.state === 'available'),
    ...(state.component === 'resource' ? state.properties.map(property =>
      propertyRevelationRecord(component, property.predicate, property.value)) : [])]) : null;
  if (disclosed && !disclosed.has(component)) return null;
  const properties = state.component === 'resource' ? state.properties.filter(property => !disclosed
    || disclosed.has(propertyRevelationRecord(component, property.predicate, property.value))
      && (property.value.kind !== 'resource' || availability[property.value.ref]?.state !== 'available'
        || disclosed.has(property.value.ref))) : [];
  const deliveredReferences = new Set(state.component === 'resource' ? properties.flatMap(property =>
    property.value.kind === 'resource' ? [property.value.ref] : []) : state.successor ? [state.successor] : []);
  for (const ref of Object.keys(availability)) if (!deliveredReferences.has(ref) || disclosed && !disclosed.has(ref)) delete availability[ref];
  const visible: PublicState = state.component === 'resource'
    ? { ...state, properties: properties.map(property => property.value.kind === 'resource'
      && availability[property.value.ref]?.state !== 'available'
      ? { ...property, value: { kind: 'unavailable-reference' as const } } : property) }
    : state.successor && availability[state.successor]?.state !== 'available'
      ? { ...state, successor: null, successorUnavailable: true } : state;
  return { component, revision, predecessor: row.predecessor?.value ?? null, modelGeneration: row.generation!.value,
    state: visible, references: Object.fromEntries(Object.entries(availability)
      .filter(([, value]) => value.state === 'available')), export: exportOf(component, visible),
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}

/** Current state: the exact head revision after the projection matched its manifest. */
export async function readSemanticCurrent(env: WorkActivationEnvironment, component: string,
  canRead: ReferenceCheck, visibleRecords?: (records: readonly string[]) => Promise<ReadonlySet<string>>): Promise<SemanticRead | null> {
  const kind = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?p WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(component)} ?p ?head . FILTER(?p IN (rv:semanticHead, rv:definitionHead)) } } LIMIT 2`);
  const rows = kind.results?.bindings ?? [];
  if (rows.length !== 1) return null;
  const current = await readCurrentComponent(env, component,
    rows[0]!.p!.value === `${RV}semanticHead` ? 'resource' : 'definition');
  if (!current) return null;
  return readSemanticRevision(env, component, current.head, canRead, visibleRecords);
}

async function references(state: ComponentState, canRead: ReferenceCheck): Promise<Record<string, ReferenceAvailability>> {
  const refs = state.component === 'resource'
    ? [...new Set(state.properties.flatMap(({ value }: { value: SemanticValue }) =>
      value.kind === 'resource' ? [value.ref] : []))]
    : state.successor ? [state.successor] : [];
  const entries = await Promise.all(refs.map(async ref =>
    [ref, { state: (await canRead(ref)) ? 'available' : 'unavailable' } as ReferenceAvailability] as const));
  return Object.fromEntries(entries);
}

export { readComponent };
