import { CompositionUnavailable } from './unavailable.ts';
import { createHash } from 'node:crypto';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';
import { GRAPHS, ID, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { STRUCTURE_LIMITS, type OccurrenceRecord, type OrderEntry } from './format.ts';
import type { OccurrenceRole, StructureProfile } from './format.ts';
import type { ExactInstructionSelector } from './selection.ts';
import { isContainerRole, structureProfileFor, structureProfileForGraph } from './profiles.ts';

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
/** A parent owns one ordered list in each topology generation. */
export const itemListIri = (generation: string, parent: string) =>
  `urn:rezics:item-list:${createHash('sha256').update(`${generation}\0${parent}`).digest('hex')}`;

/** Text positions preserve sibling byte order without a list-wide renumber. */
export const itemPosition = (segmentKey: string, orderKey: string) => `${segmentKey}-${orderKey}`;
export const ROLE_IRI: Record<string, string> = {
  group: `${RV}GroupRole`, chapter: `${RV}ChapterRole`, member: `${RV}MemberRole`,
  part: `${RV}PartRole`,
  mount: `${RV}MountRole`, navigation: `${RV}NavigationRole`, ingredient: `${RV}IngredientRole`,
  step: `${RV}StepRole`, equipment: `${RV}EquipmentRole`,
};

/** Persisted roles keep their IRIs. A registration's role uses the same Role suffix. */
export function roleIri(role: string): string {
  const known = ROLE_IRI[role];
  if (known) return known;
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(role)) throw new Error(`unknown occurrence role ${role}`);
  const pascal = role.split('-').map(part => part[0]!.toUpperCase() + part.slice(1)).join('');
  return `${RV}${pascal}Role`;
}

/** Inverse of roleIri. Persisted roles win; a registration role round-trips through its Role IRI. */
export function roleFromIri(uri: string): string | undefined {
  const known = Object.entries(ROLE_IRI).find(([, value]) => value === uri)?.[0];
  if (known) return known;
  if (!uri.startsWith(RV) || !uri.endsWith('Role')) return undefined;
  const pascal = uri.slice(RV.length, -'Role'.length);
  const role = pascal.replace(/[A-Z]/g, (letter, index) => `${index ? '-' : ''}${letter.toLowerCase()}`);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(role)) return undefined;
  return roleIri(role) === uri ? role : undefined;
}
export type BookRole = 'group' | 'chapter';

export { CompositionUnavailable } from './unavailable.ts';
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

