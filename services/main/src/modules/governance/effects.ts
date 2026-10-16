import manifest from '../../../../../generated/model/manifest.json';
import { commandBindingGraphs, commandBindingRead, commandBindingValue, selectCommandProfile } from '../../../../../model/compiler/registry.ts';
import { profileValidations, type ProfileId } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContentModeration, ContentModerationConflict, ContentModerationStale }
  from '../../../../content/src/moderation.ts';
import type { DecisionOutcome, DecisionTargetInput } from './store.ts';
import { GovernanceConflict, GovernanceStale, GovernanceUnavailable } from './store.ts';
import type { Pool } from 'pg';
import { MediaStore, MediaStale, copySuppressionId,
  type CopySuppression, type CopySuppressionLift, type CopySuppressionScope } from '../media/store.ts';
import type { ContentCore } from '../../../../content/src/core.ts';
import { ownerTargetHeads } from './evidence.ts';
import { semanticOwnerTypes, semanticResourceTypeRole } from '../semantic/change.ts';
import type { SparqlResult } from '../../infrastructure/fuseki.ts';

export interface EffectPlan {
  /** Owner-established identity; null is a positively classified non-Realm record. */
  realm?: { realm: string; space: string } | null;
  restorationRestrictionId?: string;
  participant?: string;
  media?: { source: string; state: string; digest: string };
  ncii?: boolean;
  suppression?: CopySuppression;
  lift?: CopySuppressionLift;
  outcome?: DecisionOutcome;
}
export interface EffectReceipt {
  receipt: string;
  continuation?: string | null;
}
export class KnownEffectFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Every restriction label has an owner, including Access-local fences. */
export const restrictionOwners = {
  disclosure: 'target',
  publication: 'target',
  participation: 'access',
  capability: 'access',
  search: 'access',
  raw_delivery: 'target',
  media_delivery: 'media',
  export: 'access',
  source_apply: 'access',
} as const;

export interface ModerationEffects {
  participants?(target: DecisionTargetInput, after: string | null, limit: number): Promise<string[]>;
  plan?(target: DecisionTargetInput, outcome: DecisionOutcome, context?: {
    caseId: string; decisionId: string; reversesDecisionId: string | null;
    ncii: boolean; appealUpheld: boolean;
    copyright?: boolean; restorationAuthorized?: boolean;
  }): Promise<EffectPlan>;
  apply(operationId: string, ordinal: number, target: DecisionTargetInput,
    plan?: EffectPlan,
    continuation?: string | null,
  ): Promise<void | EffectReceipt>;
}

const receiptIri = (operationId: string, ordinal: number) =>
  `urn:rezics:receipt:moderation:${hash(`${operationId}:${ordinal}`)}`;
const effectIri = (operationId: string, ordinal: number) =>
  `urn:rezics:moderation:${hash(`${operationId}:${ordinal}`)}`;
const typed = (value: number) => `${lit(String(value))}^^<http://www.w3.org/2001/XMLSchema#integer>`;

