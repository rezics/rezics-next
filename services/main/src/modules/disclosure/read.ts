import type { Pool } from 'pg';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import type { GovernanceComponent, GovernanceOwner } from '../governance/store.ts';
import { GLOBAL_CONTEXT, governanceOwners, governanceComponents } from '../governance/schema.ts';
import { controlRead } from '../access/topology-control.ts';
import { MediaUnavailable } from '../media/store.ts';
import { ANONYMOUS_VIEWER, eligible, validLabels, type Labels, type Viewer } from '../suitability/policy.ts';

export type DisclosureChannel = 'read' | 'summary' | 'thread' | 'feed' | 'search' | 'typeahead'
  | 'count' | 'inbox' | 'digest' | 'preview' | 'seo' | 'sitemap' | 'export' | 'media' | 'email' | 'push';
export const DISCLOSURE_CHANNELS: readonly DisclosureChannel[] = [
  'read', 'summary', 'thread', 'feed', 'search', 'typeahead', 'count', 'inbox',
  'digest', 'preview', 'seo', 'sitemap', 'export', 'media', 'email', 'push',
];
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
}
export type DisclosureDecision = 'visible' | 'tombstone' | 'hidden';
export interface DisclosureReader {
  read(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel): Promise<DisclosureDecision[]>;
}
export class DisclosureUnavailable extends MediaUnavailable {}
export const DISCLOSURE_COST = { batch: 64, ownerStatements: 1, recoveryStatements: 1 } as const;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const ownerReference = /^(?:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}|urn:rezics:[A-Za-z0-9:._/-]{1,480})$/;
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

/** One indexed owner query evaluates governance fences. Noninteractive delivery
 * also reads the direct target/parent suitability heads; no descendants are traversed.
 * The recovery fence is held through evaluation; no policy result is cached.
 * Revocation fences future disclosure; independent bytes already delivered cannot be recalled. */
export class DisclosureStore implements DisclosureReader {
  constructor(private readonly pool: Pool) {}
  get environment(): WorkActivationEnvironment | undefined { return poolEnvironments.get(this.pool); }
  set environment(env: WorkActivationEnvironment | undefined) {
    if (env) poolEnvironments.set(this.pool, env);
    else poolEnvironments.delete(this.pool);
  }

