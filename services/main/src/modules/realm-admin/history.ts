import type { PoolClient } from 'pg';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { AdmissionUnavailable } from '../access/admission.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

export interface RealmHistoryFloor { dataEpoch: string; sequence: string }
export const REALM_HISTORY_COST = { admissionGraphReads: 1, admissionRows: 2,
  accessPointReads: 1, lineageRows: 32 } as const;

/** Called inside the successful membership transaction, once per episode.
 * Only from-admission joins acquire a cut. Earlier/everything episodes retain
 * full history, including adapters whose graph owner has not been wired yet.
 * No oldest/current timestamp approximation, and no lazy first-read admission. */
export async function recordRealmHistoryAdmission(client: PoolClient, env: WorkActivationEnvironment | undefined,
  realm: string, kind: 'agent' | 'private', membership: string, generation: string) {
  if (!env) return;
  const restricted = await client.query(`SELECT 1 FROM access.realm_admin_settings
    WHERE realm = $1 AND history = 'from-admission'`, [realm]);
  if (!restricted.rowCount) return;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.sequence?.value ?? '')) {
    throw new AdmissionUnavailable('Realm admission graph position is unavailable');
  }
  await client.query(`INSERT INTO access.realm_history_admission (kind,membership_id,generation,data_epoch,sequence)
    VALUES ($1,$2,$3,$4,$5)`, [kind,membership,generation,env.lineage.dataEpoch,rows[0]!.sequence!.value]);
}

/** Revisions after the admission cut are readable, including newer restore
 * epochs. A missing retained lineage is unavailable, never unrestricted history.
 * Apply this to candidate discovery before LIMIT and to exact reads too. */
export async function realmHistoryFilter(session: WorkReadSession, realm: string,
  epoch = '?revisionEpoch', sequence = '?sequence'): Promise<string> {
  const policy = await session.realm(realm);
  if (policy.visibility !== 'private' || policy.history !== 'from-admission') return '';
  if (!session.principal || !session.options.actingSubject || !session.deps.access.realmHistoryFloor) {
    throw new WorkReadUnavailable('Realm history admission is unavailable');
  }
  const floor = await session.deps.access.realmHistoryFloor(session.principal, session.options.actingSubject, realm);
  if (!floor) return ''; // Owners and episodes without a cut retain complete history.
  return realmHistoryCutFilter(session.deps.environment, floor, epoch, sequence);
}

/** A stream's first publication is after admission iff every publication in it
 * is after admission. Checking for an older record also covers disconnected
 * re-selection chains and different Main versions of the same Work. Edits can
 * never turn an old stream into a newly readable one. Native cost is O(H) for
 * H revisions in the exact slot/Realm-Work relation, with no body hydration. */
export async function realmHistoryOriginFilter(session: WorkReadSession, realm: string,
  kind: 'placement' | 'selection', resource: string) {
  const filter = await realmHistoryFilter(session, realm, '?historyEpoch', '?historySequence');
  return filter ? historyOriginPattern(realm,kind,resource,filter) : '';
}

export async function realmHistoryOriginCutFilter(env: WorkActivationEnvironment, floor: RealmHistoryFloor,
  realm: string, kind: 'placement' | 'selection', resource: string) {
  return historyOriginPattern(realm,kind,resource,
    await realmHistoryCutFilter(env,floor,'?historyEpoch','?historySequence'));
}

function historyOriginPattern(realm: string, kind: 'placement' | 'selection', resource: string, filter: string) {
  const relation = kind === 'placement'
    ? `?historyItem a rv:RealmReplyPlacement ; rv:component ${resource} ; rv:placementOutcome rv:Accepted .`
    : `?historyItem a rv:PublicationSelection ; rv:context ${iri(realm)} ; rv:work ${resource} .`;
  return `FILTER EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${relation} } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${relation}
      OPTIONAL { ?historyItem rv:dataEpoch ?historyEpoch ; rv:sequence ?historySequence } }
      FILTER(!BOUND(?historyEpoch) || !BOUND(?historySequence) || !(${filter.slice(7,-1)})) }`;
}

export async function realmHistoryCutFilter(env: WorkActivationEnvironment, floor: RealmHistoryFloor,
  epoch = '?revisionEpoch', sequence = '?sequence') {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?prior WHERE { GRAPH ${iri(GRAPHS.control)} {
    ?cutover a rv:RestoreCutover ; rv:dataEpoch ?epoch ; rv:priorDataEpoch ?prior . } } LIMIT 33`, 8192)).results?.bindings ?? [];
  if (rows.length > REALM_HISTORY_COST.lineageRows) throw new WorkReadUnavailable('Realm history lineage exceeds its bound');
  const prior = new Map<string,string>();
  for (const row of rows) {
    if (!row.epoch || !row.prior || prior.has(row.epoch.value) && prior.get(row.epoch.value) !== row.prior.value) {
      throw new WorkReadUnavailable('Realm history lineage is ambiguous');
    }
    prior.set(row.epoch.value,row.prior.value);
  }
  const newer: string[] = [];
  let current: string | undefined = env.lineage.dataEpoch;
  while (current !== floor.dataEpoch) {
    if (!current || newer.includes(current)) throw new WorkReadUnavailable('Realm history cut is outside retained lineage');
    newer.push(current);
    current = prior.get(current);
  }
  if (!/^\d+$/.test(floor.sequence)) throw new WorkReadUnavailable('Realm history cut is invalid');
  return `FILTER((${epoch} = ${lit(floor.dataEpoch)} && ${sequence} > ${floor.sequence})${newer.length
    ? ` || ${epoch} IN (${newer.map(lit).join(',')})` : ''})`;
}
