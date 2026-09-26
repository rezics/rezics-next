import { createHash } from 'node:crypto';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';
import { GRAPHS, ID, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import type { OccurrenceRecord, OrderEntry } from './format.ts';
import type { OccurrenceRole, StructureProfile } from './format.ts';
import { structureProfileFor, structureProfileForGraph } from './profiles.ts';

// Bounded current-graph reads for Book compositions. Every read names the
// selected generation, so a staged or retired generation is never unioned in.

export const COMPOSITION_PROFILE = 'https://rezics.com/definition/structure-composition-v1';
export const NATIVE_ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const STRUCTURE_IRI = /^(?:https:\/\/[^<>\s"{}|\\^`]+|urn:[A-Za-z0-9][A-Za-z0-9:._-]*)$/;

/** Render a profile-validated resource or catalog IRI for a Structure SPARQL term. */
export function structureIri(value: string): string {
  if (!STRUCTURE_IRI.test(value)) throw new CompositionUnavailable('invalid Structure reference');
  return `<${value}>`;
}
export const ROLE_IRI: Record<OccurrenceRole, string> = {
  group: `${RV}GroupRole`, chapter: `${RV}ChapterRole`, member: `${RV}MemberRole`,
  mount: `${RV}MountRole`, navigation: `${RV}NavigationRole`, ingredient: `${RV}IngredientRole`,
  step: `${RV}StepRole`, equipment: `${RV}EquipmentRole`,
};
export type BookRole = 'group' | 'chapter';

export class CompositionUnavailable extends Error {}
export class CompositionCorrupt extends Error {}

/** Deterministic native identity for one admitted command's allocations. */
export function derivedId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${ID}${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-`
    + `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

export function placementIri(generation: string, occurrence: string): string {
  return `urn:rezics:placement:${createHash('sha256').update(`${generation}\0${occurrence}`).digest('hex')}`;
}

export type Selection = { mode: 'follow-context' } | { mode: 'fixed-revision'; revision: string };
export interface Label { value: string; language: string }

/** One occurrence use in the selected generation, active or tombstoned. */
export interface PlacementState {
  occurrence: string;
  placement: string;
  active: boolean;
  segment?: string;
  parent: string;
  segmentKey?: string;
  orderKey?: string;
  role: OccurrenceRole;
  label?: Label;
  target?: string;
  selection?: Selection;
  qualifier?: OccurrenceRecord['qualifier'];
  sourceKey?: string;
  introducedBy: string;
  removedBy?: string;
}

export interface SegmentState { segment: string; parent: string; key: string; count: number }

export interface CompositionHeader {
  structure: string;
  profile: StructureProfile;
  owner: string;
  component: string;
  /** Compatibility aliases retained for existing Book API consumers. */
  mainVersion: string;
  work: string;
  head: string;
  generation: string;
  placementCount: number;
  manifest: string;
}

type SparqlBinding = NonNullable<SparqlResult['results']>['bindings'][number];
const value = (row: SparqlBinding, key: string) => row[key]?.value;

export async function readCompositionHeader(env: WorkActivationEnvironment,
  structure: string): Promise<CompositionHeader | null> {
  if (!NATIVE_ID.test(structure)) return null;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?component ?profile ?head ?generation ?count ?manifest WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(structure)} a rv:Structure ; rv:structureProfile ?profile ;
          rv:structureOf ?component ; rv:structureHead ?head ; rv:selectedGeneration ?generation .
        ?generation rv:structure ${iri(structure)} ; rv:generationState rv:Active ;
          rv:placementCount ?count .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StructureRevision ;
        rv:component ${iri(structure)} ; rv:manifest ?manifest . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(value(row, 'manifest') ?? '')
    || !/^[0-9]+$/.test(value(row, 'count') ?? '')) {
    throw new CompositionCorrupt('Composition header is ambiguous');
  }
  const profile = structureProfileForGraph(value(row, 'profile')!);
  const component = value(row, 'component')!;
  const owner = profile.componentPredicate
    ? await env.fuseki.query(`SELECT ?owner WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?owner a <${profile.ownerType}> ; <${profile.componentPredicate}> ${iri(component)} .
      ${iri(component)} a <${profile.componentType}> .
      ${profile.structurePredicate
        ? `?owner <${profile.structurePredicate}> ${iri(structure)} .` : ''}
    } } LIMIT 2`)
    : await env.fuseki.query(`SELECT ?owner WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(component)} a <${profile.ownerType}> ;
        <${profile.structurePredicate!}> ${iri(structure)} .
      BIND(${iri(component)} AS ?owner)
    } } LIMIT 2`);
  const owners = owner.results?.bindings ?? [];
  if (owners.length !== 1 || !owners[0]?.owner?.value) {
    throw new CompositionCorrupt('Structure authority resource is ambiguous');
  }
  return { structure, profile: profile.id, owner: owners[0].owner.value, component,
    mainVersion: component, work: owners[0].owner.value,
    head: value(row, 'head')!, generation: value(row, 'generation')!,
    placementCount: Number(value(row, 'count')), manifest: value(row, 'manifest')! };
}

export async function compositionForMainVersion(env: WorkActivationEnvironment,
  mainVersion: string): Promise<string | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?structure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?structure a rv:Structure ; rv:structureOf ${iri(mainVersion)} } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new CompositionCorrupt('Main Version has two compositions');
  return value(rows[0] ?? {}, 'structure') ?? null;
}