type GraphTerm = NonNullable<SparqlResult['results']>['bindings'][number][string];
/** Model predicates and classes are RDF terms, not native resource identities. */
function graphIri(value: string): string {
  if (!/^(https?:\/\/[^<>\s"{}|\\^`]+|urn:[A-Za-z0-9][A-Za-z0-9:._-]+)$/.test(value))
    throw new GovernanceUnavailable('Graph profile term is not a safe IRI');
  return `<${value}>`;
}
function graphTerm(value: GraphTerm): string {
  if (value.type === 'uri') return graphIri(value.value);
  if (value.type !== 'literal') throw new GovernanceUnavailable('Graph profile selector is not a retained RDF term');
  return `${lit(value.value)}${value['xml:lang'] ? `@${value['xml:lang']}`
    : value.datatype ? `^^${graphIri(value.datatype)}` : ''}`;
}

async function graphModerationProfile(env: WorkActivationEnvironment, target: DecisionTargetInput) {
  // This structural probe must work while P or its current H is restricted.
  const home = target.component === 'record' && (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(target.resource)} a rv:ZoneHomeDocument }
  }`, 1024)).boolean === true;
  const selectors = [...new Set(manifest.canonical.flatMap(entry => entry.routes
    .flatMap(route => route.when.map(condition => condition.path))))];
  const rows = home ? [] : (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT DISTINCT ?kind ?head ?selector ?value WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target.resource)} a ?kind .
      OPTIONAL { VALUES ?selector { ${selectors.map(graphIri).join(' ')} }
        ${iri(target.resource)} ?selector ?value }
    } } LIMIT 257`, 32_768)).results?.bindings ?? [];
  if (rows.length >= 257 || rows.some(row => row.kind?.type !== 'uri'))
    throw new GovernanceUnavailable('Graph target profile is unavailable or ambiguous');
  const kinds = home ? [`${RV}ZoneHomeDocument`] : [...new Set(rows.map(row => row.kind!.value)
    .filter(kind => semanticResourceTypeRole(kind) === 'PRIMARY'))];
  if (kinds.length > 1) throw new GovernanceUnavailable('Graph target profile is unavailable or ambiguous');
  const kind = kinds[0];
  if (kind === `${RV}Realm`) throw new GovernanceStale('Graph target became a Realm after classification');
  const values = (path: string) => [...new Map(rows.filter(row => row.selector?.value === path)
    .map(row => row.value).filter(value => value !== undefined)
    .map(value => [graphTerm(value), value])).values()];
  const route = selectCommandProfile(manifest, kinds, path => values(path).map(value => value.value));
  if (!route) {
    if (manifest.canonical.some(entry => entry.type === kind))
      throw new GovernanceUnavailable('Graph target has no matching reviewed profile');
    return null;
  }
  // Bind the complete selector cut, including absence and earlier unmatched
  // routes, so a concurrent profile change cannot weaken the selected validation.
  const selectorGuard = route.selectors.map(path => {
    const selected = rows.filter(row => row.selector?.value === path).map(row => row.value)
      .filter(value => value !== undefined);
    const triples = [...new Set(selected.map(graphTerm))];
    return `${triples.map(value => `${iri(target.resource)} ${graphIri(path)} ${value} .`).join('\n')}
      FILTER NOT EXISTS { ${iri(target.resource)} ${graphIri(path)} ?otherSelector
        ${triples.length ? `FILTER(?otherSelector NOT IN (${triples.join(', ')}))` : ''} }`;
  }).join('\n');
  return { ...route, kind, selectorGuard,
    headPredicate: home ? 'rv:homeDocumentHead' : target.component === 'structure' ? 'rv:structureHead' : 'rv:head' };
}

async function graphBindingValidations(env: WorkActivationEnvironment, resource: string,
  selected: { profile: string; shape: string }) {
  const definition = manifest.profiles.find(profile => profile.id === selected.profile)?.binding;
  const graphs = commandBindingGraphs(selected.profile, GRAPHS);
  if (!definition) return { validations: await profileValidations(env.fuseki, selected.profile as ProfileId,
    [{ shape: selected.shape, focus: [resource], graphs: [GRAPHS.current, GRAPHS.revisions] }]), guard: '' };
  const read = commandBindingRead(selected.profile, definition, selected.shape, graphs, manifest);
  const rows = (await env.fuseki.query(`# registry-binding:${selected.profile}
    SELECT DISTINCT ${read.keys.map(key => `?${read.variables[key]}`).join(' ')} WHERE {
      VALUES ${read.anchor} { ${iri(resource)} }
      ${read.pattern}
    } LIMIT 2`, 32_768)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || definition.roles.some(role => row?.[read.variables[role]!]?.type !== 'uri')
    || definition.required.some(key => !row?.[read.variables[key]!]?.value))
    throw new GovernanceUnavailable('Graph owner binding is unavailable or ambiguous');
  const binding = Object.fromEntries([...definition.required, ...definition.optional]
    .filter(key => row![read.variables[key]!])
    .map(key => [key, commandBindingValue(key, row![read.variables[key]!]!.value)]));
  const validations = await profileValidations(env.fuseki, selected.profile as ProfileId,
    definition.roles.map(role => ({ shape: `https://rezics.com/definition/${selected.profile}/${role}-shape`,
      focus: [row![read.variables[role]!]!.value], graphs: commandBindingGraphs(selected.profile, GRAPHS) })), binding);
  // Pin the same structural witness in the writing transaction. BindingPolicy
  // then validates the complete focus/argument bundle against that transaction.
  const guard = read.facts.flatMap(fact => {
    const subject = row![read.variables[fact.subject]!]!;
    const objects = fact.types?.map(value => ({ type: 'uri', value }))
      ?? (fact.object && row![read.variables[fact.object]!] ? [row![read.variables[fact.object]!]!] : []);
    if (!objects.length) return [];
    // Fixed point witnesses avoid graph-variable joins in the command's staged
    // guard. EXISTS also collapses duplicate facts across retained graphs.
    return [`FILTER(${objects.flatMap(object => graphs.map(graph => `EXISTS { GRAPH ${iri(graph)} {
      ${graphTerm(subject)} ${graphIri(fact.predicate)} ${graphTerm(object)} }
    }`)).join(' || ')})`];
  }).join('\n');
  return { validations, guard };
}

