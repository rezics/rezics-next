/**
 * Owner-established disclosure contract (internal; never HTTP input).
 * GraphParentKind = 'work' | 'realm'. OwnerEstablishedGraphParents is a readonly
 * tuple of zero, one or two OwnerEstablishedGraphParent values: graph owner,
 * kind, exact native resource, current rv:head, optional Work protectedRevision,
 * and DisclosureRelationshipBasis. A basis contains owner, relationship kind,
 * exact resource/revision, targetResource/targetRevision, SHA-256 token and
 * dataEpoch. Context and legacy work/workRevision fields are lookup hints only.
 * DisclosureOccurrenceReference { owner, kind, resource, revision } selects an
 * authoritative receipt/placement/publication; it never proves ancestry.
 *
 * configureDisclosureAncestrySource(env, owner, source): void installs a trusted
 * source with read(targets) and reread(bases), both returning complete evidence
 * in input order. resolveDisclosureSelections(env, targets) brands and registers
 * immutable { target, ancestry } selections after bounded validation. Evidence
 * positively proves resourceKind ('realm'|'work'|'other'), relationshipBasis and
 * parents, including an independent publication's explicitly empty tuple.
 * captureDisclosure(env, selections, viewer, channel, client?): Promise<readonly
 * DisclosureReadCut[]> reads current parent heads and direct/parent policy in one
 * Access snapshot. A cut holds selection, parents and decision; parent descriptors
 * add fenceBasis { recoveryGeneration, enforcementCut }, obtained ONLY from Access
 * recovery_fence and site_moderation_basis(). fenceDisclosure(env, cuts, viewer,
 * channel, client?): Promise<DisclosureDecision[]> rereads those exact owner bases,
 * heads and Access policy; stale proof/cut discards hydration as unavailable.
 * Missing source/reader/evidence is unavailable, never visible. Realm closure is
 * only platform/global graph/record/null-revision disclosure and always hidden.
 *
 * DISCLOSURE_COST: batch=64, graphParents=2, parentEdges=128, parentHeadBatch=64,
 * ownerStatements=1, recoveryStatements=1 per batch; no descendant traversal.
 * All adapters must preserve the selected occurrence through capture/hydration/
 * final fence: threads/replies/counts carry discussed Work plus Realm; Content
 * carries exact revision and publication/placement; media carries exact use and
 * attachment; discovery/feed/notifications carry current source provenance;
 * Realm reads prove identity/pairing even for self-targets. Attached Zone owners
 * supply Realm ancestry only for mounted Realm parts, never their own pages.
 * WorkReadSession must register cuts and fence every session before completion,
 * including movingGraph/non-local sessions. Direct hidden maps to missing;
 * collection hidden is omitted before selection/counting/ranking.
 */
import type { Pool, PoolClient } from 'pg';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { GovernanceComponent, GovernanceOwner } from '../governance/store.ts';
import { GLOBAL_CONTEXT, governanceOwners, governanceComponents } from '../governance/schema.ts';
import { MediaUnavailable } from '../media/store.ts';
import { ANONYMOUS_VIEWER, eligible, validLabels, type Labels, type Viewer } from '../suitability/policy.ts';
import { mediaVisibility } from '../media/visibility.ts';
import { nameOwnerPolicySql } from '../preferences/store.ts';
import { BASELINE_MEMBER_POLICY } from '../access/baseline.ts';
import { accessClient } from '../access/topology-control.ts';
import { namePolicyViewerPrincipal } from './name-policy.ts';

export type DisclosureChannel = 'read' | 'summary' | 'thread' | 'feed' | 'search' | 'typeahead'
  | 'count' | 'inbox' | 'digest' | 'preview' | 'seo' | 'sitemap' | 'export' | 'media' | 'email' | 'push';
export const DISCLOSURE_CHANNELS: readonly DisclosureChannel[] = [
  'read', 'summary', 'thread', 'feed', 'search', 'typeahead', 'count', 'inbox',
  'digest', 'preview', 'seo', 'sitemap', 'export', 'media', 'email', 'push',
];
export type GraphParentKind = 'work' | 'realm';
export interface DisclosureRelationshipBasis {
  owner: 'graph' | 'content' | 'media' | 'review' | 'discovery';
  kind: 'identity' | 'work-ownership' | 'work-in-realm' | 'realm-placement' | 'realm-selection'
    | 'realm-module' | 'publication' | 'media-use';
  resource: string;
  revision: string;
  targetResource: string;
  targetRevision: string | null;
  token: string;
  dataEpoch: string;
}
export interface OwnerEstablishedGraphParent {
  owner: 'graph';
  kind: GraphParentKind;
  resource: string;
  head: string;
  protectedRevision?: string | null;
  relationshipBasis: DisclosureRelationshipBasis;
}
export type OwnerEstablishedGraphParents = readonly []
  | readonly [OwnerEstablishedGraphParent]
  | readonly [OwnerEstablishedGraphParent, OwnerEstablishedGraphParent];
