import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, ID, RV, iri } from '../work/activate.ts';
import { ContentErasureInvalid, MAX_CONTENT_ERASURE_TARGETS, readContentErasureTargets } from './content.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESOURCE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

/**
 * Graph revision kinds whose reads already hide `rv:ErasedRevision`.
 * `semantic_revision` is the existing journal kind for a semantic component.
 * Each of these is erasable in production because its subject is a revision IRI
 * the purge campaign removes. A class that identity resolution does not name stays closed.
 */
export const GRAPH_ERASURE_KINDS = ['text_contribution_draft', 'semantic_revision', 'release_revision',
  'work_head', 'composition_revision', 'home_document_revision'] as const;
export type GraphErasureKind = typeof GRAPH_ERASURE_KINDS[number];

export function isGraphErasureKind(kind: string): kind is GraphErasureKind {
  return (GRAPH_ERASURE_KINDS as readonly string[]).includes(kind);
}

/**
 * Who may erase a revision: the existing `erasure.request` admission on
 * `erasure:{resourceId}`. Identity resolution is the only per-kind step;
 * the resource it names is the admission scope:
 * content revision and Work head — the Work;
 * text-contribution draft, published or not — the TextContribution;
 * semantic component — the component;
 * release, including a fixed release whose revision is itself — the Release;
 * composition — the Structure.
 * A historical revision resolves from its own anchor, not from the current head.
 */
export const ERASURE_REVISION_RESOURCES = {
  content_revision: 'work',
  text_contribution_draft: 'text-contribution',
  semantic_revision: 'semantic-component',
  release_revision: 'release',
  work_head: 'work',
  composition_revision: 'structure',
  home_document_revision: 'home-document',
} as const;

export interface ResolvedErasureRevision {
  kind: 'content_revision' | GraphErasureKind;
  /** Journal ref: the revision UUID. */
  ref: string;
  /** Owner resource the erasure admission must name. */
  resourceId: string;
  /** Exact graph subject the shared tombstone names. */
  graphIri: string;
  /** Contribution draft component manifest, captured with anchor identity. */
  manifest?: string;
  /** The revision already carries `rv:ErasedRevision` or a Content tombstone. */
  erased: boolean;
  /** Content pin state from the same statement as identity. Absent for a graph kind. */
  content?: { availability: string; pendingPin: boolean; activePin: boolean;
    erasureId: string | null; erasureEpoch: string | null };
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Canonical graph-command ids: Content UUIDs stay UUIDs; other kinds are their revision IRIs. */
export function graphRevisionIds(targets: readonly { kind: string; ref: string }[]): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    if (target.kind === 'content_revision') ids.push(target.ref);
    else if (isGraphErasureKind(target.kind)) ids.push(`${ID}${target.ref}`);
  }
  return ids;
}

const SPECIFIC = ['ReleaseRevision', 'StructureRevision', 'SemanticRevision', 'DefinitionRevision',
  'RealizationRevision', 'EditorialControlRevision', 'FixedRelease', 'ZoneHomeRevision']
  .map(name => `rv:${name}`).join(' ');