function assertGraphOwnerBasis(plan: EffectPlan | undefined, realm: { realm: string; space: string } | null) {
  if (plan?.realm === undefined) return;
  const reviewed = plan.realm;
  if (reviewed === null ? realm !== null
    : !realm || reviewed.realm !== realm.realm || reviewed.space !== realm.space)
    throw new GovernanceStale('target changed since review');
}

/** Bounded affected-Agent keyset; private Account identities never enter the graph. */
export function graphNoticeParticipants(env: WorkActivationEnvironment): Pick<ModerationEffects, 'participants'> {
  return { async participants(target, after, limit) {
    const realm = target.owner === 'graph' ? await ownerTargetHeads({ graph: env }).realmBasis(target) : null;
    const authors = realm
      ? `${iri(realm.realm)} a rv:Realm . ${iri(realm.space)} rv:owner ?author`
      : `
        { ${iri(target.resource)} rv:author ?author }
        UNION { ?credit a rv:NativeAgentCredit ; rv:work ${iri(target.resource)} ; rv:agent ?author .
          FILTER NOT EXISTS { ?credit rv:retiredBy ?retirement } }
        UNION { ?contribution a rv:TextContribution ; rv:work ${iri(target.resource)} ; rv:author ?author }
        UNION { ${iri(target.resource)} rv:work ?work . ?credit a rv:NativeAgentCredit ; rv:work ?work ; rv:agent ?author .
          FILTER NOT EXISTS { ?credit rv:retiredBy ?retirement } }
        UNION { ${iri(target.resource)} rv:owner ?author }
        UNION { ${iri(target.resource)} a rv:Agent . BIND(${iri(target.resource)} AS ?author) }`;
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?author WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${authors}
      }
      ${after ? `FILTER(STR(?author) > ${lit(after)})` : ''}
    } ORDER BY STR(?author) LIMIT ${limit}`, 16_384)).results?.bindings ?? [];
    return rows.map(row => row.author?.value).filter((author): author is string => !!author);
  } };
}

/** Owner CAS is the last mutable-head gate before Access writes its fence. */
export function ownerModerationEffects(content: ContentModeration, env: WorkActivationEnvironment,
  media?: { pool: Pool; core: ContentCore },
): ModerationEffects {
  const store = media ? new MediaStore(media.pool, media.core) : undefined;
  const validateGraphTarget = async (target: DecisionTargetInput, plan?: EffectPlan) => {
    const realm = target.owner === 'graph' ? await ownerTargetHeads({ graph: env }).realmBasis(target) : null;
    if (target.owner === 'graph') assertGraphOwnerBasis(plan, realm);
    if (realm && ['body', 'structure'].includes(target.component))
      throw new GovernanceStale('Realm moderation has no body or structure grain');
    return realm;
  };
  const accessReceipt = async (operationId: string, ordinal: number, target: DecisionTargetInput) => {
    // ReviewReportOwner.lockCurrent already verifies this head under the same
    // Access transaction lock before dispatch. External heads need this probe.
    if (target.expectedHead !== null && target.owner !== 'review') {
      let current: string | null;
      if (target.owner === 'graph') {
        const home = target.component === 'record' && (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} { ${iri(target.resource)} a rv:ZoneHomeDocument }
        }`, 1024)).boolean === true;
        const predicate = home ? 'rv:homeDocumentHead' : target.component === 'structure' ? 'rv:structureHead' : 'rv:head';
        const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
          GRAPH ${iri(GRAPHS.current)} { ${iri(target.resource)} ${predicate} ?head }
        } LIMIT 2`, 2048)).results?.bindings ?? [];
        current = rows.length === 1 && rows[0]?.head?.type === 'uri' ? rows[0].head.value : null;
      } else current = await ownerTargetHeads({ content: media?.pool }).current(target);
      if (current !== target.expectedHead) throw new GovernanceStale('owner head changed');
    }
    return { receipt: `access:governance-enforcement:${operationId}:${ordinal}` };
  };
  return {
    ...graphNoticeParticipants(env),
    async plan(target, outcome, context) {
      const plan: EffectPlan = {};
      if (media && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target.resource)) {
        const original = (
          await media.pool.query<{
            owner: string;
            state_head: string;
            id: string;
            byte_digest: string;
            cover_only: boolean;
          }>(
            target.owner === 'media' && target.component === 'media_use'
              ? `SELECT a.owner,a.state_head,p.id,p.byte_digest,a.cover_only FROM media.use u
           JOIN media.asset a ON a.id = u.asset_id
           JOIN media.representation p ON p.asset_id = a.id AND p.kind = 'original'
           WHERE u.target = $1 AND u.asset_revision_id = $2::uuid AND u.id = $3::uuid LIMIT 1`
              : `SELECT a.owner,a.state_head,p.id,p.byte_digest,a.cover_only FROM media.asset a
           JOIN media.representation p ON p.asset_id = a.id AND p.kind = 'original'
           LEFT JOIN content.revision r ON r.id = $2::uuid
                      WHERE a.id = $1 AND (p.id = $2::uuid OR (r.variant_id = a.variant_id AND r.body @> jsonb_build_object(
             'representations',jsonb_build_array(jsonb_build_object('id',p.id::text))))) LIMIT 1`,
            [
              target.owner === 'media' && target.component === 'media_use'
                ? target.resource : target.resource.slice(-36),
              target.revision && /^[0-9a-f-]{36}$/.test(target.revision.slice(-36))
                ? target.revision.slice(-36)
                : null,
              ...(target.owner === 'media' && target.component === 'media_use' ? [target.locator] : []),
            ],
          )
        ).rows[0];
        if (original) {
          plan.participant = original.owner;
          plan.media = {
            source: original.id,
            state: original.state_head,
            digest: original.byte_digest,
          };
          const scope = context?.ncii ? 'all'
            : context?.copyright && original.cover_only ? 'imported-cover' : null;
          if (context) {
            if (['restore', 'reverse'].includes(outcome)) {
              // Restoration follows the saved decision's scope, including when
              // later evidence classifies the case differently. Older copyright
              // restrictions without a digest basis retain original-only lifts.
              const suppression = (await media.pool.query<{
                id: string; scope: CopySuppressionScope; lifted: boolean;
              }>(`SELECT d.id,d.scope,EXISTS (
                  SELECT 1 FROM media.suppression_lift l WHERE l.suppression_id = d.id) AS lifted
                FROM media.suppressed_digest d WHERE digest = $1 AND case_id = $2 AND decision_id = $3`,
              [original.byte_digest, context.caseId, context.reversesDecisionId])).rows[0];
              if (suppression) {
                if (suppression.lifted || !context.reversesDecisionId
                  || !(suppression.scope === 'all' ? context.ncii && context.appealUpheld
                    : context.restorationAuthorized))
                  throw new GovernanceStale('identical-copy restoration requires its authorized reversal');
                plan.lift = { id: suppression.id, caseId: context.caseId, decisionId: context.decisionId,
                  reversesDecisionId: context.reversesDecisionId, scope: suppression.scope };
              } else if (context.ncii) {
                throw new GovernanceStale('appealed copy suppression is unavailable');
              }
            } else if (scope) {
              plan.suppression = { id: copySuppressionId(context.decisionId, original.byte_digest),
                caseId: context.caseId, decisionId: context.decisionId, scope };
            }
          }
        }
        const reply = (
          await media.pool.query<{ author: string }>(
            'SELECT author FROM content.reply_author WHERE reply = $1',
            [target.resource],
          )
        ).rows[0];
        if (reply) plan.participant = reply.author;
        if (!plan.participant && target.owner === 'content' && target.revision) {
          const row = (
            await media.pool.query<{ author: string | null }>(
              "SELECT provenance->>'author' AS author FROM content.revision WHERE id = $1",
              [target.revision],
            )
          ).rows[0];
          if (row?.author) plan.participant = row.author;
        }
      }
      if (!plan.participant && target.owner === 'graph') {
        // Participation fences name one Agent; notice discovery has its own
        // resumable keyset and does not mistake this fence subject for the party set.
        plan.participant = (await graphNoticeParticipants(env).participants!(target, null, 1))[0];
      }
      return plan;
    },
    async apply(operationId, ordinal, target, plan, continuation) {
      if (restrictionOwners[target.effect] === 'access') {
        await validateGraphTarget(target, plan);
        return accessReceipt(operationId, ordinal, target);
      }
      if (plan?.media && store) {
        await validateGraphTarget(target, plan);
        const receipt = `${operationId}:${ordinal}`;
        const restricted = !['restore', 'reverse'].includes(plan.outcome ?? 'restrict');
        try {
          // The original state receipt precedes digest closure. Replays reconcile
          // it before advancing a bounded copy batch.
          if (plan.ncii && !(restricted ? plan.suppression : plan.lift))
            throw new GovernanceStale('NCII decision has no saved suppression basis');
          await store.moderateOriginal(receipt, plan.media.source, plan.media.state, restricted, plan.lift,
            restricted ? plan.suppression : undefined);
          if (restricted && plan.suppression) {
            const result = await store.suppressIdenticalCopies(
              plan.media.digest,
              continuation ?? null,
              100,
              plan.suppression,
            );
            return { receipt, continuation: result.continuation };
          }
          if (!restricted && plan.lift) {
            const result = await store.restoreIdenticalCopies(plan.lift, continuation ?? null);
            return { receipt, continuation: result.continuation };
          }
          return { receipt };
        } catch (error) {
          if (error instanceof MediaStale) throw new GovernanceStale(error.message);
          throw error;
        }
      }
      if (target.owner === 'media')
        throw new GovernanceUnavailable('media original plan is unavailable');
      if (target.owner === 'review' || target.owner === 'source') {
        return accessReceipt(operationId, ordinal, target);
      }
      if (target.owner === 'content') {
        if (!target.revision || !target.expectedHead || target.component !== 'body') {
          throw new GovernanceStale('Content moderation needs an exact draft head');
        }
        try {
          await content.apply({ operationId, ordinal, resource: target.resource, revision: target.revision,
            locator: target.locator, expectedHead: target.expectedHead, effect: target.effect });
        } catch (error) {
          if (error instanceof ContentModerationStale) throw new GovernanceStale('Content draft head changed');
          if (error instanceof ContentModerationConflict) throw new GovernanceConflict(error.message);
          throw error;
        }
        return { receipt: `content:receipt:${operationId}:${ordinal}` };
      }
      if (target.owner !== 'graph') {
        throw new GovernanceUnavailable('moderation owner CAS is unavailable for this target');
      }
      const receipt = receiptIri(operationId, ordinal);
      const effect = effectIri(operationId, ordinal);
      const event = `urn:rezics:event:${hash(effect)}`;
      const operation = `urn:rezics:operation:${hash(operationId)}`;
      const requestDigest = hash(JSON.stringify({ operationId, ordinal, target }));
      const observed = async () => {
        const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?target ?head WHERE {
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ?digest ;
            rv:moderationTarget ?target ; rv:expectedHead ?head ;
            rv:application ${iri(effect)} ; rv:outcome rv:Succeeded . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(effect)} a rv:ModerationEffect ;
            rv:moderationTarget ?target ; rv:expectedHead ?head ;
            rv:moderationOperation ${lit(operationId)} ; rv:moderationEffect ${lit(target.effect)} . }
        } LIMIT 2`, 4096);
        const rows = result.results?.bindings ?? [];
        if (!rows.length) return false;
        if (rows.length !== 1 || rows[0]?.digest?.value !== requestDigest
          || rows[0]?.target?.value !== target.resource || rows[0]?.head?.value !== target.expectedHead) {
          throw new GovernanceConflict('moderation graph operation differs');
        }
        return true;
      };
      if (await observed()) return { receipt };
      const realm = await validateGraphTarget(target, plan);
      const selected = realm ? null : await graphModerationProfile(env, target);
      if (!realm && !selected) {
        return accessReceipt(operationId, ordinal, target);
      }
      if (!target.expectedHead) throw new GovernanceStale('Graph moderation needs an exact owner head');
      const bound = selected ? await graphBindingValidations(env, target.resource, selected) : null;
      const realmValidations = realm ? [
        { kind: `${RV}Space`, resource: realm.space }, { kind: `${RV}Realm`, resource: realm.realm },
      ].map(({ kind, resource }) => {
        const route = selectCommandProfile(manifest, [kind], path =>
          path === `${RV}definitionProfile` && !realm.legacy ? [realm.profile] : []);
        if (!route || route.profile !== realm.profileId)
          throw new GovernanceUnavailable('Realm registry profile differs from its owner basis');
        return { shape: route.shape, focus: [resource], graphs: [GRAPHS.current] };
      }) : null;
      const validations = realm ? await profileValidations(env.fuseki, realm.profileId, realmValidations!) : bound!.validations;
      const headPredicate = realm ? 'rv:head' : selected!.headPredicate;
      const profileGuard = selected ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(target.resource)} a ${graphIri(selected.kind)} .
        ${selected.selectorGuard}
        FILTER NOT EXISTS { ${iri(target.resource)} a ?otherKind .
          FILTER(?otherKind IN (${[...semanticOwnerTypes].filter(kind => kind !== selected.kind
            && semanticResourceTypeRole(kind) === 'PRIMARY').map(graphIri).join(', ')})) }
      }` : '';
      const realmGuard = realm ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(realm.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(realm.space)} .
        ${iri(realm.space)} a rv:Space ; rv:realmCapability ${iri(realm.realm)} .
        FILTER NOT EXISTS {
          ${iri(realm.realm)} a ?otherKind .
          FILTER(?otherKind IN (${[...semanticOwnerTypes].filter(kind => kind !== `${RV}Realm`
            && semanticResourceTypeRole(kind) === 'PRIMARY').map(kind => `<${kind}>`).join(', ')}))
        }
        FILTER NOT EXISTS { ${iri(realm.realm)} rv:space ?otherSpace . FILTER(?otherSpace != ${iri(realm.space)}) }
        FILTER NOT EXISTS { ?otherSpace rv:realmCapability ${iri(realm.realm)} . FILTER(?otherSpace != ${iri(realm.space)}) }
        FILTER NOT EXISTS { ${iri(realm.realm)} rv:head ?otherHead . FILTER(?otherHead != ${iri(target.expectedHead)}) }
        ${realm.legacy ? `
            FILTER NOT EXISTS { ${iri(realm.realm)} rv:definitionProfile ?realmProfile }
            FILTER NOT EXISTS { ${iri(realm.space)} rv:definitionProfile ?spaceProfile }
          ` : `
          ${iri(realm.realm)} rv:definitionProfile ${iri(realm.profile)} .
          ${iri(realm.space)} rv:definitionProfile ${iri(realm.profile)} .`}
        FILTER NOT EXISTS { ${iri(realm.realm)} rv:definitionProfile ?otherProfile . FILTER(?otherProfile != ${iri(realm.profile)}) }
        FILTER NOT EXISTS { ${iri(realm.space)} rv:definitionProfile ?otherProfile . FILTER(?otherProfile != ${iri(realm.profile)}) }
      }` : '';
      let result: Awaited<ReturnType<typeof env.fuseki.commandWithReceipt>> | undefined;
      let cause: unknown;
      try { result = await env.fuseki.commandWithReceipt({ receipt, digest: requestDigest,
        validations, deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
          DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
          INSERT {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
            GRAPH ${iri(GRAPHS.revisions)} { ${iri(effect)} a rv:ModerationEffect ;
              rv:moderationTarget ${iri(target.resource)} ; rv:expectedHead ${iri(target.expectedHead)} ;
              rv:moderationOperation ${lit(operationId)} ; rv:moderationEffect ${lit(target.effect)} ;
              rv:moderationOrdinal ${typed(ordinal)} . }
            GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
              rv:requestDigest ${lit(requestDigest)} ; rv:outcome rv:Succeeded ;
              rv:moderationTarget ${iri(target.resource)} ; rv:expectedHead ${iri(target.expectedHead)} ;
              rv:work ${iri(target.resource)} ; rv:application ${iri(effect)} ;
              rv:operation ${iri(operation)} ;
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next . }
            GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)}
              a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
              ${iri(event)} a rv:ModerationEffectAcceptedEvent ; rv:ordinal 0 ;
                rv:action ${lit('governance.moderation.apply')} ; rv:receipt ${iri(receipt)} ;
                rv:application ${iri(effect)} . }
          } WHERE {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
            GRAPH ${iri(GRAPHS.current)} { ${iri(target.resource)} ${headPredicate} ${iri(target.expectedHead)} }
            ${realmGuard}
            ${profileGuard}
            ${bound?.guard ?? ''}
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
            FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
            BIND(?n + 1 AS ?next)
          }` }); } catch (error) { cause = error; }
      if (await observed()) return { receipt };
      if (result?.status === 'invalid' || result?.status === 'unknown-profile') {
        throw new GovernanceUnavailable('moderation graph profile is unavailable');
      }
      if (result?.status === 'guard-unmatched') throw new GovernanceStale('graph head changed');
      throw new GovernanceUnavailable('moderation graph outcome requires retry', { cause });
    },
  };
}