const establishedAncestry: unique symbol = Symbol('disclosure.ancestry');
export interface OwnerEstablishedDisclosureAncestry {
  readonly [establishedAncestry]: true;
  readonly resourceKind: 'realm' | 'work' | 'other';
  readonly relationshipBasis: DisclosureRelationshipBasis;
  readonly parents: OwnerEstablishedGraphParents;
}
export interface DisclosureFenceBasis { recoveryGeneration: string; enforcementCut: string }
export interface DisclosureParentDescriptor extends OwnerEstablishedGraphParent {
  fenceBasis: DisclosureFenceBasis;
}
export interface DisclosureOccurrenceReference {
  owner: DisclosureRelationshipBasis['owner'];
  kind: DisclosureRelationshipBasis['kind'];
  resource: string;
  revision: string;
}
export interface DisclosureAncestryEvidence {
  resource: string;
  resourceKind: OwnerEstablishedDisclosureAncestry['resourceKind'];
  relationshipBasis: DisclosureRelationshipBasis;
  parents: OwnerEstablishedGraphParents;
  status: 'complete' | 'unavailable';
}
export interface DisclosureAncestrySource {
  read(targets: readonly DisclosureTarget[]): Promise<readonly DisclosureAncestryEvidence[]>;
  reread(bases: readonly DisclosureRelationshipBasis[]): Promise<readonly DisclosureAncestryEvidence[]>;
}
export interface DisclosureSelection {
  target: Omit<DisclosureTarget, 'work' | 'workRevision' | 'ancestry'>;
  ancestry: OwnerEstablishedDisclosureAncestry;
}
export interface DisclosureReadCut {
  selection: DisclosureSelection;
  parents: readonly DisclosureParentDescriptor[];
  fenceBasis: DisclosureFenceBasis;
  decision: DisclosureDecision;
}
export interface DisclosureTarget {
  owner: GovernanceOwner;
  resource: string;
  component: GovernanceComponent;
  /** A missing revision cannot prove that an exact-revision fence does not apply. */
  revision?: string | null;
  context?: string;
  /** Owner-established parent for governance fences and noninteractive delivery. */
  work?: string | null;
  workRevision?: string | null;
  occurrence?: DisclosureOccurrenceReference;
  /** Only issued selections may carry this internal proof to the policy reader. */
  ancestry?: OwnerEstablishedDisclosureAncestry;
  /** Owner-established Agent whose name this occurrence carries. Readability
   * of resource or work does not grant permission to disclose this name. */
  nameOwner?: string;
  /** The caller already settled name ownership, including proof that this
   * resource is not an Agent. The name-owner probe would only repeat that. */
  nameOwnerResolved?: boolean;
}
export type DisclosureDecision = 'visible' | 'tombstone' | 'hidden';
export interface DisclosureWithAnonymousNames {
  decisions: DisclosureDecision[];
  /** Same exact targets, revisions, context and channel at the same owner cut.
   * Only graph names/titles receive an anonymous classification. */
  anonymousNames: DisclosureDecision[];
}
export interface DisclosureReader {
  read(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient): Promise<DisclosureDecision[]>;
  readWithAnonymousNames?(targets: readonly DisclosureTarget[], viewer: Viewer,
    channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureWithAnonymousNames>;
  readAtCut?(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient, anonymousNames?: boolean): Promise<DisclosureWithAnonymousNames & {
      fenceBasis: DisclosureFenceBasis;
    }>;
}
export class DisclosureUnavailable extends MediaUnavailable {}
export const DISCLOSURE_COST = { batch: 64, ownerStatements: 1, recoveryStatements: 1,
  graphParents: 2, parentEdges: 128, parentHeadBatch: 64,
  nameOwnerQueries: 1, namePreferenceStatements: 1 } as const;
function requireBatch(items: readonly unknown[]): void {
  if (items.length > DISCLOSURE_COST.batch) throw new DisclosureUnavailable('Disclosure batch is invalid');
}
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ownerReference = /^(?:https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|urn:rezics:[A-Za-z0-9:._/-]{1,480})$/;
const effects = (channel: DisclosureChannel) => ['disclosure',
  ...(['search', 'typeahead', 'count', 'sitemap', 'seo'].includes(channel) ? ['search'] : []),
  ...(['email', 'push', 'digest'].includes(channel) ? ['raw_delivery'] : []),
  ...(channel === 'media' ? ['media_delivery', 'raw_delivery'] : []),
  ...(channel === 'export' ? ['export'] : [])];
const suitabilityChannel = (channel: DisclosureChannel) =>
  ['sitemap', 'seo'].includes(channel) ? 'index' as const
    : channel === 'preview' ? 'preview' as const
      : channel === 'digest' || channel === 'email' ? 'email' as const
        : channel === 'push' ? 'push' as const : 'read' as const;

/** Interactive clients render ratings against their current user state. Only
 * deliveries without that interaction apply an explicit channel default here. */
const usesSuitabilityDefault = (channel: DisclosureChannel) =>
  ['digest', 'preview', 'seo', 'sitemap', 'email', 'push'].includes(channel);

/** One indexed owner statement evaluates governance, strong Work read fences
 * and name preferences together; mixing independent policy cuts can disclose
 * a name even when those policies were never simultaneously permissive.
 * Noninteractive delivery also reads the direct target/parent suitability heads;
 * no descendants are traversed.
 * The recovery fence is held through evaluation; no policy result is cached.
 * Revocation fences future disclosure; independent bytes already delivered cannot be recalled. */
export class DisclosureStore implements DisclosureReader {
  constructor(private readonly pool: Pool) {}
  get environment(): WorkActivationEnvironment | undefined { return poolEnvironments.get(this.pool); }
  set environment(env: WorkActivationEnvironment | undefined) {
    if (env) poolEnvironments.set(this.pool, env);
    else poolEnvironments.delete(this.pool);
  }

  /** Read committed takes a new statement snapshot, including when the caller
   * lends an existing checkout. Snapshot isolation cannot fence newer policy. */
  async assertFinalSnapshot(client?: PoolClient): Promise<void> {
    await requireFreshSnapshot(client ?? accessClient(this.pool));
  }

  async read(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient) {
    if (!targets.length) return [];
    return (await this.readDecisions(targets, viewer, channel, false, client)).decisions;
  }