function identityQuery(revisions: readonly string[]): string {
  const values = revisions.map(iri).join(' ');
  const anchor = `GRAPH ${iri(GRAPHS.revisions)} {
    ?revision a rv:RevisionAnchor ; rv:component ?owner .
    FILTER NOT EXISTS { ?revision a ?specific . VALUES ?specific { ${SPECIFIC} } } }`;
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?revision ?kind ?owner ?manifest ?erased WHERE {
      VALUES ?revision { ${values} }
      { GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:ReleaseRevision ; rv:component ?owner . }
        BIND("release_revision" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:FixedRelease . }
        BIND(?revision AS ?owner) BIND("release_revision" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:StructureRevision ; rv:component ?owner . }
        BIND("composition_revision" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:SemanticRevision ; rv:component ?owner . }
        BIND("semantic_revision" AS ?kind) }
      UNION { GRAPH ${iri(GRAPHS.revisions)} {
          ?revision a rv:ZoneHomeRevision, rv:RevisionAnchor ; rv:component ?owner . }
        BIND("home_document_revision" AS ?kind) }
      UNION { ${anchor}
        GRAPH ${iri(GRAPHS.current)} { ?owner a schema:CreativeWork . }
        BIND("work_head" AS ?kind) }
      UNION { ${anchor}
        GRAPH ${iri(GRAPHS.current)} { ?owner a rv:TextContribution . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:manifest ?manifest . }
        BIND("text_contribution_draft" AS ?kind) }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } } AS ?erased)
    } LIMIT ${revisions.length * 2 + 1}`;
}

function refuse(message: string): never {
  throw new ContentErasureInvalid(message);
}

/** Every retained cut selecting an exact Content revision is suppressed with it.
 * One H per publication cut; the existing graph command admits at most 64 total
 * targets, so an oversized closure is refused before the journal is written.
 * Legacy Zone-owned variants remain valid through their publication-owned Z→P
 * association until the next save creates a P-owned variant. */
export async function inventoryZoneHomeRevisionTargets(fuseki: Pick<FusekiClient, 'query'>,
  revisions: readonly ResolvedErasureRevision[]): Promise<ResolvedErasureRevision[]> {
  const content = revisions.filter(revision => revision.kind === 'content_revision');
  if (!content.length) return [];
  const values = content.map(revision => `(${iri(revision.graphIri)} ${iri(revision.resourceId)})`).join(' ');
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT DISTINCT ?revision ?owner ?erased ?owned WHERE {
      VALUES (?contentRevision ?requestedOwner) { ${values} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?revision a rv:ZoneHomeRevision, rv:RevisionAnchor ; rv:component ?owner ; rv:publishedPage ?binding .
        ?binding rv:contentRevision ?contentRevision ; rv:page ?page . }
      BIND((sameTerm(?owner, ?requestedOwner) && sameTerm(?page, ?owner)) ||
        (sameTerm(?page, ?requestedOwner) && EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ?requestedOwner a rv:Zone ; rv:homeDocument ?owner . } }) AS ?owned)
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } } AS ?erased)
      FILTER(!?erased)
    } ORDER BY ?revision LIMIT ${MAX_CONTENT_ERASURE_TARGETS + 1}`, 65_536);
  const rows = result.results?.bindings;
  if (!rows || rows.length > MAX_CONTENT_ERASURE_TARGETS) refuse('Home revision erasure inventory exceeds 64 references');
  const targets = new Map<string, ResolvedErasureRevision>();
  for (const row of rows) {
    const revision = row.revision?.value ?? '', owner = row.owner?.value ?? '';
    const bool = (key: string): boolean | null => {
      const term = row[key];
      return term?.type === 'literal' && term.datatype === XSD_BOOLEAN
        && ['true', 'false'].includes(term.value) ? term.value === 'true' : null;
    };
    if (row.revision?.type !== 'uri' || !RESOURCE.test(revision)
      || row.owner?.type !== 'uri' || !RESOURCE.test(owner)
      || bool('owned') !== true || bool('erased') === null) {
      refuse('Home revision erasure inventory is ambiguous');
    }
    // A different selected language may already have suppressed this whole cut.
    // Its retained tombstone belongs to that earlier erasure, never to this one.
    if (bool('erased') === true) continue;
    const prior = targets.get(revision);
    if (prior && prior.resourceId !== owner) refuse('Home revision erasure identity is ambiguous');
    targets.set(revision, { kind: 'home_document_revision', ref: revision.slice(ID.length),
      graphIri: revision, resourceId: owner, erased: bool('erased') === true });
  }
  if (new Set([...revisions.map(revision => revision.graphIri), ...targets.keys()]).size
    > MAX_CONTENT_ERASURE_TARGETS) refuse('Home revision erasure closure exceeds 64 targets');
  return [...targets.values()];
}

/**
 * Map each requested revision UUID to its owner resource and graph subject.
 * Content rows win when the UUID is a Content revision; every other id is read
 * from its own revision anchor. An already erased revision returns the same
 * identity. The wrong owner, an unknown id and two different kinds are refused.
 */
