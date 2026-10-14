import { observeSearchPhase } from '../search/operation-evidence.ts';
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
 * recovery_fence and enforcement rows applying to the selection and its Work
 * and Realm parents, including whole-Realm closure. Unrelated restrictions do
 * not replay or refuse a read; global recovery generation still fences all cuts.
 * fenceDisclosure(env, cuts, viewer,
 * channel, client?): Promise<DisclosureDecision[]> rereads those exact owner bases,
 * heads and Access policy on a fresh statement snapshot; a lent snapshot-isolated
 * transaction is refused. Stale proof/cut discards hydration as unavailable.
 * Registered owners require complete source/reader/evidence. Unregistered owners
 * retain their legacy Work hints, inventory bounds and Access recovery fencing. Realm closure is
 * only platform/global graph/record/null-revision disclosure and always hidden.
 *
 * DISCLOSURE_COST: submissionLimit=2,048 (512 search matches x 3 descriptors = 1,536),
 * batch=64, graphParents=2, parentEdges=128, parentHeadBatch=64,
 * ownerStatements=1, recoveryStatements=1 per batch; no descendant traversal.
 * Every public submission accepts at most 2,048 targets before owner work and
 * processes ceil(N/64) chunks sequentially under the existing snapshot/client
 * rules. One result preserves input order and duplicates; one cost report sums
 * measured chunk costs. Cuts belong to each capture; fences recheck every chunk.
 * Inventory cost includes actual parentHeadQueries and optional name probes.
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
import { measureStatements, observeStatementPool } from '../../infrastructure/statement-cost.ts';
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
import { chunkDisclosureSubmission } from './contract-batching.ts';
import { DISCLOSURE_COST } from './contract-cost.ts';
import { SCOPED_ENFORCEMENT_BASIS_SQL } from './fence-scope.ts';
export { DISCLOSURE_COST } from './contract-cost.ts';

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
const legacyAncestry: unique symbol = Symbol('disclosure.legacy');
/** Retired as soon as this owner registers its authoritative source. */
export interface LegacyDisclosureAncestry {
  readonly [legacyAncestry]: true;
  readonly kind: 'legacy';
  readonly resourceKind: 'other';
  readonly parents: readonly [];
}
type DisclosureAncestry = OwnerEstablishedDisclosureAncestry | LegacyDisclosureAncestry;
function isLegacy(ancestry: DisclosureAncestry): ancestry is LegacyDisclosureAncestry {
  return legacyAncestry in ancestry;
}
export interface OwnerEstablishedDisclosureAncestry {
  readonly [establishedAncestry]: true;
  readonly resourceKind: 'realm' | 'work' | 'other';
  readonly relationshipBasis: DisclosureRelationshipBasis;
  readonly parents: OwnerEstablishedGraphParents;
}
export type DisclosureResults<T> = T[] & { readonly cost?: Readonly<Record<string, number>> };
function costedResults<T>(results: readonly T[], cost: Readonly<Record<string, number>>): DisclosureResults<T> {
  return Object.defineProperty([...results], 'cost', { value: Object.freeze({ ...cost }) });
}
async function measuredSubmission<T>(run: () => Promise<{ results: readonly T[];
  cost: Readonly<Record<string, number>> }>, client?: PoolClient) {
  const { result, statements } = await measureStatements(run, client);
  return { ...result, cost: { ...result.cost, statements } };
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
  target: Omit<DisclosureTarget, 'ancestry'>;
  ancestry: DisclosureAncestry;
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
  ancestry?: DisclosureAncestry;
  /** Owner-established Agent whose name this occurrence carries. Readability
   * of resource or work does not grant permission to disclose this name. */
  nameOwner?: string;
  /** The caller already settled name ownership, including proof that this
   * resource is not an Agent. The name-owner probe would only repeat that. */
  nameOwnerResolved?: boolean;
}
export type DisclosureDecision = 'visible' | 'tombstone' | 'hidden';
export interface DisclosureWithAnonymousNames {
  readonly cost?: Readonly<Record<string, number>>;
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
      /** Missing or incomplete cut evidence is unavailable to strict entries. */
      fenceBases?: readonly DisclosureFenceBasis[];
      cost?: Readonly<Record<string, number>>;
    }>;
}
export class DisclosureUnavailable extends MediaUnavailable {}
/** Require strict owner evidence when inspecting a selection's relationship basis. */
export function requireEstablishedAncestry(selection: Pick<DisclosureTarget, 'ancestry'>): OwnerEstablishedDisclosureAncestry {
  const ancestry = selection.ancestry;
  if (!ancestry || isLegacy(ancestry)) {
    throw new DisclosureUnavailable('Disclosure selection was not established by its owner');
  }
  return ancestry;
}
async function ownerSubmission<T, R>(legacy: boolean, inputs: readonly T[],
  run: (chunk: readonly T[], offset: number) => Promise<{ results: readonly R[]; cost: Readonly<Record<string, number>> }>,
  requireLegacySubmission: (inputs: readonly T[], results: readonly R[]) => void,
  snapshotLegacyInput: (input: T) => T) {
  if (!legacy) return chunkDisclosureSubmission(inputs, run);
  const accepted = Object.freeze(inputs.map(snapshotLegacyInput)), results: R[] = [], cost: Record<string, number> = {};
  for (let offset = 0; offset < accepted.length; offset += DISCLOSURE_COST.batch) {
    const chunk = Object.freeze(accepted.slice(offset, offset + DISCLOSURE_COST.batch));
    const submission = await run(chunk, offset);
    if (submission.results.length !== chunk.length) throw new DisclosureUnavailable('Disclosure chunk result is incomplete');
    results.push(...submission.results);
    for (const [counter, count] of Object.entries(submission.cost)) cost[counter] = (cost[counter] ?? 0) + count;
  }
  // A later chunk can register an owner whose legacy results were already read.
  requireLegacySubmission(accepted, results);
  return { results, cost };
}
function snapshotLegacyTarget(target: DisclosureTarget): DisclosureTarget {
  return Object.freeze({ ...target,
    ...(target.occurrence ? { occurrence: Object.freeze({ ...target.occurrence }) } : {}) });
}
function snapshotLegacyTargets(targets: readonly DisclosureTarget[]): readonly DisclosureTarget[] {
  return Object.freeze(targets.map(snapshotLegacyTarget));
}
function snapshotLegacySelection(env: WorkActivationEnvironment, selection: DisclosureSelection): DisclosureSelection {
  requireSelections(env, [selection]);
  // Issued selections already freeze the target and occurrence; retain their brand.
  return selection;
}
function snapshotLegacyCut(env: WorkActivationEnvironment, cut: DisclosureReadCut): DisclosureReadCut {
  if (!ancestryState(env).cuts.has(cut)) throw new DisclosureUnavailable('Disclosure cut was not captured');
  snapshotLegacySelection(env, cut.selection);
  // Captured cuts already freeze the selection, parent descriptors and fence basis.
  return cut;
}
function legacyPolicyTarget(target: DisclosureTarget): boolean {
  return !target.ancestry || isLegacy(target.ancestry);
}
function enforcementBasisSql(targets: readonly DisclosureTarget[]): string {
  if (targets.every(legacyPolicyTarget)) return "'" + '0'.repeat(64) + "'::text";
  if (targets.some(legacyPolicyTarget)) {
    return `CASE WHEN wanted.legacy THEN '${'0'.repeat(64)}'::text ELSE ${SCOPED_ENFORCEMENT_BASIS_SQL} END`;
  }
  return SCOPED_ENFORCEMENT_BASIS_SQL;
}
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
  constructor(private readonly pool: Pool) { observeStatementPool(pool); }
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
    if (!targets.length) return costedResults<DisclosureDecision>([], {});
    const result = await this.readSubmission(targets, viewer, channel, false, client);
    return costedResults(result.decisions, result.cost);
  }

  async readWithAnonymousNames(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient): Promise<DisclosureWithAnonymousNames> {
    if (!targets.length) return Object.defineProperty({ decisions: [], anonymousNames: [] },
      'cost', { value: Object.freeze({}) });
    const { decisions, anonymousNames, cost } = await this.readSubmission(targets, viewer, channel, true, client);
    return Object.defineProperty({ decisions, anonymousNames }, 'cost', { value: cost });
  }

  readAtCut(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel,
    client?: PoolClient, anonymousNames = false) {
    return this.readSubmission(targets, viewer, channel, anonymousNames, client);
  }

  private async readSubmission(targets: readonly DisclosureTarget[], viewer: Viewer,
    channel: DisclosureChannel, anonymousNames: boolean, client?: PoolClient) {
    const legacy = targets.every(legacyPolicyTarget);
    const submission = await ownerSubmission(legacy, targets, async chunk => measuredSubmission(async () => {
      const evaluated = await this.readDecisions(chunk, viewer, channel, anonymousNames, client);
      return { results: evaluated.decisions.map((decision, index) => {
        const result = { decision, name: evaluated.anonymousNames[index], fenceBasis: evaluated.fenceBases[index]! };
        return legacy ? Object.freeze({ ...result, fenceBasis: Object.freeze({ ...result.fenceBasis }) }) : result;
      }), cost: evaluated.cost };
    }, client), accepted => {
      if (accepted.some(target => !validPolicyTarget(target, this.environment))) {
        throw new DisclosureUnavailable('Disclosure selection was not established by its owner');
      }
    }, snapshotLegacyTarget);
    return { decisions: submission.results.map(result => result.decision),
      anonymousNames: anonymousNames ? submission.results.map(result => result.name!) : [],
      fenceBases: submission.results.map(result => result.fenceBasis), cost: submission.cost };
  }

  private async readDecisions(targets: readonly DisclosureTarget[], viewer: Viewer,
    channel: DisclosureChannel, anonymousNames: boolean, client?: PoolClient):
    Promise<DisclosureWithAnonymousNames & { fenceBases: readonly DisclosureFenceBasis[];
      cost: Readonly<Record<string, number>> }> {
    requireBatch(targets);
    if (!DISCLOSURE_CHANNELS.includes(channel)
      || targets.some(target => !ownerReference.test(target.resource)
        || !governanceOwners.includes(target.owner) || !governanceComponents.includes(target.component)
        || target.work != null && !native.test(target.work)
        || !validPolicyTarget(target, this.environment)
        || target.nameOwner !== undefined && !native.test(target.nameOwner)
        || (target.context?.length ?? 0) > 512 || (target.revision?.length ?? 0) > 512)
      || typeof viewer.signedIn !== 'boolean' || !['unknown', 'under-15', '15-17', 'adult'].includes(viewer.age)
      || !viewer.optIns || typeof viewer.optIns.general !== 'boolean' || typeof viewer.optIns.r15 !== 'boolean'
      || typeof viewer.optIns.sexual !== 'boolean' || typeof viewer.optIns.grotesque !== 'boolean') {
      throw new DisclosureUnavailable('Disclosure batch is invalid');
    }
    if (!targets.length) throw new DisclosureUnavailable('An empty batch has no Access cut');
    const identities = targets.map(target => JSON.stringify(target));
    const requireUnchangedTargets = () => {
      if (targets.length !== identities.length
        || targets.some((target, index) => JSON.stringify(target) !== identities[index])) {
        throw new DisclosureUnavailable('Disclosure target moved during policy lookup');
      }
    };
    const suitabilityDefault = usesSuitabilityDefault(channel);
    const source = client ?? accessClient(this.pool) ?? this.pool;
    let nameOwnerQueries = 0, nameOwnerStatements = 0;
    try {
      const nameOwners = new Map<string, string>();
      const resources = [...new Set(targets.filter(target => target.owner === 'graph'
        && ['name', 'title'].includes(target.component) && !target.nameOwner
        && !target.nameOwnerResolved).map(target => target.resource))];
      if (resources.length && this.environment) {
        nameOwnerQueries++;
        // Resolve only the exact named resources. Never walk credits, Works or
        // dependent Concepts to discover whether an Agent's name is private.
        const rows = (await observeSearchPhase('disclosure-exact-resource-name-ownership', () => this.environment!.fuseki.query(`PREFIX rv: <${RV}>
          SELECT ?work ?head ?nameOwner WHERE {
            VALUES ?work { ${resources.map(iri).join(' ')} }
            OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
              { ?work rv:head ?head }
              UNION { ?work a rv:ZoneHomeDocument ; rv:homeDocumentHead ?head }
            } }
            OPTIONAL { VALUES ?work { ${resources.map(iri).join(' ')} }
              GRAPH ${iri(GRAPHS.current)} { ?work a rv:Agent }
              BIND(?work AS ?nameOwner) }
          } LIMIT ${resources.length + 1}`, 131_072))).results?.bindings ?? [];
        if (rows.length !== resources.length || new Set(rows.map(row => row.work?.value)).size !== resources.length
          || rows.some(row => !row.work || !resources.includes(row.work.value)
            || row.nameOwner && row.nameOwner.value !== row.work.value)) {
          throw new DisclosureUnavailable('Name ownership is unavailable');
        }
        for (const row of rows) if (row.nameOwner) nameOwners.set(row.work!.value, row.nameOwner.value);
      } else if (resources.length) {
        nameOwnerStatements++;
        // Pool-only owner consumers still enforce privacy. Include inactive
        // Agents so they cannot inherit a public name after revocation.
        const rows = (await source.query<{ agent: string }>(`SELECT id AS agent
          FROM access.authority_subject WHERE id = ANY($1::text[]) AND kind = 'agent'`, [resources])).rows;
        if (rows.length > resources.length || new Set(rows.map(row => row.agent)).size !== rows.length
          || rows.some(row => !resources.includes(row.agent))) throw new DisclosureUnavailable('Name ownership is unavailable');
        for (const row of rows) nameOwners.set(row.agent, row.agent);
      }
      requireUnchangedTargets();
      if (targets.some(target => !validPolicyTarget(target, this.environment))) {
        throw new DisclosureUnavailable('Disclosure target moved during policy lookup');
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
          WITH fence AS MATERIALIZED (SELECT open, generation::text AS generation
            FROM access.recovery_fence WHERE id LIMIT 1 FOR SHARE),
          requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS wanted(
            ordinal int, owner text, resource text, component text, revision text, context text,
            "resourceKind" text, parents jsonb, work text, "workRevision" text, legacy boolean, "nameOwner" text)),
          parent_edges AS MATERIALIZED (SELECT wanted.ordinal, edge.* FROM requested wanted
            CROSS JOIN LATERAL jsonb_to_recordset(wanted.parents) AS edge(
              kind text, resource text, head text, "protectedRevision" text)),
          realm_candidates AS MATERIALIZED (SELECT ordinal,resource FROM requested WHERE "resourceKind" = 'realm'
            UNION ALL SELECT ordinal,resource FROM parent_edges WHERE kind = 'realm'),
          name_policy AS MATERIALIZED (${nameOwnerPolicySql(4, 5, 6, 7)})
          SELECT wanted.ordinal, fence.open, fence.generation AS "recoveryGeneration",
            ${enforcementBasisSql(targets)} AS "enforcementCut",
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
              OR EXISTS (SELECT 1 FROM access.governance_enforcement e
                WHERE wanted.legacy AND e.owner = 'graph' AND e.resource = wanted.work
                  AND (wanted.owner <> 'graph' OR wanted.work <> wanted.resource)
                  AND e.state = 'restricted' AND e.effect = ANY($2::text[])
                  AND e.context = ANY(ARRAY[$3::text, wanted.context])
                  AND e.component IN ('title', 'name', 'record', 'publication')
                  AND (e.revision IS NULL OR wanted."workRevision" IS NULL OR e.revision = wanted."workRevision"))
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
                UNION SELECT wanted.work WHERE wanted.legacy AND wanted.work IS NOT NULL
                UNION SELECT resource FROM parent_edges WHERE ordinal = wanted.ordinal AND kind = 'work'
                ) work_ref CROSS JOIN LATERAL (SELECT 1 FROM access.scope_gate gate
                  WHERE gate.id = 'work:read:' || work_ref.resource AND NOT gate.open LIMIT 1) matched) AS restricted,
            ${suitabilityDefault ? `COALESCE((SELECT jsonb_agg(head.labels) FROM
              (SELECT wanted.resource AS ref UNION SELECT wanted.work WHERE wanted.legacy AND wanted.work IS NOT NULL
                UNION SELECT resource FROM parent_edges
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
          legacy: legacyPolicyTarget(target),
          work: legacyPolicyTarget(target) ? target.work ?? null : null,
          resourceKind: target.ancestry?.resourceKind ?? 'other',
          parents: target.ancestry?.parents ?? [],
          nameOwner: owners[ordinal] ?? null,
        }))), effects(channel), GLOBAL_CONTEXT, distinct, principal?.issuer ?? null,
        principal?.subject ?? null, BASELINE_MEMBER_POLICY])).rows;
        requireUnchangedTargets();
        if (rows.length !== targets.length || rows.some((row, index) =>
            !row.open ||
            row.ordinal !== index
          || !validPolicyTarget(targets[index]!, this.environment)
          || typeof row.restricted !== 'boolean' || !Array.isArray(row.assessments)
          || typeof row.realmClosed !== 'boolean' || !validFenceBasis(row)
          || row.recoveryGeneration !== rows[0]?.recoveryGeneration
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
          fenceBases: rows.map(row => ({ recoveryGeneration: row.recoveryGeneration, enforcementCut: row.enforcementCut })),
          cost: { ownerStatements: 1, recoveryStatements: 1, statements: 1 + nameOwnerStatements,
            nameOwnerQueries, nameOwnerStatements },
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
  ancestryState(env);
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

/** The contract bounds and chunks the complete caller inventory before work. */
export async function discloseInventory(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureResults<DisclosureDecision>> {
  const result = await discloseInventoryWithCost(env, targets, viewer, channel, client);
  return costedResults(result.decisions, result.cost);
}

/** Cost comes from the established dependencies actually queried, rather than
 * request hints that can omit a Realm or repeat an already selected parent. */
export function discloseInventoryWithCost(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient) {
  return readInventory(env, targets, viewer, channel, false, client);
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
  selections: WeakMap<DisclosureAncestry, DisclosureSelection>;
  cuts: WeakMap<DisclosureReadCut, { heads: ReadonlyMap<string, string>; viewer: Viewer;
    audience: string; channel: DisclosureChannel; source: DisclosureAncestrySource | undefined;
    reader: DisclosureReader | undefined }>;
}
type AncestryEnvironment = WorkActivationEnvironment & { [ancestryOwner]?: AncestryState };
const issuedAncestry = new WeakMap<DisclosureAncestry, {
  selection: DisclosureSelection; environment: WorkActivationEnvironment;
}>();
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
/** Registration switches only this owner to the mandatory ancestry contract. */
function ownerHasAncestrySource(env: WorkActivationEnvironment | undefined, sourceOwner: GovernanceOwner): boolean {
  if (!governanceOwners.includes(sourceOwner)) throw new DisclosureUnavailable('Disclosure owner is invalid');
  return !!env && ancestryState(env).sources.has(sourceOwner);
}
function legacySelection(env: WorkActivationEnvironment, target: DisclosureTarget): DisclosureSelection {
  if (!ownerReference.test(target.resource) || !governanceComponents.includes(target.component)
    || target.work != null && !native.test(target.work) || target.ancestry
    || ownerHasAncestrySource(env, target.owner)) {
    throw new DisclosureUnavailable('Disclosure target is invalid');
  }
  const ancestry: LegacyDisclosureAncestry = Object.freeze({ [legacyAncestry]: true as const,
    kind: 'legacy', resourceKind: 'other', parents: Object.freeze([]) as readonly [] });
  return Object.freeze({ target: Object.freeze({ ...target,
    ...(target.occurrence ? { occurrence: Object.freeze({ ...target.occurrence }) } : {}) }), ancestry });
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
function hasRequiredParents(basis: DisclosureRelationshipBasis, parents: OwnerEstablishedGraphParents): boolean {
  return (relationshipParents[basis.kind] as readonly GraphParentKind[])
    .every(kind => parents.some(parent => parent?.kind === kind));
}
function validateEvidence(env: WorkActivationEnvironment, target: DisclosureTarget,
  evidence: DisclosureAncestryEvidence): Omit<OwnerEstablishedDisclosureAncestry, typeof establishedAncestry> {
  if (!evidence || evidence.status !== 'complete' || evidence.resource !== target.resource
    || !['realm', 'work', 'other'].includes(evidence.resourceKind)
    || !validBasis(evidence.relationshipBasis, env, target) || !Array.isArray(evidence.parents)
    || evidence.parents.length > DISCLOSURE_COST.graphParents
    || !hasRequiredParents(evidence.relationshipBasis, evidence.parents)
    || new Set(evidence.parents.map(parent => parent.resource)).size !== evidence.parents.length
    || new Set(evidence.parents.map(parent => parent.kind)).size !== evidence.parents.length
    || evidence.parents.some(parent => !parent || parent.owner !== 'graph'
      || !['work', 'realm'].includes(parent.kind) || !native.test(parent.resource) || !validRevision(parent.head)
      || !validBasis(parent.relationshipBasis, env, target)
      || !hasRequiredParents(parent.relationshipBasis, evidence.parents)
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
  const issued = target.ancestry && issuedAncestry.get(target.ancestry);
  const selection = issued?.selection;
  return !!selection && (!env || ancestryState(env).selections.get(selection.ancestry) === selection)
    && (!isLegacy(selection.ancestry) || !ownerHasAncestrySource(issued!.environment, target.owner)
      && !ownerHasAncestrySource(env, target.owner))
    && JSON.stringify(selection.target) === JSON.stringify(stripAncestry(target));
}
function validPolicyTarget(target: DisclosureTarget, env?: WorkActivationEnvironment): boolean {
  // Pool-only readers have no composition in which to establish an owner's
  // registration state; they still require an issued selection.
  return target.ancestry ? validIssuedTarget(target, env) : !!env && !ownerHasAncestrySource(env, target.owner);
}
function stripAncestry(target: DisclosureTarget): DisclosureSelection['target'] {
  const { ancestry: _ancestry, ...selected } = target;
  if (target.ancestry && isLegacy(target.ancestry)) return selected;
  const { work: _work, workRevision: _workRevision, ...strict } = selected;
  return strict;
}
function validFenceBasis(basis: DisclosureFenceBasis): boolean {
  return typeof basis.recoveryGeneration === 'string' && /^\d+$/.test(basis.recoveryGeneration)
    && typeof basis.enforcementCut === 'string' && /^[0-9a-f]{64}$/.test(basis.enforcementCut);
}
function currentNameHead(target: DisclosureTarget): string | null {
  const ancestry = target.ancestry;
  if (!ancestry || isLegacy(ancestry)) return target.revision ?? null;
  return isGraphIdentity(target, ancestry)
    ? ancestry.relationshipBasis.revision
    : ancestry.parents.find(parent => parent.kind === 'work' && parent.resource === target.resource)?.head ?? null;
}
function isGraphIdentity(target: DisclosureTarget, ancestry: DisclosureAncestry): boolean {
  return !isLegacy(ancestry) && target.owner === 'graph' && ancestry.relationshipBasis.owner === 'graph'
    && ancestry.relationshipBasis.kind === 'identity' && ancestry.relationshipBasis.resource === target.resource;
}
function headDependencies(selection: DisclosureSelection): string[] {
  if (isLegacy(selection.ancestry)) return [];
  return [
    ...selection.ancestry.parents.map(parent => parent.resource),
    ...(selection.ancestry.resourceKind !== 'other' || isGraphIdentity(selection.target, selection.ancestry)
      ? [selection.target.resource] : []),
  ];
}
function requireReader(env: WorkActivationEnvironment): DisclosureReader & Required<Pick<DisclosureReader, 'readAtCut'>> {
  const reader = (env as ComposedEnvironment)[owner];
  if (!reader?.readAtCut) throw new DisclosureUnavailable('Disclosure cut reader is unavailable');
  return reader as DisclosureReader & Required<Pick<DisclosureReader, 'readAtCut'>>;
}
function selectionReader(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]) {
  return selections.some(selection => !isLegacy(selection.ancestry))
    ? requireReader(env) : (env as ComposedEnvironment)[owner];
}
// No Access owner existed in these legacy environments. This basis is never
// accepted for an established selection or used as evidence of Access recovery.
const unconfiguredLegacyFence = Object.freeze({ recoveryGeneration: '0', enforcementCut: '0'.repeat(64) });
/** No omitted descriptor means independent publication. Only the selected owner
 * may positively establish that result, including the current source revision. */
export async function resolveDisclosureSelections(env: WorkActivationEnvironment,
  targets: readonly DisclosureTarget[]): Promise<DisclosureResults<DisclosureSelection>> {
  const submission = await ownerSubmission(targets.every(target => !ownerHasAncestrySource(env, target.owner)), targets, async chunk => measuredSubmission(async () => ({
    results: await resolveDisclosureSelectionChunk(env, chunk),
    cost: { ancestryReads: new Set(chunk.map(target => target.owner)).size },
  })), (_accepted, results) => requireSelections(env, results), snapshotLegacyTarget);
  return costedResults(submission.results, submission.cost);
}
async function resolveDisclosureSelectionChunk(env: WorkActivationEnvironment,
  targets: readonly DisclosureTarget[]): Promise<readonly DisclosureSelection[]> {
  requireOwnerBatch(env, targets);
  if (targets.some(target => target.ancestry && isLegacy(target.ancestry)
    && ownerHasAncestrySource(env, target.owner))) {
    throw new DisclosureUnavailable('Disclosure selection was not established by its owner');
  }
  const state = ancestryState(env);
  const selected: DisclosureSelection[] = [];
  try {
    for (const sourceOwner of new Set(targets.map(target => target.owner))) {
      const indexes = targets.flatMap((target, index) => target.owner === sourceOwner ? [index] : []);
      if (!ownerHasAncestrySource(env, sourceOwner)) {
        indexes.forEach(index => {
          const target = targets[index]!;
          if (target.ancestry) {
            if (!validIssuedTarget(target, env)) throw new DisclosureUnavailable('Disclosure target is invalid');
            selected[index] = issuedAncestry.get(target.ancestry)!.selection;
          } else selected[index] = legacySelection(env, target);
        });
        continue;
      }
      const source = state.sources.get(sourceOwner)!;

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
      issuedAncestry.set(selection.ancestry, { selection, environment: env });
    }
    requireSelections(env, selected);
    return Object.freeze(selected);
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure ancestry source is unavailable', { cause });
  }
}
function requireSelections(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]): void {
  requireOwnerBatch(env, selections.map(selection => selection?.target));
  if (selections.some(selection => !selection
    || ancestryState(env).selections.get(selection.ancestry) !== selection
    || isLegacy(selection.ancestry) && ownerHasAncestrySource(env, selection.target.owner))) {
    throw new DisclosureUnavailable('Disclosure selection was not established by its owner');
  }
}
function requireOwnerBatch(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[]): void {
  requireBatch(targets.filter(target => target && ownerHasAncestrySource(env, target.owner)));
}
/** The previous owner contract resolved Work hints and structural ownership.
 * It did not establish Realm ancestry or require a complete graph-head proof. */
async function legacyTargets(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[]) {
  // The pre-ancestry Content adapter named the resource itself as its Work.
  // This is only a legacy lookup hint, never proof for a registered owner.
  targets = targets.map(target => target.owner === 'content' && target.component === 'body'
    && target.work === undefined && native.test(target.resource) ? { ...target, work: target.resource } : target);
  if (targets.some(target => !ownerReference.test(target.resource)
    || !governanceComponents.includes(target.component) || target.work != null && !native.test(target.work))) {
    throw new DisclosureUnavailable('Disclosure target is invalid');
  }
  const resources = [...new Set(targets.flatMap(target => [
    ...(target.work && target.workRevision == null ? [target.work] : []),
    ...(target.owner === 'graph' && (target.work == null
      || ['name', 'title'].includes(target.component) && target.revision == null) ? [target.resource] : []),
  ]))];
  const heads = new Map<string, string>();
  const owners = new Map<string, { work: string; revision: string | undefined }>();
  for (let offset = 0; offset < resources.length; offset += DISCLOSURE_COST.batch) {
    const batch = resources.slice(offset, offset + DISCLOSURE_COST.batch);
    try {
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT ?work ?head ?owningWork ?owningHead WHERE {
        VALUES ?work { ${batch.map(iri).join(' ')} }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head } }
        OPTIONAL {
          VALUES ?work { ${batch.map(iri).join(' ')} }
          {
          { GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork }
            BIND(?work AS ?owningWork) }
          UNION { GRAPH ${iri(GRAPHS.current)} { ?work a ?ownerType ; rv:work ?owningWork .
            VALUES ?ownerType { rv:MainVersion rv:TextContribution rv:Realization rv:Release } } }
          UNION { GRAPH ${iri(GRAPHS.revisions)} { ?work a rv:FixedRelease ; rv:work ?owningWork } }
          UNION { GRAPH ${iri(GRAPHS.current)} { ?work a schema:ListItem ; rv:structure ?structure .
            ?structure rv:structureOf ?component ; rv:selectedGeneration ?generation .
            ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?work .
            FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
            { ?component a rv:MainVersion ; rv:work ?owningWork }
            UNION { ?component a schema:CreativeWork . BIND(?component AS ?owningWork) } } }
          }
          OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?owningWork rv:head ?owningHead } }
        }
      } LIMIT ${batch.length + 1}`, 131_072)).results?.bindings ?? [];
      if (rows.length > batch.length || new Set(rows.map(row => row.work?.value)).size !== rows.length
        || rows.some(row => !row.work || !batch.includes(row.work.value)
          || row.owningWork && !native.test(row.owningWork.value))) {
        throw new DisclosureUnavailable('Disclosure heads are invalid');
      }
      for (const row of rows) {
        if (row.head) heads.set(row.work!.value, row.head.value);
        if (row.owningWork) owners.set(row.work!.value,
          { work: row.owningWork.value, revision: row.owningHead?.value });
      }
    } catch (cause) {
      throw new DisclosureUnavailable('Disclosure heads are unavailable', { cause });
    }
  }
  return { graphQueries: Math.ceil(resources.length / DISCLOSURE_COST.batch), targets: targets.map(target => {
    const inferred = target.owner === 'graph' && target.work == null ? owners.get(target.resource) : undefined;
    const work = target.work ?? inferred?.work;
    return { ...target, ...(work ? { work,
      workRevision: target.workRevision ?? (target.work ? heads.get(work) : inferred?.revision) } : {}),
      ...(target.owner === 'graph' && ['name', 'title'].includes(target.component)
        && target.revision == null ? { revision: heads.get(target.resource) } : {}) };
  }) };
}
async function currentHeads(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]) {
  const resources = [...new Set(selections.flatMap(headDependencies))];
  const heads = new Map<string, string>();
  let graphQueries = 0;
  try {
    for (let offset = 0; offset < resources.length; offset += DISCLOSURE_COST.parentHeadBatch) {
      const batch = resources.slice(offset, offset + DISCLOSURE_COST.parentHeadBatch);
      graphQueries++;
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
      || !isLegacy(selection.ancestry) && isGraphIdentity(selection.target, selection.ancestry)
        && heads.get(selection.target.resource) !== selection.ancestry.relationshipBasis.revision)) {
      throw new DisclosureUnavailable('Disclosure parent head moved');
    }
    return { heads, graphQueries };
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure parent heads are unavailable', { cause });
  }
}
async function evaluateSelections(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[],
  viewer: Viewer, channel: DisclosureChannel, client: PoolClient | undefined, anonymousNames: boolean) {
  requireSelections(env, selections);
  const reader = selectionReader(env, selections);
  const selectedTargets = selections.map(selection => ({ ...selection.target, ancestry: selection.ancestry }));
  if (selections.every(selection => isLegacy(selection.ancestry))) {
    selectedTargets.forEach(target => Object.freeze(target));
    Object.freeze(selectedTargets);
  }
  // Governance still checks the Asset. Its audience comes from the exact Use
  // receipt the ancestry owner issued for this occurrence, never Asset inventory.
  const mediaAllowed = await mediaVisibility(env, selectedTargets, viewer, selections.map(selection => {
    if (isLegacy(selection.ancestry)) return { reference: selection.target.resource, exactUse: false };
    const basis = selection.ancestry.relationshipBasis;
    const exactUse = selection.target.owner === 'media' && basis.owner === 'media' && basis.kind === 'media-use';
    return { reference: exactUse ? basis.resource : selection.target.resource, exactUse };
  }));
  const legacyTargetsToRead = selections.filter(selection => isLegacy(selection.ancestry)).map(selection => selection.target);
  const legacy = reader ? await legacyTargets(env, legacyTargetsToRead)
    : { targets: legacyTargetsToRead, graphQueries: 0 };
  let legacyIndex = 0;
  const targets = selections.map(selection => {
    if (!isLegacy(selection.ancestry)) return { ...selection.target, ancestry: selection.ancestry };
    const current = legacySelection(env, legacy.targets[legacyIndex++]!);
    ancestryState(env).selections.set(current.ancestry, current);
    issuedAncestry.set(current.ancestry, { selection: current, environment: env });
    return snapshotLegacyTarget({ ...current.target, ancestry: current.ancestry });
  });
  if (selections.every(selection => isLegacy(selection.ancestry))) Object.freeze(targets);
  requireSelections(env, selections);
  try {
    const evaluated = reader?.readAtCut
      ? await reader.readAtCut(targets, viewer, channel, client, anonymousNames)
      : { ...(reader
        ? anonymousNames && reader.readWithAnonymousNames
          ? await reader.readWithAnonymousNames(targets, viewer, channel, client)
          : { decisions: await reader.read(targets, viewer, channel, client),
            anonymousNames: anonymousNames ? await reader.read(targets, ANONYMOUS_VIEWER, channel, client) : [] }
        : { decisions: targets.map(() => 'visible' as const),
          anonymousNames: anonymousNames ? targets.map(() => 'visible' as const) : [] }),
        fenceBases: targets.map(() => unconfiguredLegacyFence), cost: {} as Readonly<Record<string, number>> };
    requireSelections(env, selections);

    if (mediaAllowed.length !== targets.length || mediaAllowed.some(allowed => typeof allowed !== 'boolean')
      || evaluated.decisions.length !== targets.length || !Array.isArray(evaluated.fenceBases)
      || evaluated.fenceBases.length !== targets.length || evaluated.fenceBases.some(basis => !validFenceBasis(basis))
      || evaluated.decisions.some(decision => !['visible', 'hidden', 'tombstone'].includes(decision))
      || anonymousNames && (evaluated.anonymousNames.length !== targets.length
        || evaluated.anonymousNames.some(decision => !['visible', 'hidden', 'tombstone'].includes(decision)))) {
      throw new DisclosureUnavailable('Disclosure cut result is incomplete');
    }
    return { ...evaluated, cost: { ...evaluated.cost, ...mediaAllowed.cost, parentHeadQueries: legacy.graphQueries }, fenceBases: evaluated.fenceBases,
      decisions: evaluated.decisions.map((decision, index) => mediaAllowed[index] ? decision : 'hidden'),
      anonymousNames: evaluated.anonymousNames.map((decision, index) => mediaAllowed[index] ? decision : 'hidden') };
  } catch (cause) {
    if (cause instanceof DisclosureUnavailable) throw cause;
    throw new DisclosureUnavailable('Disclosure cut reader is unavailable', { cause });
  }
}
export async function captureDisclosure(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureResults<DisclosureReadCut>> {
  const submission = await ownerSubmission(selections.every(selection => isLegacy(selection.ancestry)), selections, chunk => measuredSubmission(async () => {
    const results = await captureDisclosureChunk(env, chunk, viewer, channel, client);
    return { results, cost: results.cost! };
  }, client), accepted => requireSelections(env, accepted), selection => snapshotLegacySelection(env, selection));
  return costedResults(submission.results, submission.cost);
}
async function captureDisclosureChunk(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureResults<DisclosureReadCut>> {
  requireSelections(env, selections);
  selectionReader(env, selections);
  if (!selections.length) return costedResults([], {});
  await rereadRelationships(env, selections);
  const { heads, graphQueries } = await currentHeads(env, selections);
  const evaluated = await evaluateSelections(env, selections, viewer, channel, client, false);
  const state = ancestryState(env);
  return costedResults(selections.map((selection, index) => {
    const fenceBasis = Object.freeze({ ...evaluated.fenceBases[index]! });
    const cut = Object.freeze({ selection, parents: Object.freeze(selection.ancestry.parents.map(parent =>
      Object.freeze({ ...parent, fenceBasis }))), fenceBasis, decision: evaluated.decisions[index]! });
    const dependencies = new Set(headDependencies(selection));
    state.cuts.set(cut, { heads: new Map([...heads].filter(([resource]) => dependencies.has(resource))),
      viewer, audience: JSON.stringify(viewer), channel,
      source: state.sources.get(selection.target.owner), reader: selectionReader(env, selections) });
    return cut;
  }), { ...evaluated.cost, parentHeadQueries: graphQueries,
    ancestryReads: new Set(selections.map(selection => selection.target.owner)).size });
}
async function rereadRelationships(env: WorkActivationEnvironment, selections: readonly DisclosureSelection[]) {
  for (const sourceOwner of new Set(selections.map(selection => selection.target.owner))) {
    if (!ownerHasAncestrySource(env, sourceOwner)) continue;
    const indexes = selections.flatMap((selection, index) => selection.target.owner === sourceOwner ? [index] : []);
    const source = ancestryState(env).sources.get(sourceOwner);
    if (!source) throw new DisclosureUnavailable('Disclosure ancestry source is unavailable');
    try {
      const evidence = await source.reread(indexes.map(index => requireEstablishedAncestry(selections[index]!).relationshipBasis));
      if (evidence.length !== indexes.length) throw new DisclosureUnavailable('Disclosure final ancestry is incomplete');
      for (const [ordinal, index] of indexes.entries()) {
        const original = selections[index]!;
        const fresh = validateEvidence(env, original.target, evidence[ordinal]!);
        const { resourceKind, relationshipBasis, parents } = requireEstablishedAncestry(original);
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
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureResults<DisclosureDecision>> {
  const submission = await ownerSubmission(cuts.every(cut => isLegacy(cut.selection.ancestry)), cuts, chunk => measuredSubmission(async () => {
    const results = await fenceDisclosureChunk(env, chunk, viewer, channel, client);
    return { results, cost: results.cost! };
  }, client), accepted => requireSelections(env, accepted.map(cut => cut.selection)), cut => snapshotLegacyCut(env, cut));
  return costedResults(submission.results, submission.cost);
}
async function fenceDisclosureChunk(env: WorkActivationEnvironment, cuts: readonly DisclosureReadCut[],
  viewer: Viewer, channel: DisclosureChannel, client?: PoolClient): Promise<DisclosureResults<DisclosureDecision>> {
  requireBatch(cuts);
  const state = ancestryState(env), reader = selectionReader(env, cuts.map(cut => cut.selection));
  const saved = cuts.map(cut => {
    const saved = state.cuts.get(cut);
    if (!saved || saved.viewer !== viewer || saved.audience !== JSON.stringify(viewer) || saved.channel !== channel
      || saved.reader !== reader || saved.source !== state.sources.get(cut.selection.target.owner)) {
      throw new DisclosureUnavailable('Disclosure cut was not captured for this audience');
    }
    return saved;
  });
  if (!cuts.length) return costedResults([], {});
  const selections = cuts.map(cut => cut.selection);
  requireSelections(env, selections);
  try {
    if (reader instanceof DisclosureStore) await reader.assertFinalSnapshot(client);
    else await requireFreshSnapshot(client);
    await rereadRelationships(env, selections);
    const { heads, graphQueries } = await currentHeads(env, selections);
    if (saved.some(basis => [...basis.heads].some(([resource, head]) => heads.get(resource) !== head))) {
      throw new DisclosureUnavailable('Disclosure parent head moved');
    }
    const evaluated = await evaluateSelections(env, selections, viewer, channel, client, false);
    return costedResults(evaluated.decisions.map((decision, index) => {
      if (isLegacy(selections[index]!.ancestry)) {
        if (cuts[index]!.decision === 'hidden' || decision === 'hidden') return 'hidden';
        if (evaluated.fenceBases[index]!.recoveryGeneration !== cuts[index]!.fenceBasis.recoveryGeneration) {
          throw new DisclosureUnavailable('Disclosure enforcement cut moved');
        }
        return decision;
      }
      if (JSON.stringify(evaluated.fenceBases[index]) !== JSON.stringify(cuts[index]!.fenceBasis)) {
        throw new DisclosureUnavailable('Disclosure enforcement cut moved');
      }
      if (cuts[index]!.decision === 'hidden') return 'hidden';
      return decision;
    }), { ...evaluated.cost, parentHeadQueries: graphQueries,
      ancestryReads: new Set(selections.map(selection => selection.target.owner)).size });
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
  Promise<DisclosureWithAnonymousNames & { anonymousNameProbes: number; parentHeadQueries: number;
    cost: Readonly<Record<string, number>> }> {
  if (targets.every(target => !ownerHasAncestrySource(env, target.owner))) {
    const legacy = await readLegacyInventory(env, targets, viewer, channel, anonymousNames, client);
    return { ...legacy, cost: { parentHeadQueries: legacy.parentHeadQueries, anonymousNameProbes: legacy.anonymousNameProbes } };
  }
  const submission = await chunkDisclosureSubmission(targets, async chunk => measuredSubmission(async () => {
    requireReader(env);
    const selections = await resolveDisclosureSelectionChunk(env, chunk);
    const parentHeadQueries = (await currentHeads(env, selections)).graphQueries;
    const evaluated = await evaluateSelections(env, selections, viewer, channel, client, anonymousNames);
    return { results: evaluated.decisions.map((decision, index) => ({ decision, name: evaluated.anonymousNames[index] })),
      cost: { ...evaluated.cost, parentHeadQueries, anonymousNameProbes: 0,
        ancestryReads: new Set(chunk.map(target => target.owner)).size } };
  }, client));
  return { decisions: submission.results.map(result => result.decision),
    anonymousNames: anonymousNames ? submission.results.map(result => result.name!) : [],
    anonymousNameProbes: submission.cost.anonymousNameProbes ?? 0,
    parentHeadQueries: submission.cost.parentHeadQueries ?? 0, cost: submission.cost };
}

async function readLegacyInventory(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel, anonymousNames: boolean, client?: PoolClient):
  Promise<DisclosureWithAnonymousNames & { anonymousNameProbes: number; parentHeadQueries: number }> {
  targets = snapshotLegacyTargets(targets);
  requireOwnerBatch(env, targets);
  const reader = (env as ComposedEnvironment)[owner];
  if (!reader && targets.every(target => !ownerHasAncestrySource(env, target.owner))) {
    const allowed = await mediaVisibility(env, targets, viewer);
    if (targets.some(target => ownerHasAncestrySource(env, target.owner))) {
      throw new DisclosureUnavailable('Disclosure cut reader is unavailable');
    }
    return { decisions: allowed.map(visible => visible ? 'visible' : 'hidden'), anonymousNames: [],
      anonymousNameProbes: 0, parentHeadQueries: 0 };
  }
  if (reader && targets.every(target => !ownerHasAncestrySource(env, target.owner))) {
    const selections = await resolveDisclosureSelections(env, targets);
    const allowed = await mediaVisibility(env, targets, viewer);
    const current = await legacyTargets(env, selections.map(selection => selection.target));
    const policyTargets = snapshotLegacyTargets(current.targets);
    requireSelections(env, selections);
    let anonymousNameProbes = 0;
    const evaluated: DisclosureWithAnonymousNames = { decisions: [], anonymousNames: [] };
    for (let offset = 0; offset < policyTargets.length; offset += DISCLOSURE_COST.batch) {
      const batch = Object.freeze(policyTargets.slice(offset, offset + DISCLOSURE_COST.batch));
      const result = anonymousNames && reader.readWithAnonymousNames
        ? await reader.readWithAnonymousNames(batch, viewer, channel, client)
        : { decisions: await reader.read(batch, viewer, channel, client), anonymousNames: [] as DisclosureDecision[] };
      if (anonymousNames && !reader.readWithAnonymousNames) {
        const indexes = batch.flatMap((target, index) => target.owner === 'graph'
          && ['name', 'title'].includes(target.component) ? [index] : []);
        const names = indexes.length
          ? await reader.read(indexes.map(index => batch[index]!), ANONYMOUS_VIEWER, channel, client) : [];
        if (names.length !== indexes.length) throw new DisclosureUnavailable('Paired disclosure result is incomplete');
        anonymousNameProbes += indexes.length ? 1 : 0;
        result.anonymousNames = batch.map(() => 'hidden');
        indexes.forEach((index, ordinal) => { result.anonymousNames[index] = names[ordinal]!; });
      }
      if (result.decisions.length !== batch.length
        || anonymousNames && result.anonymousNames.length !== batch.length) {
        throw new DisclosureUnavailable('Paired disclosure result is incomplete');
      }
      evaluated.decisions.push(...result.decisions);
      evaluated.anonymousNames.push(...result.anonymousNames);
    }
    requireSelections(env, selections);
    if (evaluated.decisions.length !== targets.length
      || anonymousNames && evaluated.anonymousNames.length !== targets.length) {
      throw new DisclosureUnavailable('Paired disclosure result is incomplete');
    }
    return { decisions: evaluated.decisions.map((decision, index) => allowed[index] ? decision : 'hidden'),
      anonymousNames: evaluated.anonymousNames, anonymousNameProbes, parentHeadQueries: current.graphQueries };
  }
  throw new DisclosureUnavailable('Disclosure ancestry source registered during legacy delivery');
}