export type Selection = { mode: 'follow-context' } | { mode: 'fixed-revision'; revision: string;
  selector?: ExactInstructionSelector };
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
  subtreeLevels?: number[];
  label?: Label;
  /** Every carried language; label is the first-label convenience for owners. */
  labels?: Label[];
  target?: string;
  selection?: Selection;
  qualifier?: OccurrenceRecord['qualifier'];
  /** Internal codec marker retained only while diffing an older graph projection. */
  qualifierProjection?: string;
  sourceKey?: string;
  introducedBy: string;
  removedBy?: string;
  /** A locally removed placement retains its prestate canonical RDF type. */
  tombstone?: boolean;
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
      GRAPH ${iri(GRAPHS.current)} { ${iri(structure)} a rv:Structure . }
      OPTIONAL {
        GRAPH ${iri(GRAPHS.current)} { ${iri(structure)} rv:structureProfile ?profile ;
          rv:structureOf ?component ; rv:structureHead ?head ; rv:selectedGeneration ?generation .
        ?generation rv:structure ${iri(structure)} ; rv:generationState rv:Active ;
          rv:placementCount ?count . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StructureRevision ;
          rv:component ${iri(structure)} ; rv:generation ?generation ; rv:manifest ?manifest . }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(value(row, 'manifest') ?? '')
    || !/^[0-9]+$/.test(value(row, 'count') ?? '') || !Number.isSafeInteger(Number(value(row, 'count')))
    || ['component', 'head', 'generation'].some(key => !NATIVE_ID.test(value(row, key) ?? ''))) {
    throw new CompositionCorrupt('Composition header is ambiguous');
  }
  let profile: ReturnType<typeof structureProfileForGraph>;
  try { profile = structureProfileForGraph(value(row, 'profile')!); }
  catch (cause) { throw new CompositionCorrupt('Composition profile is invalid', { cause }); }
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
  // Occurrence identity determines the placement IRI, so the read seeks that
  // subject. An unbound placement joined on the generation walks every member.
  const scope = 'occurrences' in selector
    ? `VALUES (?occurrence ?placement) { ${selector.occurrences.map(occurrence =>
      `(${iri(occurrence)} ${iri(placementIri(generation, occurrence))})`).join(' ')} }`
    : `?placement rv:orderSegment ${iri(selector.segment)} .`;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?placement ?occurrence ?type ?segment ?parent ?segmentKey ?orderKey ?role ?label
      ?item ?qualifierNode ?mode ?pinned ?selector ?sourceKey ?introducedBy ?removedBy ?lastParent WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${scope}
        ?placement rv:generation ${iri(generation)} ; rv:occurrence ?occurrence ; a ?type ;
          rv:occurrenceRole ?role .
        FILTER(?type IN (rv:OccurrencePlacement, rv:RemovedPlacement))
        ?occurrence rv:introducedBy ?introducedBy .
        OPTIONAL { ?placement rv:orderSegment ?segment ; rv:orderKey ?orderKey .
          ?segment rv:parent ?parent ; rv:segmentKey ?segmentKey . }
        OPTIONAL { ?placement rv:occurrenceLabel ?label }
        OPTIONAL { ?placement schema:item ?item }
        OPTIONAL { ?placement rv:qualifier ?qualifierNode }
        OPTIONAL { ?placement rv:selectionMode ?mode }
        OPTIONAL { ?placement rv:pinnedRevision ?pinned }
        OPTIONAL { ?placement rv:selectionSelector ?selector }
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
    const tombstone = value(row, 'type') === `${RV}OccurrencePlacement`
      && Boolean(value(row, 'removedBy'));
    const active = value(row, 'type') === `${RV}OccurrencePlacement` && !tombstone;
    const roleName = roleFromIri(value(row, 'role') ?? '');
    const role = (roleName ?? null) as OccurrenceRole | null;
    const mode = value(row, 'mode');
    const item = value(row, 'item');
    // A placement without a target carries its qualifier node, or itself, as the
    // list item; that is not a target, whichever role it has.
    const target = role && (registration.targetRoles.includes(role)
      || registration.optionalTargetRoles?.includes(role))
      && item !== occurrence && item !== value(row, 'qualifierNode') ? item : undefined;
    const labelLanguage = row.label?.['xml:lang'];
    const state: PlacementState = { occurrence, placement: value(row, 'placement')!, active,
      parent: active ? value(row, 'parent') ?? '' : value(row, 'lastParent') ?? '',
      role: role ?? 'group', introducedBy: value(row, 'introducedBy')!,
      ...(tombstone ? { tombstone: true } : {}),
      ...(active || tombstone ? { segment: value(row, 'segment'), segmentKey: value(row, 'segmentKey'),
        orderKey: value(row, 'orderKey') } : {}),
      ...(!active ? { removedBy: value(row, 'removedBy') } : {}),
      ...(row.label ? { label: { value: row.label.value, language: labelLanguage ?? '' } } : {}),
      ...(target ? { target } : {}),
      ...(mode === `${RV}FollowContext` ? { selection: { mode: 'follow-context' } }
        : mode === `${RV}FixedRevision` && value(row, 'pinned')
          ? { selection: { mode: 'fixed-revision', revision: value(row, 'selector')
            ? (JSON.parse(value(row, 'selector')!) as ExactInstructionSelector).revision : value(row, 'pinned')!,
          ...(value(row, 'selector') ? { selector: JSON.parse(value(row, 'selector')!) as ExactInstructionSelector } : {}) } } : {}),
      ...(value(row, 'sourceKey') ? { sourceKey: value(row, 'sourceKey') } : {}) };
    const catalogTarget = target !== undefined && catalogTargetTypes.includes(target);
    const needsSelection = target !== undefined && !catalogTarget
      && selectionRequiredRoles.includes(state.role);
    if (!role || !state.parent || ((active || tombstone) && !item) || ((active || tombstone)
      && (!state.segment || !state.orderKey || !state.segmentKey))
      || (!active && !state.removedBy) || needsSelection && !state.selection
      || state.selection && !needsSelection
        && (catalogTarget || !registration.selectionOptionalRoles?.includes(state.role))
      || (row.label && !labelLanguage)) {
      throw new CompositionCorrupt('Composition placement is incomplete');
    }
    const prior = byOccurrence.get(occurrence);
    if (prior && JSON.stringify({ ...prior, label: undefined, labels: undefined })
      !== JSON.stringify({ ...state, label: undefined, labels: undefined })) {
      throw new CompositionCorrupt('Composition placement is ambiguous');
    }
    const selected = prior ?? state;
    selected.labels ??= [];
    if (state.label && !selected.labels.some(label => label.value === state.label!.value && label.language === state.label!.language)) {
      if (selected.labels.some(label => label.language.toLowerCase() === state.label!.language.toLowerCase())) {
        throw new CompositionCorrupt('Composition labels repeat a language');
      }
      selected.labels.push(state.label);
    }
    if (selected.labels.length > 16) throw new CompositionCorrupt('Composition labels exceed their bound');
    selected.label = selected.labels[0];
    byOccurrence.set(occurrence, selected);
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