/** Placements selected by occurrence set or by one order segment (at most 512 members). */
export async function readPlacements(env: WorkActivationEnvironment, generation: string,
  selector: { occurrences: readonly string[] } | { segment: string },
  profile: StructureProfile = 'book-composition'): Promise<PlacementState[]> {
  if ('occurrences' in selector && !selector.occurrences.length) return [];
  const scope = 'occurrences' in selector
    ? `VALUES ?occurrence { ${selector.occurrences.map(iri).join(' ')} }`
    : `?placement rv:orderSegment ${iri(selector.segment)} .`;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?placement ?occurrence ?type ?segment ?parent ?segmentKey ?orderKey ?role ?label
      ?target ?mode ?pinned ?sourceKey ?introducedBy ?removedBy ?lastParent WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${scope}
        ?placement rv:generation ${iri(generation)} ; rv:occurrence ?occurrence ; a ?type ;
          rv:occurrenceRole ?role .
        FILTER(?type IN (rv:OccurrencePlacement, rv:RemovedPlacement))
        ?occurrence rv:introducedBy ?introducedBy .
        OPTIONAL { ?placement rv:orderSegment ?segment ; rv:orderKey ?orderKey .
          ?segment rv:parent ?parent ; rv:segmentKey ?segmentKey . }
        OPTIONAL { ?placement rv:occurrenceLabel ?label }
        OPTIONAL { ?placement rv:target ?target }
        OPTIONAL { ?placement rv:selectionMode ?mode }
        OPTIONAL { ?placement rv:pinnedRevision ?pinned }
        OPTIONAL { ?placement rv:sourceKey ?sourceKey }
        OPTIONAL { ?placement rv:removedBy ?removedBy ; rv:lastParent ?lastParent }
      }
    }`, 4 * 1024 * 1024);
  const rows = result.results?.bindings ?? [];
  const registration = structureProfileFor(profile);
  const catalogTargetTypes = registration.catalogTargetTypes ?? [];
  const selectionRequiredRoles = registration.selectionRequiredRoles ?? registration.targetRoles;
  const byOccurrence = new Map<string, PlacementState>();
  for (const row of rows) {
    const occurrence = value(row, 'occurrence')!;
    const active = value(row, 'type') === `${RV}OccurrencePlacement`;
    const role = (Object.entries(ROLE_IRI).find(([, uri]) => uri === value(row, 'role'))?.[0]
      ?? null) as OccurrenceRole | null;
    const mode = value(row, 'mode');
    const target = value(row, 'target');
    const labelLanguage = row.label?.['xml:lang'];
    const state: PlacementState = { occurrence, placement: value(row, 'placement')!, active,
      parent: active ? value(row, 'parent') ?? '' : value(row, 'lastParent') ?? '',
      role: role ?? 'group', introducedBy: value(row, 'introducedBy')!,
      ...(active ? { segment: value(row, 'segment'), segmentKey: value(row, 'segmentKey'),
        orderKey: value(row, 'orderKey') } : { removedBy: value(row, 'removedBy') }),
      ...(row.label ? { label: { value: row.label.value, language: labelLanguage ?? '' } } : {}),
      ...(target ? { target } : {}),
      ...(mode === `${RV}FollowContext` ? { selection: { mode: 'follow-context' } }
        : mode === `${RV}FixedRevision` && value(row, 'pinned')
          ? { selection: { mode: 'fixed-revision', revision: value(row, 'pinned')! } } : {}),
      ...(value(row, 'sourceKey') ? { sourceKey: value(row, 'sourceKey') } : {}) };
    const catalogTarget = target !== undefined && catalogTargetTypes.includes(target);
    const needsSelection = target !== undefined && !catalogTarget
      && selectionRequiredRoles.includes(state.role);
    if (!role || !state.parent || (active && (!state.segment || !state.orderKey || !state.segmentKey))
      || (!active && !state.removedBy) || Boolean(state.selection) !== needsSelection
      || (row.label && !labelLanguage)) {
      throw new CompositionCorrupt('Composition placement is incomplete');
    }
    const prior = byOccurrence.get(occurrence);
    if (prior && JSON.stringify(prior) !== JSON.stringify(state)) {
      throw new CompositionCorrupt('Composition placement is ambiguous');
    }
    byOccurrence.set(occurrence, state);
  }
  return [...byOccurrence.values()];
}

/** Order segments of a bounded parent set in one generation, sorted by segment key. */
export async function readSegments(env: WorkActivationEnvironment, generation: string,
  parents: readonly string[]): Promise<SegmentState[]> {
  if (!parents.length) return [];
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?segment ?parent ?key ?count WHERE { GRAPH ${iri(GRAPHS.current)} {
      VALUES ?parent { ${parents.map(iri).join(' ')} }
      ?segment a rv:OrderSegment ; rv:generation ${iri(generation)} ; rv:parent ?parent ;
        rv:segmentKey ?key ; rv:memberCount ?count . } }`, 4 * 1024 * 1024);
  const segments = (result.results?.bindings ?? []).map(row => ({ segment: value(row, 'segment')!,
    parent: value(row, 'parent')!, key: value(row, 'key')!, count: Number(value(row, 'count')) }));
  if (new Set(segments.map(segment => segment.segment)).size !== segments.length) {
    throw new CompositionCorrupt('Composition order segment is ambiguous');
  }
  return segments.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export interface PublishedVariant { target: string; variant: string; decision: string; revision: string }