export async function resolveErasureRevisions(content: Queryable,
  fuseki: Pick<FusekiClient, 'query'>, resourceId: string,
  revisionIds: readonly string[]): Promise<ResolvedErasureRevision[]> {
  if (!RESOURCE.test(resourceId) || !revisionIds.length || revisionIds.length > MAX_CONTENT_ERASURE_TARGETS
    || new Set(revisionIds).size !== revisionIds.length || revisionIds.some(id => !UUID.test(id))) {
    refuse('Erasure revision targets are invalid');
  }
  // Identity is the target read: owner, availability and pins, not a second statement.
  const stored = await readContentErasureTargets(content, revisionIds);
  if (new Set(stored.map(row => row.id)).size !== stored.length) refuse('Erasure revision identity is ambiguous');
  const contentById = new Map(stored.map(row => [row.id, row]));
  for (const row of stored) {
    if (row.resource_id !== resourceId) refuse('Erasure revision belongs to another owner');
  }
  const graphIds = revisionIds.filter(id => !contentById.has(id));
  const graphById = new Map<string, ResolvedErasureRevision>();
  if (graphIds.length) {
    const result = await fuseki.query(identityQuery(graphIds.map(id => `${ID}${id}`)), 65_536);
    const rows = result.results?.bindings ?? [];
    if (rows.length > graphIds.length * 2) refuse('Erasure revision identity is ambiguous');
    for (const row of rows) {
      const revision = row.revision?.value ?? '';
      const kind = row.kind?.value ?? '';
      const owner = row.owner?.value ?? '';
      const manifest = row.manifest?.value;
      const erased = row.erased?.type === 'literal' && row.erased.datatype === XSD_BOOLEAN
        && (row.erased.value === 'true' || row.erased.value === 'false')
        ? row.erased.value === 'true' : null;
      const ref = revision.startsWith(ID) ? revision.slice(ID.length) : '';
      if (!graphIds.includes(ref) || !isGraphErasureKind(kind) || !RESOURCE.test(owner)
        || row.revision?.type !== 'uri' || row.revision.datatype !== undefined || row.revision['xml:lang'] !== undefined
        || row.kind?.type !== 'literal' || row.owner?.type !== 'uri'
        || row.owner.datatype !== undefined || row.owner['xml:lang'] !== undefined || erased === null) {
        refuse('Erasure revision identity is ambiguous');
      }
      if (kind === 'text_contribution_draft'
        && (row.manifest?.type !== 'uri' || row.manifest.datatype !== undefined
          || row.manifest['xml:lang'] !== undefined
          || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest ?? ''))) {
        refuse('Contribution revision manifest is unavailable');
      }
      const resolved: ResolvedErasureRevision = { kind, ref, resourceId: owner,
        graphIri: revision, ...(manifest ? { manifest } : {}), erased };
      const prior = graphById.get(ref);
      if (prior && (prior.kind !== resolved.kind || prior.resourceId !== resolved.resourceId
        || prior.graphIri !== resolved.graphIri || prior.manifest !== resolved.manifest)) {
        refuse('Erasure revision identity is ambiguous');
      }
      graphById.set(ref, { ...resolved, erased: Boolean(prior?.erased) || resolved.erased });
    }
  }
  const resolved = revisionIds.map(ref => {
    const row = contentById.get(ref);
    if (row) {
      return { kind: 'content_revision' as const, ref, resourceId: row.resource_id,
        graphIri: `urn:rezics:content:revision:${ref}`, erased: row.availability === 'erased',
        content: { availability: row.availability, pendingPin: row.pending_pin === true,
          activePin: row.active_pin === true, erasureId: row.erasure_id ?? null,
          erasureEpoch: row.erasure_epoch ?? null } };
    }
    const resolved = graphById.get(ref);
    if (!resolved) refuse('Erasure revision is unknown');
    if (resolved.resourceId !== resourceId) refuse('Erasure revision belongs to another owner');
    return resolved;
  });
  const homes = await inventoryZoneHomeRevisionTargets(fuseki, resolved);
  const ids = new Set(resolved.map(revision => revision.graphIri));
  return [...resolved, ...homes.filter(revision => !ids.has(revision.graphIri))];
}
