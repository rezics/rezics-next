import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from './admission.ts';
import { REALM_ADMIN_COST, RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid,
  RealmAdminStale, RealmAdminUnavailable, realmPermissions, settingsCommand,
  type RealmSettings } from '../realm-admin/contract.ts';
import { saveRealmAccessSettings, saveRealmSettings } from './realm-management-settings.ts';
import { spaceCreationReceiptIri } from '../space/create.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';

export interface RealmInitializationInput {
  realm: string;
  actingSubject: string;
  creationKey: string;
  creationDigest: string;
  settings: Omit<RealmSettings, 'rules'>;
  rules?: RealmSettings['rules'];
}
export interface RealmInitializationResult { realm: string; accessRevision: string; replayed: boolean }
export const REALM_INITIALIZATION_COST = { graphReads: 1, graphBytes: 8192,
  creationKeyLookups: 1, founderGrants: realmPermissions.length + 3, representations: 2,
  statementTimeoutMs: REALM_ADMIN_COST.statementTimeoutMs, lockTimeoutMs: REALM_ADMIN_COST.lockTimeoutMs } as const;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const scope = (realm: string) => `governance:realm:${realm}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');

/** Shared with the legacy initializer: enrollment never happens on a replay. */
export async function enrollRealmFounder(client: PoolClient, realm: string, actor: string,
  identity: { id: string; valid_until: string }, admissionId: string, receiptId: string) {
  await client.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution') ON CONFLICT DO NOTHING`, [realm]);
  await client.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
    VALUES ('realm',$1,0,'realm-membership-v1') ON CONFLICT DO NOTHING`, [realm]);
  await client.query(`INSERT INTO access.scope_gate (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
    [[`review:decide:${realm}`, `publication:adopt:${realm}`, `realm:profile:${realm}`, `media:avatar:${realm}`]]);
  const actions = [...realmPermissions, 'realm.owner', 'realm.profile.publish', 'media.avatar'];
  const scopes = actions.map(action => action === 'review.decide' ? `review:decide:${realm}`
    : action === 'publication.adopt' ? `publication:adopt:${realm}`
    : action === 'realm.profile.publish' ? `realm:profile:${realm}`
    : action === 'media.avatar' ? `media:avatar:${realm}` : scope(realm));
  await client.query(`INSERT INTO access.permission_grant
    (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
    SELECT gen_random_uuid(),$1,$1,scope,action,$3,$4 FROM unnest($2::text[],$5::text[]) AS p(scope,action)`,
  [actor, scopes, identity.valid_until, identity.id, actions]);
  await client.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    SELECT gen_random_uuid(),$1,$2,action,$3 FROM unnest($4::text[]) AS p(action)`,
  [identity.id, actor, identity.valid_until, ['realm.profile.publish', 'media.avatar']]);
  await client.query(`INSERT INTO access.realm_admin_owner_bootstrap
    (realm,owner_subject,admission_id,receipt_id,principal_id) VALUES ($1,$2,$3,$4,$5)`,
  [realm, actor, admissionId, receiptId, identity.id]);
}

/** One exact creation-admission lookup, one bounded graph proof, fixed founder
 * rows and this Realm's settings/rule head. No member or content inventory reads.
 * The admission lock serializes same-key retries; the Realm gate also excludes
 * legacy initialization/settings. Replay performs no INSERT, UPDATE or DELETE. */
export async function initializeCreatedRealm(pool: Pool, principal: VerifiedPrincipal,
  input: RealmInitializationInput, env: WorkActivationEnvironment): Promise<RealmInitializationResult> {
  const command = { actingSubject: input.actingSubject, expectedGeneration: '0',
    expectedRulesRevision: null, reason: 'Initialize created Realm',
    settings: { ...input.settings, rules: input.rules === undefined ? [] : input.rules } };
  if (!native.test(input.realm) || !native.test(input.actingSubject)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.creationKey) || !/^[0-9a-f]{64}$/.test(input.creationDigest)) {
    throw new RealmAdminInvalid('Invalid Realm creation binding');
  }
  if (!Value.Check(settingsCommand, command)) throw new RealmAdminInvalid('Invalid Realm settings');
  const intent = digest({ realm: input.realm, command });
  const client = await pool.connect().catch(() => { throw new RealmAdminUnavailable('Access is unavailable'); });
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${REALM_INITIALIZATION_COST.lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${REALM_INITIALIZATION_COST.statementTimeoutMs}ms'`);
    if (!(await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE')).rowCount) {
      throw new RealmAdminUnavailable('Access recovery is in progress');
    }
    const identity = (await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [principal.issuer, principal.subject])).rows[0];
    if (!identity) throw new RealmAdminDenied('Current Realm creator authority is missing');
    const admission = (await client.query<{ id: string; acting_subject: string; scope_id: string;
      request_digest: string; state: string; graph_receipt: string | null; graph_outcome: string | null }>(`
      SELECT id,acting_subject,scope_id,request_digest,state,graph_receipt,graph_outcome
      FROM access.admission WHERE principal_id = $1 AND action = 'space.create' AND idempotency_key = $2 FOR UPDATE`,
    [identity.id, input.creationKey])).rows[0];
    if (!admission || admission.acting_subject !== input.actingSubject || admission.scope_id !== 'space:create:root') {
      throw new RealmAdminDenied('Realm creation admission is unavailable');
    }
    if (admission.request_digest !== input.creationDigest) throw new RealmAdminConflict('Key binds another creation intent');
    const prior = (await client.query<{ realm: string; creation_digest: string;
      access_revision: string }>(`SELECT realm,creation_digest,
      access_revision::text FROM access.realm_creation_initialization WHERE admission_id = $1`,
    [admission.id])).rows[0];
    if (prior) {
      if (prior.realm !== input.realm || prior.creation_digest !== input.creationDigest) {
        throw new RealmAdminConflict('Key binds another initialization intent');
      }
      await client.query('COMMIT');
      return { realm: prior.realm, accessRevision: prior.access_revision, replayed: true };
    }
    const receipt = spaceCreationReceiptIri(admission.id);
    if (admission.state !== 'claimed' && admission.state !== 'sealed'
      || admission.graph_outcome !== null && admission.graph_outcome !== 'succeeded'
      || admission.graph_receipt !== null && admission.graph_receipt !== receipt) {
      throw new RealmAdminDenied('Realm creation proof is unavailable');
    }
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space rv:owner ${iri(input.actingSubject)} ; rv:realmCapability ${iri(input.realm)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:realm ${iri(input.realm)} ; rv:space ?space ; rv:owner ${iri(input.actingSubject)} ;
        rv:admissionId ${lit(admission.id)} ; rv:requestDigest ${lit(input.creationDigest)} . }
    } LIMIT 2`, REALM_INITIALIZATION_COST.graphBytes)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.space) throw new RealmAdminDenied('Realm creation proof is unavailable');
    const representation = (await client.query<{ valid_until: string }>(`SELECT r.valid_until::text
      FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
      WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action IN ('space.create','agent.control')
        AND r.active AND r.valid_until > clock_timestamp()
      ORDER BY r.valid_until DESC LIMIT 1 FOR SHARE OF r,s`, [identity.id, input.actingSubject])).rows[0];
    if (!representation) throw new RealmAdminDenied('Current Realm creator authority is missing');
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope(input.realm)]);
    if (!(await client.query(`SELECT 1 FROM access.scope_gate WHERE id = $1 AND open AND dispatch_open FOR UPDATE`,
      [scope(input.realm)])).rowCount) throw new RealmAdminDenied('Realm management is unavailable');
    await client.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1) ON CONFLICT DO NOTHING', [input.realm]);
    const revision = (await client.query<{ generation: string }>(`SELECT generation::text
      FROM access.realm_admin_revision WHERE realm = $1 FOR UPDATE`, [input.realm])).rows[0]!;
    if (revision.generation !== '0' || (await client.query('SELECT 1 FROM access.realm_admin_owner_bootstrap WHERE realm = $1', [input.realm])).rowCount) {
      throw new RealmAdminStale('Realm already has management state');
    }
    const receiptId = randomUUID();
    await enrollRealmFounder(client, input.realm, input.actingSubject, { ...identity, ...representation }, admission.id, receiptId);
    await saveRealmSettings(client, input.realm, identity.id, command, `realm-created:${admission.id}`);
    await saveRealmAccessSettings(client, input.realm, { visibility: input.settings.visibility === 'private' ? 'private' : 'public',
      listing: 'listed', history: 'everything', admission: input.settings.selfJoin ? 'open' : 'invitation' });
    await client.query('UPDATE access.realm_admin_revision SET generation = 1 WHERE realm = $1', [input.realm]);
    await client.query('UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1', [scope(input.realm)]);
    const result = { realm: input.realm, accessRevision: '1', replayed: false };
    await client.query(`INSERT INTO access.realm_admin_receipt
      (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
      VALUES ($1,$2,$3,$4,$5,$6,'realm.initializeCreated','Initialize created Realm',$7)`,
    [receiptId, input.realm, identity.id, input.actingSubject, `realm-created:${admission.id}`, intent, result]);
    await client.query(`INSERT INTO access.realm_creation_initialization
      (admission_id,realm,creation_digest,access_revision) VALUES ($1,$2,$3,1)`,
    [admission.id, input.realm, input.creationDigest]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof RealmAdminDenied || error instanceof RealmAdminInvalid || error instanceof RealmAdminStale
      || error instanceof RealmAdminConflict || error instanceof RealmAdminUnavailable) throw error;
    if ((error as { code?: string }).code === '23505') throw new RealmAdminConflict('Identity is already in use');
    throw new RealmAdminUnavailable('Realm initialization could not complete', { cause: error });
  } finally { client.release(); }
}