/** One exact segment or an indexed occurrence's segment; no sibling inventory. */
export async function readSegment(env: WorkActivationEnvironment, generation: string,
  selector: { segment: string } | { occurrence: string }): Promise<SegmentState> {
  const scope = 'segment' in selector ? `BIND(${iri(selector.segment)} AS ?segment)`
    : `${iri(placementIri(generation, selector.occurrence))} rv:orderSegment ?segment .`;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?segment ?parent ?key ?count WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${scope}
      ?segment a rv:OrderSegment ; rv:generation ${iri(generation)} ; rv:parent ?parent ;
        rv:segmentKey ?key ; rv:memberCount ?count . } } LIMIT 2`, 8192);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.segment || !rows[0].parent || !rows[0].key
    || !/^\d+$/.test(rows[0].count?.value ?? '')) throw new CompositionCorrupt('Composition order segment is ambiguous');
  return { segment: rows[0].segment.value, parent: rows[0].parent.value,
    key: rows[0].key.value, count: Number(rows[0].count!.value) };
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
    ...(state.subtreeLevels ? { subtreeLevels: state.subtreeLevels } : {}),
    ...(state.selection ? { selection: state.selection } : {}),
    ...(state.qualifier ? { qualifier: state.qualifier } : {}),
    labels: state.labels ?? (state.label ? [state.label] : []),
    ...(state.sourceKey ? { sourceKey: state.sourceKey } : {}),
    introducedBy: state.introducedBy, ...(state.removedBy ? { removedBy: state.removedBy } : {}) };
}

/** Staged replacement and restore already materialize validated topology. Derive
 * owner summaries there, rather than trusting counters supplied by an uploader. */
export function rebuildSubtreeLevels(records: readonly OccurrenceRecord[], structure: string,
  profile: StructureProfile): void {
  const byId = new Map(records.map(record => [record.occurrence, record]));
  const summaries = new Map<string, number[]>();
  for (const record of records) {
    if (record.state === 'active' && isContainerRole(profile, record.role)) {
      summaries.set(record.occurrence, Array<number>(STRUCTURE_LIMITS.maxDepth).fill(0));
    }
  }
  for (const record of records) {
    if (record.state !== 'active') continue;
    const seen = new Set([record.occurrence]);
    let parent = record.parent;
    for (let distance = 0; parent !== structure; distance++) {
      const owner = byId.get(parent), levels = summaries.get(parent);
      if (!owner || !levels || seen.has(parent) || distance >= STRUCTURE_LIMITS.maxDepth) {
        throw new CompositionCorrupt('Structure summary parent chain is unavailable or cyclic');
      }
      seen.add(parent);
      levels[distance] = levels[distance]! + 1;
      parent = owner.parent;
    }
  }
  for (const record of records) {
    const levels = summaries.get(record.occurrence);
    if (levels) record.subtreeLevels = levels;
    else delete record.subtreeLevels;
  }
}