  async readWithAnonymousNames(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient): Promise<DisclosureWithAnonymousNames> {
    if (!targets.length) return { decisions: [], anonymousNames: [] };
    const { decisions, anonymousNames } = await this.readDecisions(targets, viewer, channel, true, client);
    return { decisions, anonymousNames };
  }

  readAtCut(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient, anonymousNames = false) {
    return this.readDecisions(targets, viewer, channel, anonymousNames, client);
  }

  private async readDecisions(targets: readonly DisclosureTarget[], viewer: Viewer,
    channel: DisclosureChannel, anonymousNames: boolean, client?: PoolClient):
    Promise<DisclosureWithAnonymousNames & { fenceBasis: DisclosureFenceBasis }> {
    requireBatch(targets);
    if (!DISCLOSURE_CHANNELS.includes(channel)
      || targets.some(target => !ownerReference.test(target.resource)
        || !governanceOwners.includes(target.owner) || !governanceComponents.includes(target.component)
        || target.work != null && !native.test(target.work)
        || !validIssuedTarget(target, this.environment)
        || target.nameOwner !== undefined && !native.test(target.nameOwner)
        || (target.context?.length ?? 0) > 512 || (target.revision?.length ?? 0) > 512)
      || typeof viewer.signedIn !== 'boolean' || !['unknown', 'under-15', '15-17', 'adult'].includes(viewer.age)
      || !viewer.optIns || typeof viewer.optIns.general !== 'boolean' || typeof viewer.optIns.r15 !== 'boolean'
      || typeof viewer.optIns.sexual !== 'boolean' || typeof viewer.optIns.grotesque !== 'boolean') {
      throw new DisclosureUnavailable('Disclosure batch is invalid');
    }
    if (!targets.length) throw new DisclosureUnavailable('An empty batch has no Access cut');
    const suitabilityDefault = usesSuitabilityDefault(channel);
    const source = client ?? accessClient(this.pool) ?? this.pool;
    try {
      const nameOwners = new Map<string, string>();
      const resources = [...new Set(targets.filter(target => target.owner === 'graph'
        && ['name', 'title'].includes(target.component) && !target.nameOwner
        && !target.nameOwnerResolved).map(target => target.resource))];
      if (resources.length && this.environment) {
        // Resolve only the exact named resources. Never walk credits, Works or
        // dependent Concepts to discover whether an Agent's name is private.
        const rows = (await this.environment.fuseki.query(`PREFIX rv: <${RV}>
          SELECT ?work ?head ?nameOwner WHERE {
            VALUES ?work { ${resources.map(iri).join(' ')} }
            OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
              { ?work rv:head ?head }
              UNION { ?work a rv:ZoneHomeDocument ; rv:homeDocumentHead ?head }
            } }
            OPTIONAL { VALUES ?work { ${resources.map(iri).join(' ')} }
              GRAPH ${iri(GRAPHS.current)} { ?work a rv:Agent }
              BIND(?work AS ?nameOwner) }
          } LIMIT ${resources.length + 1}`, 131_072)).results?.bindings ?? [];
        if (rows.length !== resources.length || new Set(rows.map(row => row.work?.value)).size !== resources.length
          || rows.some(row => !row.work || !resources.includes(row.work.value)
            || row.nameOwner && row.nameOwner.value !== row.work.value)) {
          throw new DisclosureUnavailable('Name ownership is unavailable');
        }
        for (const row of rows) if (row.nameOwner) nameOwners.set(row.work!.value, row.nameOwner.value);
      } else if (resources.length) {
        // Pool-only owner consumers still enforce privacy. Include inactive
        // Agents so they cannot inherit a public name after revocation.
        const rows = (await source.query<{ agent: string }>(`SELECT id AS agent
          FROM access.authority_subject WHERE id = ANY($1::text[]) AND kind = 'agent'`, [resources])).rows;
        if (rows.length > resources.length || new Set(rows.map(row => row.agent)).size !== rows.length
          || rows.some(row => !resources.includes(row.agent))) throw new DisclosureUnavailable('Name ownership is unavailable');
        for (const row of rows) nameOwners.set(row.agent, row.agent);
      }
      const owners = targets.map(target => target.nameOwner ?? nameOwners.get(target.resource));
      const distinct = [...new Set(owners.filter((owner): owner is string => owner !== undefined))];
      const principal = namePolicyViewerPrincipal(viewer, channel);
      // The recovery lock lives until this autocommit statement finishes;
      // policy and the fence share one snapshot, without six protocol calls.
      const rows = (await source.query<{ ordinal: number;
          open: boolean; restricted: boolean; realmClosed: boolean; assessments: Labels[];
          nameVisible: boolean; publicNameVisible: boolean; recoveryGeneration: string; enforcementCut: string
        }>(`
          -- The boolean primary key/check makes this a singleton. Spell out its
          -- bound before joining the batch: fresh owner statistics otherwise
          -- estimate thousands of fence rows and trigger costly per-read JIT.
          WITH fence AS MATERIALIZED (SELECT open, generation::text AS generation,
            access.site_moderation_basis() AS cut FROM access.recovery_fence WHERE id LIMIT 1 FOR SHARE),
          requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS wanted(
            ordinal int, owner text, resource text, component text, revision text, context text,
            "resourceKind" text, parents jsonb, "nameOwner" text)),
          parent_edges AS MATERIALIZED (SELECT wanted.ordinal, edge.* FROM requested wanted
            CROSS JOIN LATERAL jsonb_to_recordset(wanted.parents) AS edge(
              kind text, resource text, head text, "protectedRevision" text)),
          realm_candidates AS MATERIALIZED (SELECT ordinal,resource FROM requested WHERE "resourceKind" = 'realm'
            UNION ALL SELECT ordinal,resource FROM parent_edges WHERE kind = 'realm'),
          name_policy AS MATERIALIZED (${nameOwnerPolicySql(4, 5, 6, 7)})
          SELECT wanted.ordinal, fence.open, fence.generation AS "recoveryGeneration", fence.cut AS "enforcementCut",
            EXISTS (SELECT 1 FROM realm_candidates realm CROSS JOIN LATERAL (
              SELECT 1 FROM access.governance_enforcement e
              JOIN access.moderation_decision d ON d.id = e.decision_id
              JOIN access.moderation_decision_target t ON t.decision_id = e.decision_id
                AND t.ordinal = e.decision_ordinal
              WHERE e.owner = 'graph' AND e.resource = realm.resource
                AND e.state = 'restricted' AND e.component = 'record'
                AND e.revision IS NULL AND e.effect = 'disclosure' AND e.context = $3::text
                AND e.authority_scope_id = 'governance:platform' AND d.authority_kind = 'platform'
                AND d.authority_scope_id = 'governance:platform' AND d.context = $3::text
                AND t.owner = 'graph' AND t.resource = realm.resource AND t.component = 'record'
                AND t.locator IS NULL AND t.scope_kind = 'component'
                AND t.revision IS NULL AND t.effect = 'disclosure'
              LIMIT 1) matched WHERE realm.ordinal = wanted.ordinal) AS "realmClosed",
            CASE WHEN wanted."nameOwner" IS NULL THEN true
              ELSE COALESCE(n.visible AND n.open, false) END AS "nameVisible",
            CASE WHEN wanted."nameOwner" IS NULL THEN true
              ELSE COALESCE(n."publicVisible" AND n.open, false) END AS "publicNameVisible",
            EXISTS (SELECT 1 FROM (
              SELECT DISTINCT resource, owner FROM unnest(ARRAY[wanted.resource, right(wanted.resource, 36)]) resource
              CROSS JOIN unnest(ARRAY[wanted.owner, CASE
                WHEN wanted.component = 'body' AND wanted.owner = 'graph' THEN 'content'
                WHEN wanted.component = 'body' AND wanted.owner = 'content' THEN 'graph'
                ELSE wanted.owner END]) owner
              ) direct CROSS JOIN LATERAL (SELECT 1 FROM access.governance_enforcement e
              WHERE e.owner = direct.owner AND e.resource = direct.resource
                AND e.state = 'restricted' AND e.effect = ANY($2::text[])
                AND e.context = ANY(ARRAY[$3::text, wanted.context])
                AND ((e.resource = wanted.resource OR e.owner IN ('media', 'review')
                    AND e.resource = right(wanted.resource, 36)) AND (e.owner = wanted.owner
                  OR wanted.component = 'body' AND wanted.owner IN ('graph', 'content')
                    AND e.owner IN ('graph', 'content') AND e.component IN ('body', 'record', 'publication'))
                  AND (e.component = wanted.component OR e.component IN ('record', 'publication')
                    OR wanted.component IN ('title', 'name') AND e.component IN ('title', 'name')
                    OR wanted.owner = 'media' AND e.component IN ('cover', 'media_use', 'body'))
                  AND (e.revision IS NULL OR wanted.revision IS NULL OR e.revision = wanted.revision
                    OR wanted.component = 'body' AND e.owner IN ('graph', 'content')
                      AND replace(e.revision, 'urn:rezics:content:revision:', '')
                        = replace(wanted.revision, 'urn:rezics:content:revision:', '')))
                LIMIT 1) matched)
              OR EXISTS (SELECT 1 FROM parent_edges parent CROSS JOIN LATERAL (
                    SELECT 1 FROM access.governance_enforcement e
                    WHERE e.owner = 'graph' AND e.resource = parent.resource AND e.state = 'restricted'
                    AND e.effect = ANY($2::text[]) AND e.context = ANY(ARRAY[$3::text, wanted.context])
                    AND e.component IN ('title', 'name', 'record', 'publication')
                    AND (e.revision IS NULL OR e.revision = parent.head
                      OR parent."protectedRevision" IS NULL AND EXISTS (SELECT 1
                        FROM jsonb_array_elements(wanted.parents) p WHERE p->>'resource' = parent.resource
                          AND p ? 'protectedRevision')
                      OR e.revision = parent."protectedRevision") LIMIT 1) matched
                    WHERE parent.ordinal = wanted.ordinal AND parent.kind = 'work')
              OR EXISTS (SELECT 1 FROM (
                SELECT wanted.resource WHERE wanted."resourceKind" = 'work'
                UNION SELECT resource FROM parent_edges WHERE ordinal = wanted.ordinal AND kind = 'work'
                ) work_ref CROSS JOIN LATERAL (SELECT 1 FROM access.scope_gate gate
                  WHERE gate.id = 'work:read:' || work_ref.resource AND NOT gate.open LIMIT 1) matched) AS restricted,
            ${suitabilityDefault ? `COALESCE((SELECT jsonb_agg(head.labels) FROM
              (SELECT wanted.resource AS ref UNION SELECT resource FROM parent_edges
                WHERE ordinal = wanted.ordinal) refs
              CROSS JOIN LATERAL (SELECT a.labels FROM access.suitability_assessment a
                WHERE a.target = refs.ref ORDER BY a.revision_number DESC LIMIT 1) head), '[]'::jsonb)`
              : "'[]'::jsonb"} AS assessments
          FROM requested wanted CROSS JOIN fence LEFT JOIN name_policy n ON n.agent = wanted."nameOwner"
          ORDER BY wanted.ordinal`, [JSON.stringify(targets.map((target, ordinal) => ({
          ...target, ordinal, revision: target.revision ?? (target.owner === 'graph'
            && ['name', 'title'].includes(target.component)
            ? currentNameHead(target) : null),
          context: target.context ?? GLOBAL_CONTEXT,
          resourceKind: target.ancestry!.resourceKind,
          parents: target.ancestry!.parents,
          nameOwner: owners[ordinal] ?? null,
        }))), effects(channel), GLOBAL_CONTEXT, distinct, principal?.issuer ?? null,
        principal?.subject ?? null, BASELINE_MEMBER_POLICY])).rows;
        if (rows.length !== targets.length || rows.some((row, index) =>
            !row.open ||
            row.ordinal !== index
          || typeof row.restricted !== 'boolean' || !Array.isArray(row.assessments)
          || typeof row.realmClosed !== 'boolean' || !validFenceBasis(row)
          || row.recoveryGeneration !== rows[0]?.recoveryGeneration || row.enforcementCut !== rows[0]?.enforcementCut
          || anonymousNames && owners[index] !== undefined && typeof row.publicNameVisible !== 'boolean'
          || row.assessments.some(labels => !validLabels(labels)))) {
          throw new DisclosureUnavailable('Disclosure result is incomplete');
        }
        const decision = (row: typeof rows[number], index: number, audience: Viewer,
          nameVisible: boolean): DisclosureDecision => {
          if (row.realmClosed) return 'hidden';
          // A private name uses the existing indistinct unavailable outcome;
          // a tombstone would confirm the identity the policy withholds.
          if (owners[index] && nameVisible !== true) return 'hidden';
          if (!row.restricted && (!suitabilityDefault || row.assessments.every(labels => eligible({
            assessment: { status: 'assessed', labels }, viewer: audience, channel: suitabilityChannel(channel),
          }).eligible))) return 'visible';
          return ['read', 'summary', 'thread', 'feed', 'inbox'].includes(channel) ? 'tombstone' : 'hidden';
        };
        return {
          fenceBasis: { recoveryGeneration: rows[0]!.recoveryGeneration, enforcementCut: rows[0]!.enforcementCut },
          decisions: rows.map((row, index) => decision(row, index, viewer, row.nameVisible)),
          anonymousNames: anonymousNames ? rows.map((row, index) =>
            targets[index]!.owner === 'graph' && ['name', 'title'].includes(targets[index]!.component)
              ? decision(row, index, ANONYMOUS_VIEWER, row.publicNameVisible) : 'hidden') : [],
        };
    } catch (cause) {
      if (cause instanceof DisclosureUnavailable) throw cause;
      throw new DisclosureUnavailable('Disclosure owner is unavailable', { cause });
    }
  }
}

// Enumerable environment state survives spread copies and wrapped graph clients.
const owner = Symbol('disclosureOwner');
type ComposedEnvironment = WorkActivationEnvironment & { [owner]?: DisclosureReader };
export function hasDisclosure(env: WorkActivationEnvironment): boolean {
  return Boolean((env as ComposedEnvironment)[owner]);
}
const poolReaders = new WeakMap<Pool, DisclosureStore>();
// Composition binds the pool once; additional owner stores on that same pool
// still resolve current heads for notifications and reply counts.
const poolEnvironments = new WeakMap<Pool, WorkActivationEnvironment>();
// Graph-only target adapters must inherit the composed owner instead of creating
// an unconfigured environment that silently treats every assessment as absent.
const graphEnvironments = new WeakMap<object, WorkActivationEnvironment>();
export function disclosureGraphEnvironment(graph: object): WorkActivationEnvironment | undefined {
  return graphEnvironments.get(graph);
}
export function configureDisclosurePool(pool: Pool, reader: DisclosureStore): void {
  poolReaders.set(pool, reader);
}
export function disclosurePoolReader(pool: Pool): DisclosureStore | undefined {
  return poolReaders.get(pool);
}
export function configureDisclosure(env: WorkActivationEnvironment, reader: DisclosureReader | null): void {
  graphEnvironments.set(env.fuseki, env);
  if (reader) {
    (env as ComposedEnvironment)[owner] = reader;
    if (reader instanceof DisclosureStore) reader.environment = env;
  } else delete (env as ComposedEnvironment)[owner];
}
export function disclose(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer = ANONYMOUS_VIEWER, channel: DisclosureChannel = 'read', client?: PoolClient) {
  return discloseInventory(env, targets, viewer, channel, client);
}

/** Each caller bounds its inventory before owner or graph work begins. */
export async function discloseInventory(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureDecision[]> {
  return (await readInventory(env, targets, viewer, channel, false, client)).decisions;
}

/** Summary publicness shares the final owner's exact-target policy statement.
 * No decision survives this batch; adapters without the paired owner still
 * perform the required anonymous name probe. Media keeps its viewer audience. */
export function discloseInventoryWithAnonymousNames(env: WorkActivationEnvironment,
  targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel, client?: PoolClient) {
  return readInventory(env, targets, viewer, channel, true, client);
}

const ancestryOwner = Symbol('disclosureAncestry');
interface AncestryState {
  sources: Map<GovernanceOwner, DisclosureAncestrySource>;
  selections: WeakMap<OwnerEstablishedDisclosureAncestry, DisclosureSelection>;
  cuts: WeakMap<DisclosureReadCut, { heads: ReadonlyMap<string, string>; viewer: Viewer;
    audience: string; channel: DisclosureChannel; source: DisclosureAncestrySource; reader: DisclosureReader }>;
}
type AncestryEnvironment = WorkActivationEnvironment & { [ancestryOwner]?: AncestryState };
const issuedAncestry = new WeakMap<OwnerEstablishedDisclosureAncestry, DisclosureSelection>();
function ancestryState(env: WorkActivationEnvironment): AncestryState {
  const composed = env as AncestryEnvironment;
  return composed[ancestryOwner] ??= { sources: new Map(), selections: new WeakMap(), cuts: new WeakMap() };
}
export function configureDisclosureAncestrySource(env: WorkActivationEnvironment,
  sourceOwner: GovernanceOwner, source: DisclosureAncestrySource): void {
  if (!governanceOwners.includes(sourceOwner) || typeof source.read !== 'function' || typeof source.reread !== 'function') {
    throw new DisclosureUnavailable('Disclosure ancestry source is invalid');
  }
  ancestryState(env).sources.set(sourceOwner, source);
}
/** A relationship cannot prove independence by omitting its required parents. */
const relationshipParents = {
  identity: [], 'work-ownership': ['work'], 'work-in-realm': ['work', 'realm'],
  'realm-placement': ['realm'], 'realm-selection': ['realm'], 'realm-module': ['realm'],
  publication: [], 'media-use': [],
} as const satisfies Record<DisclosureRelationshipBasis['kind'], readonly GraphParentKind[]>;
function validRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
function validBasis(basis: DisclosureRelationshipBasis, env: WorkActivationEnvironment,
  target: DisclosureTarget): boolean {
  return !!basis && ['graph', 'content', 'media', 'review', 'discovery'].includes(basis.owner)
    && Object.hasOwn(relationshipParents, basis.kind) && ownerReference.test(basis.resource)
    && validRevision(basis.revision) && basis.targetResource === target.resource
    && basis.targetRevision === (target.revision ?? null) && /^[0-9a-f]{64}$/.test(basis.token)
    && basis.dataEpoch === env.lineage.dataEpoch;
}
function copyBasis(basis: DisclosureRelationshipBasis): DisclosureRelationshipBasis {
  return Object.freeze({ owner: basis.owner, kind: basis.kind, resource: basis.resource,
    revision: basis.revision, targetResource: basis.targetResource, targetRevision: basis.targetRevision,
    token: basis.token, dataEpoch: basis.dataEpoch });
}
function validateEvidence(env: WorkActivationEnvironment, target: DisclosureTarget,
  evidence: DisclosureAncestryEvidence): Omit<OwnerEstablishedDisclosureAncestry, typeof establishedAncestry> {
  if (!evidence || evidence.status !== 'complete' || evidence.resource !== target.resource
    || !['realm', 'work', 'other'].includes(evidence.resourceKind)
    || !validBasis(evidence.relationshipBasis, env, target) || !Array.isArray(evidence.parents)
    || evidence.parents.length > DISCLOSURE_COST.graphParents
    || !(relationshipParents[evidence.relationshipBasis.kind] as readonly GraphParentKind[])
      .every(kind => evidence.parents.some(parent => parent.kind === kind))
    || new Set(evidence.parents.map(parent => parent.resource)).size !== evidence.parents.length
    || new Set(evidence.parents.map(parent => parent.kind)).size !== evidence.parents.length
    || evidence.parents.some(parent => !parent || parent.owner !== 'graph'
      || !['work', 'realm'].includes(parent.kind) || !native.test(parent.resource) || !validRevision(parent.head)
      || !validBasis(parent.relationshipBasis, env, target)
      || parent.protectedRevision !== undefined && (parent.kind !== 'work'
        || parent.protectedRevision !== null && !validRevision(parent.protectedRevision)))
    || evidence.resourceKind !== 'other' && !native.test(target.resource)
    || target.occurrence && (evidence.relationshipBasis.owner !== target.occurrence.owner
      || evidence.relationshipBasis.kind !== target.occurrence.kind
      || evidence.relationshipBasis.resource !== target.occurrence.resource
      || evidence.relationshipBasis.revision !== target.occurrence.revision)
    || target.work && !evidence.parents.some(parent => parent.kind === 'work' && parent.resource === target.work
      && (target.workRevision === undefined || parent.protectedRevision === target.workRevision))
    || target.workRevision !== undefined && (target.work != null
      || evidence.parents.some(parent => parent.kind === 'work'))
      && !evidence.parents.some(parent => parent.kind === 'work'
      && parent.protectedRevision === target.workRevision)) {
    throw new DisclosureUnavailable('Disclosure ancestry is incomplete');
  }
  const parents = Object.freeze(evidence.parents.map(parent => Object.freeze({ owner: parent.owner,
    kind: parent.kind, resource: parent.resource, head: parent.head,
    ...(parent.protectedRevision !== undefined ? { protectedRevision: parent.protectedRevision } : {}),
    relationshipBasis: copyBasis(parent.relationshipBasis),
  }))) as OwnerEstablishedGraphParents;
  return { resourceKind: evidence.resourceKind, relationshipBasis: copyBasis(evidence.relationshipBasis), parents };
}
function validIssuedTarget(target: DisclosureTarget, env?: WorkActivationEnvironment): boolean {
  const selection = target.ancestry && issuedAncestry.get(target.ancestry);
  return !!selection && (!env || ancestryState(env).selections.get(selection.ancestry) === selection)
    && JSON.stringify(selection.target) === JSON.stringify(stripAncestry(target));
}
function stripAncestry(target: DisclosureTarget): DisclosureSelection['target'] {
  const { work: _work, workRevision: _workRevision, ancestry: _ancestry, ...selected } = target;
  return selected;
}
function validFenceBasis(basis: DisclosureFenceBasis): boolean {
  return typeof basis.recoveryGeneration === 'string' && /^\d+$/.test(basis.recoveryGeneration)
    && typeof basis.enforcementCut === 'string' && /^[0-9a-f]{64}$/.test(basis.enforcementCut);
}
function currentNameHead(target: DisclosureTarget): string | null {
  const ancestry = target.ancestry!;
  return ancestry.resourceKind !== 'other' && ancestry.relationshipBasis.kind === 'identity'
    && ancestry.relationshipBasis.resource === target.resource
    ? ancestry.relationshipBasis.revision
    : ancestry.parents.find(parent => parent.kind === 'work' && parent.resource === target.resource)?.head ?? null;
}
function requireReader(env: WorkActivationEnvironment): DisclosureReader & Required<Pick<DisclosureReader, 'readAtCut'>> {
  const reader = (env as ComposedEnvironment)[owner];
  if (!reader?.readAtCut) throw new DisclosureUnavailable('Disclosure cut reader is unavailable');
  return reader as DisclosureReader & Required<Pick<DisclosureReader, 'readAtCut'>>;
}
/** No omitted descriptor means independent publication. Only the selected owner
 * may positively establish that result, including the current source revision. */
export async function resolveDisclosureSelections(env: WorkActivationEnvironment,
  targets: readonly DisclosureTarget[]): Promise<readonly DisclosureSelection[]> {
  requireBatch(targets);
  const state = ancestryState(env);
  const selected: DisclosureSelection[] = [];
  try {
    for (const sourceOwner of new Set(targets.map(target => target.owner))) {
      const source = state.sources.get(sourceOwner);
      if (!source) throw new DisclosureUnavailable('Disclosure ancestry source is unavailable');
      const indexes = targets.flatMap((target, index) => target.owner === sourceOwner ? [index] : []);
      const evidence = await source.read(indexes.map(index => targets[index]!));
      if (evidence.length !== indexes.length) throw new DisclosureUnavailable('Disclosure ancestry result is incomplete');
      indexes.forEach((index, ordinal) => {
        const target = targets[index]!;
        if (!ownerReference.test(target.resource) || !governanceComponents.includes(target.component)) {
          throw new DisclosureUnavailable('Disclosure target is invalid');
        }
        const ancestry = Object.freeze({ ...validateEvidence(env, target, evidence[ordinal]!),
          [establishedAncestry]: true as const });
        const clean = stripAncestry(target);
        const selection = Object.freeze({ target: Object.freeze({ ...clean,
          ...(clean.occurrence ? { occurrence: Object.freeze({ ...clean.occurrence }) } : {}) }), ancestry });
        selected[index] = selection;
      });
    }
    // Register only after the entire ordered batch has been established.
    for (const selection of selected) {
      state.selections.set(selection.ancestry, selection);
      issuedAncestry.set(selection.ancestry, selection);
    }
    return Object.freeze(selected);
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure ancestry source is unavailable', { cause });
  }
}
function requireSelections(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]): void {
  requireBatch(selections);
  if (selections.some(selection => !selection
    || ancestryState(env).selections.get(selection.ancestry) !== selection)) {
    throw new DisclosureUnavailable('Disclosure selection was not established by its owner');
  }
}
async function currentHeads(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]) {
  const resources = [...new Set(selections.flatMap(selection => [
    ...selection.ancestry.parents.map(parent => parent.resource),
    ...(selection.ancestry.resourceKind !== 'other' ? [selection.target.resource] : []),
  ]))];
  const heads = new Map<string, string>();
  try {
    for (let offset = 0; offset < resources.length; offset += DISCLOSURE_COST.parentHeadBatch) {
      const batch = resources.slice(offset, offset + DISCLOSURE_COST.parentHeadBatch);
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?resource ?head WHERE { VALUES ?resource { ${batch.map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          GRAPH ${iri(GRAPHS.current)} {
            { ?resource rv:head ?head }
            UNION { ?resource a rv:ZoneHomeDocument ; rv:homeDocumentHead ?head }
          }
        } LIMIT ${batch.length + 1}`, 131_072)).results?.bindings ?? [];
      if (rows.length !== batch.length || new Set(rows.map(row => row.resource?.value)).size !== batch.length
        || rows.some(row => !row.resource || !batch.includes(row.resource.value) || !validRevision(row.head?.value))) {
        throw new DisclosureUnavailable('Disclosure parent heads are incomplete');
      }
      for (const row of rows) heads.set(row.resource!.value, row.head!.value);
    }
    if (selections.some(selection => selection.ancestry.parents.some(parent => heads.get(parent.resource) !== parent.head)
      || selection.ancestry.resourceKind !== 'other' && selection.ancestry.relationshipBasis.kind === 'identity'
        && selection.ancestry.relationshipBasis.resource === selection.target.resource
        && heads.get(selection.target.resource) !== selection.ancestry.relationshipBasis.revision)) {
      throw new DisclosureUnavailable('Disclosure parent head moved');
    }
    return heads;
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure parent heads are unavailable', { cause });
  }
}
async function evaluateSelections(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[],
  viewer: Viewer, channel: DisclosureChannel, client: PoolClient | undefined, anonymousNames: boolean) {
  requireSelections(env, selections);
  const reader = requireReader(env);
  const targets = selections.map(selection => ({ ...selection.target, ancestry: selection.ancestry }));
  const mediaAllowed = await mediaVisibility(env, targets, viewer);
  try {
    const evaluated = await reader.readAtCut(targets, viewer, channel, client, anonymousNames);
    if (mediaAllowed.length !== targets.length || mediaAllowed.some(allowed => typeof allowed !== 'boolean')
      || evaluated.decisions.length !== targets.length || !validFenceBasis(evaluated.fenceBasis)
      || evaluated.decisions.some(decision => !['visible', 'hidden', 'tombstone'].includes(decision))
      || anonymousNames && (evaluated.anonymousNames.length !== targets.length
        || evaluated.anonymousNames.some(decision => !['visible', 'hidden', 'tombstone'].includes(decision)))) {
      throw new DisclosureUnavailable('Disclosure cut result is incomplete');
    }
    return { ...evaluated, decisions: evaluated.decisions.map((decision, index) => mediaAllowed[index] ? decision : 'hidden'),
      anonymousNames: evaluated.anonymousNames.map((decision, index) => mediaAllowed[index] ? decision : 'hidden') };
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure cut reader is unavailable', { cause });
  }
}
export async function captureDisclosure(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<readonly DisclosureReadCut[]> {
  requireSelections(env, selections);
  requireReader(env);
  if (!selections.length) return [];
  await rereadRelationships(env, selections);
  const heads = await currentHeads(env, selections);
  const evaluated = await evaluateSelections(env, selections, viewer, channel, client, false);
  const fenceBasis = Object.freeze({ ...evaluated.fenceBasis });
  const state = ancestryState(env);
  return Object.freeze(selections.map((selection, index) => {
    const cut = Object.freeze({ selection, parents: Object.freeze(selection.ancestry.parents.map(parent =>
      Object.freeze({ ...parent, fenceBasis }))), fenceBasis, decision: evaluated.decisions[index]! });
    const dependencies = new Set([
      ...selection.ancestry.parents.map(parent => parent.resource),
      ...(selection.ancestry.resourceKind !== 'other' ? [selection.target.resource] : []),
    ]);
    state.cuts.set(cut, { heads: new Map([...heads].filter(([resource]) => dependencies.has(resource))),
      viewer, audience: JSON.stringify(viewer), channel,
      source: state.sources.get(selection.target.owner)!, reader: requireReader(env) });
    return cut;
  }));
}
async function rereadRelationships(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]) {
  for (const sourceOwner of new Set(selections.map(selection => selection.target.owner))) {
    const indexes = selections.flatMap((selection, index) => selection.target.owner === sourceOwner ? [index] : []);
    const source = ancestryState(env).sources.get(sourceOwner);
    if (!source) throw new DisclosureUnavailable('Disclosure ancestry source is unavailable');
    try {
      const evidence = await source.reread(indexes.map(index => selections[index]!.ancestry.relationshipBasis));
      if (evidence.length !== indexes.length) throw new DisclosureUnavailable('Disclosure final ancestry is incomplete');
      for (const [ordinal, index] of indexes.entries()) {
        const original = selections[index]!;
        const fresh = validateEvidence(env, original.target, evidence[ordinal]!);
        const { resourceKind, relationshipBasis, parents } = original.ancestry;
        if (JSON.stringify(fresh) !== JSON.stringify({ resourceKind, relationshipBasis, parents })) {
          throw new DisclosureUnavailable('Disclosure relationship moved');
        }
      }
    } catch (cause) {
      if (cause instanceof DisclosureUnavailable) throw cause;
      throw new DisclosureUnavailable('Disclosure ancestry source is unavailable', { cause });
    }
  }
}
/** Revalidate the original selected occurrence, never seek an alternate public
 * placement. A failed reread cannot turn a confirmed hidden cut into visible. */
export async function fenceDisclosure(env: WorkActivationEnvironment, cuts: readonly DisclosureReadCut[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureDecision[]> {
  requireBatch(cuts);
  const state = ancestryState(env), reader = requireReader(env);
  const saved = cuts.map(cut => {
    const saved = state.cuts.get(cut);
    if (!saved || saved.viewer !== viewer || saved.audience !== JSON.stringify(viewer) || saved.channel !== channel
      || saved.reader !== reader || saved.source !== state.sources.get(cut.selection.target.owner)) {
      throw new DisclosureUnavailable('Disclosure cut was not captured for this audience');
    }
    return saved;
  });
  if (!cuts.length) return [];
  const selections = cuts.map(cut => cut.selection);
  try {
    if (reader instanceof DisclosureStore) await reader.assertFinalSnapshot(client);
    else await requireFreshSnapshot(client);
    await rereadRelationships(env, selections);
    const heads = await currentHeads(env, selections);
    if (saved.some(basis => [...basis.heads].some(([resource, head]) => heads.get(resource) !== head))) {
      throw new DisclosureUnavailable('Disclosure parent head moved');
    }
    const evaluated = await evaluateSelections(env, selections, viewer, channel, client, false);
    return evaluated.decisions.map((decision, index) => {
      if (cuts[index]!.decision === 'hidden' || decision === 'hidden') return 'hidden';
      if (JSON.stringify(evaluated.fenceBasis) !== JSON.stringify(cuts[index]!.fenceBasis)) {
        throw new DisclosureUnavailable('Disclosure enforcement cut moved');
      }
      return decision;
    });
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure final ancestry is unavailable', { cause });
  }
}
async function requireFreshSnapshot(client?: PoolClient): Promise<void> {
  if (!client) return;
  const rows = (await client.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows;
  if (rows.length !== 1 || rows[0]?.transaction_isolation !== 'read committed') {
    throw new DisclosureUnavailable('Disclosure final fence requires a fresh Access snapshot');
  }
}
async function readInventory(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel, anonymousNames: boolean, client?: PoolClient):
  Promise<DisclosureWithAnonymousNames & { anonymousNameProbes: number }> {
  requireBatch(targets);
  requireReader(env);
  const decisions: DisclosureDecision[] = [], names: DisclosureDecision[] = [];
  for (let offset = 0; offset < targets.length; offset += DISCLOSURE_COST.batch) {
    const selections = await resolveDisclosureSelections(env, targets.slice(offset, offset + DISCLOSURE_COST.batch));
    await currentHeads(env, selections);
    const evaluated = await evaluateSelections(env, selections, viewer, channel, client, anonymousNames);
    decisions.push(...evaluated.decisions);
    names.push(...evaluated.anonymousNames);
  }
  return { decisions, anonymousNames: names, anonymousNameProbes: 0 };
}
