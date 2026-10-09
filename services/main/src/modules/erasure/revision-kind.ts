import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, ID, RV, iri } from '../work/activate.ts';
import { ContentErasureInvalid, MAX_CONTENT_ERASURE_TARGETS } from './content.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESOURCE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Graph revision kinds whose reads already hide `rv:ErasedRevision`.
 * `semantic_revision` is the existing journal kind for a semantic component.
 */
export const GRAPH_ERASURE_KINDS = ['text_contribution_draft', 'semantic_revision', 'release_revision',
  'work_head', 'composition_revision'] as const;
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
} as const;

export interface ResolvedErasureRevision {
  kind: 'content_revision' | GraphErasureKind;
  /** Journal ref: the revision UUID. */
  ref: string;
  /** Owner resource the erasure admission must name. */
  resourceId: string;
  /** Exact graph subject the shared tombstone names. */
  graphIri: string;
  /** The revision already carries `rv:ErasedRevision` or a Content tombstone. */
  erased: boolean;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

interface ContentRow { id: string; resource_id: string; availability: string }

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
  'RealizationRevision', 'EditorialControlRevision', 'FixedRelease']
  .map(name => `rv:${name}`).join(' ');

function identityQuery(revisions: readonly string[]): string {
  const values = revisions.map(iri).join(' ');
  const anchor = `GRAPH ${iri(GRAPHS.revisions)} {
    ?revision a rv:RevisionAnchor ; rv:component ?owner .
    FILTER NOT EXISTS { ?revision a ?specific . VALUES ?specific { ${SPECIFIC} } } }`;
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?revision ?kind ?owner ?erased WHERE {
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
      UNION { ${anchor}
        GRAPH ${iri(GRAPHS.current)} { ?owner a schema:CreativeWork . }
        BIND("work_head" AS ?kind) }
      UNION { ${anchor}
        GRAPH ${iri(GRAPHS.current)} { ?owner a rv:TextContribution . }
        BIND("text_contribution_draft" AS ?kind) }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } } AS ?erased)
    } LIMIT ${revisions.length * 2 + 1}`;
}

function refuse(message: string): never {
  throw new ContentErasureInvalid(message);
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
  const stored = (await content.query<ContentRow>(`SELECT r.id::text AS id, v.resource_id, r.availability
    FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
    WHERE r.id = ANY($1::uuid[])`, [revisionIds])).rows;
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
      const ref = revision.startsWith(ID) ? revision.slice(ID.length) : '';
      if (!graphIds.includes(ref) || !isGraphErasureKind(kind) || !RESOURCE.test(owner)
        || row.revision?.type !== 'uri' || row.owner?.type !== 'uri') {
        refuse('Erasure revision identity is ambiguous');
      }
      const resolved: ResolvedErasureRevision = { kind, ref, resourceId: owner,
        graphIri: revision, erased: row.erased?.value === 'true' };
      const prior = graphById.get(ref);
      if (prior && (prior.kind !== resolved.kind || prior.resourceId !== resolved.resourceId
        || prior.graphIri !== resolved.graphIri)) {
        refuse('Erasure revision identity is ambiguous');
      }
      graphById.set(ref, { ...resolved, erased: Boolean(prior?.erased) || resolved.erased });
    }
  }
  return revisionIds.map(ref => {
    const row = contentById.get(ref);
    if (row) {
      return { kind: 'content_revision' as const, ref, resourceId: row.resource_id,
        graphIri: `urn:rezics:content:revision:${ref}`, erased: row.availability === 'erased' };
    }
    const resolved = graphById.get(ref);
    if (!resolved) refuse('Erasure revision is unknown');
    if (resolved.resourceId !== resourceId) refuse('Erasure revision belongs to another owner');
    return resolved;
  });
}