  async read(targets: readonly DisclosureTarget[], viewer: Viewer, channel: DisclosureChannel) {
    if (targets.length > DISCLOSURE_COST.batch || !DISCLOSURE_CHANNELS.includes(channel)
      || targets.some(target => !ownerReference.test(target.resource)
        || !governanceOwners.includes(target.owner) || !governanceComponents.includes(target.component)
        || target.work != null && !native.test(target.work)
        || (target.context?.length ?? 0) > 512 || (target.revision?.length ?? 0) > 512)
      || typeof viewer.signedIn !== 'boolean' || !['unknown', 'under-15', '15-17', 'adult'].includes(viewer.age)
      || !viewer.optIns || typeof viewer.optIns.general !== 'boolean' || typeof viewer.optIns.r15 !== 'boolean'
      || typeof viewer.optIns.sexual !== 'boolean' || typeof viewer.optIns.grotesque !== 'boolean') {
      throw new DisclosureUnavailable('Disclosure batch is invalid');
    }
    if (!targets.length) return [];
    const suitabilityDefault = usesSuitabilityDefault(channel);
    try {
      return await controlRead(this.pool, async client => {
        const rows = (await client.query<{ ordinal: number; restricted: boolean; assessments: Labels[] }>(`
          WITH requested AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS wanted(
            ordinal int, owner text, resource text, component text, revision text, context text, work text, "workRevision" text))
          SELECT wanted.ordinal,
            EXISTS (SELECT 1 FROM access.governance_enforcement e
              WHERE e.state = 'restricted' AND e.effect = ANY($2::text[])
                AND e.context = ANY(ARRAY[$3::text, wanted.context])
                AND (((e.resource = wanted.resource OR e.owner IN ('media', 'review')
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
                  OR (e.owner = 'graph' AND e.resource = wanted.work
                    AND (wanted.owner <> 'graph' OR wanted.work <> wanted.resource)
                    AND e.component IN ('title', 'name', 'record', 'publication')
                    AND (e.revision IS NULL OR wanted."workRevision" IS NULL OR e.revision = wanted."workRevision")))) AS restricted,
            ${suitabilityDefault ? `COALESCE((SELECT jsonb_agg(head.labels) FROM
              (SELECT DISTINCT ref FROM unnest(ARRAY[wanted.resource, wanted.work]) AS refs(ref)
                WHERE ref IS NOT NULL) refs
              CROSS JOIN LATERAL (SELECT a.labels FROM access.suitability_assessment a
                WHERE a.target = refs.ref ORDER BY a.revision_number DESC LIMIT 1) head), '[]'::jsonb)`
              : "'[]'::jsonb"} AS assessments
          FROM requested wanted ORDER BY wanted.ordinal`, [JSON.stringify(targets.map((target, ordinal) => ({
          ...target, ordinal, revision: target.revision ?? null, context: target.context ?? GLOBAL_CONTEXT,
          work: target.work ?? null,
        }))), effects(channel), GLOBAL_CONTEXT])).rows;
        if (rows.length !== targets.length || rows.some((row, index) => row.ordinal !== index
          || typeof row.restricted !== 'boolean' || !Array.isArray(row.assessments)
          || row.assessments.some(labels => !validLabels(labels)))) {
          throw new DisclosureUnavailable('Disclosure result is incomplete');
        }
        return rows.map((row): DisclosureDecision => {
          if (!row.restricted && (!suitabilityDefault || row.assessments.every(labels => eligible({
            assessment: { status: 'assessed', labels }, viewer, channel: suitabilityChannel(channel),
          }).eligible))) return 'visible';
          return ['read', 'summary', 'thread', 'feed', 'inbox'].includes(channel) ? 'tombstone' : 'hidden';
        });
      });
    } catch (cause) {
      if (cause instanceof DisclosureUnavailable) throw cause;
      throw new DisclosureUnavailable('Disclosure owner is unavailable', { cause });
    }
  }
}

// Enumerable environment state survives spread copies and wrapped graph clients.
// Legacy app fixtures omit governance; a configured owner must still fail closed.
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
  viewer: Viewer = ANONYMOUS_VIEWER, channel: DisclosureChannel = 'read') {
  const reader = (env as ComposedEnvironment)[owner];
  if (!reader) return Promise.resolve(targets.map(() => 'visible' as const));
  return reader.read(targets, viewer, channel);
}

/** Bounded inventories may exceed the transport batch, never the owner's query bound. */
export async function discloseInventory(env: WorkActivationEnvironment, targets: readonly DisclosureTarget[],
  viewer: Viewer, channel: DisclosureChannel): Promise<DisclosureDecision[]> {
  const result: DisclosureDecision[] = [];
  if (!(env as ComposedEnvironment)[owner]) return targets.map(() => 'visible');
  // Exact title fences apply to today's Work head. Derivative callers may
  // supply only a target identity; resolve structural ownership here, never
  // let a missing parent descriptor weaken its assessment or removal gate.
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
          # OPTIONAL's right side is evaluated independently; bind the batch here
          # so ownership lookup never scans unrelated chapter occurrences.
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
  const current = targets.map(target => {
    const inferred = target.owner === 'graph' && target.work == null ? owners.get(target.resource) : undefined;
    const work = target.work ?? inferred?.work;
    return { ...target, ...(work ? { work,
      workRevision: target.workRevision ?? (target.work ? heads.get(work) : inferred?.revision) } : {}),
      ...(target.owner === 'graph' && ['name', 'title'].includes(target.component)
        && target.revision == null ? { revision: heads.get(target.resource) } : {}) };
  });
  for (let offset = 0; offset < targets.length; offset += DISCLOSURE_COST.batch) {
    result.push(...await disclose(env, current.slice(offset, offset + DISCLOSURE_COST.batch), viewer, channel));
  }
  return result;
}