/** Public eligible Content publications of a bounded target set. */
export async function readPublishedVariants(env: WorkActivationEnvironment,
  targets: readonly string[]): Promise<PublishedVariant[]> {
  const unique = [...new Set(targets)];
  const found: PublishedVariant[] = [];
  for (let start = 0; start < unique.length; start += 256) {
    const chunk = unique.slice(start, start + 256);
    const result = await env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?target ?variant ?decision ?revision WHERE {
        VALUES ?target { ${chunk.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?target ;
          rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
        GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:contentRevision ?revision .
          ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?decision ;
            rv:disclosure rv:Public . }
      }`, 4 * 1024 * 1024);
    for (const row of result.results?.bindings ?? []) {
      found.push({ target: value(row, 'target')!, variant: value(row, 'variant')!,
        decision: value(row, 'decision')!, revision: value(row, 'revision')! });
    }
  }
  return found.sort((a, b) => a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0);
}

export const orderTreeKey = (entry: Pick<OrderEntry, 'parent' | 'segmentKey' | 'orderKey'>) =>
  `${entry.parent}\u0001${entry.segmentKey}\u0001${entry.orderKey}`;
export const recordTreeKey = (entry: Pick<OccurrenceRecord, 'occurrence'>) => entry.occurrence;

/** The retained manifest record for one current placement. */
export function placementRecord(state: PlacementState): OccurrenceRecord {
  return { occurrence: state.occurrence, state: state.active ? 'active' : 'removed',
    parent: state.parent,
    ...(state.active ? { segmentKey: state.segmentKey!, orderKey: state.orderKey! } : {}),
    role: state.role, ...(state.target ? { target: state.target } : {}),
    ...(state.selection ? { selection: state.selection } : {}),
    ...(state.qualifier ? { qualifier: state.qualifier } : {}),
    labels: state.label ? [state.label] : [],
    ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}),
    introducedBy: state.introducedBy, ...(state.removedBy ? { removedBy: state.removedBy } : {}) };
}
