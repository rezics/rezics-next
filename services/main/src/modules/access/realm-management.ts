import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from './admission.ts';
import { REALM_ADMIN_COST, REALM_ROLE_CAP, REALM_ROLE_HOLDER_PREVIEW, REALM_ROLE_HOLDER_PROBE,
  REALM_ROLE_READ_LIMIT, RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid,
  RealmAdminLimit, RealmAdminStale, RealmAdminUnavailable, escalationCommand, roleCommand,
  realmPermissions, type EscalationCommand, type RealmPermission, type RoleCommand,
  type RoleImpact, memberCommand, type MemberCommand, settingsCommand, type SettingsCommand } from '../realm-admin/contract.ts';
import { enrollRealmFounder, initializeCreatedRealm, type RealmInitializationInput, type RealmInitializationResult } from './realm-initialization.ts';
export type { RealmInitializationInput, RealmInitializationResult } from './realm-initialization.ts';
import { changeRealmMember } from './realm-management-members.ts';
import { prepareRealmHistoryAdmission } from '../realm-admin/history.ts';
import { configureFollowGraph, prepareRealmFollow } from '../follows/recovery.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { registerFollowSpace } from '../follows/targets.ts';
import { searchRealmMembers } from './realm-management-search.ts';
import { readRealmSettings, saveRealmSettings, readRealmAccessSettings, saveRealmAccessSettings,
  applicableRealmSettings, applicableZoneSettings, lockSpaceSettingsGeneration, readSpaceSettingsGeneration } from './realm-management-settings.ts';
import { spaceSettingsCommand, type SpaceSettingsCommand, type ZoneSpaceSettings } from '../realm-admin/contract.ts';
import { settleRealmPolicy } from './realm-management-recovery.ts';
import { deliverZoneSpacePolicy, policyHead, readRealmPolicy, readZoneSpaceDisclosure, type ZoneSpacePolicyDelivery } from '../space/policy.ts';
import { zoneSpaceCreatorAllowed } from '../space/create-authority.ts';
import { platformAdministratorProof, platformAdministratorTargetAllowed } from './platform-administrator.ts';
import { representedGrantProof } from './represented-work-proof.ts';
import { realmActionScope } from './realm-management-authority.ts';
import { maintainerControllerProof } from '../work/maintainer-proof.ts';
import { DATASET, GRAPHS, iri, lit, RV, type WorkActivationEnvironment } from '../work/activate.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { WorkReadMissing } from '../work/read-session.ts';

export const realmAdminScope = (realm: string) => `governance:realm:${realm}`;
export const realmPermissionScope = realmActionScope;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
interface Role { id: string; name: string; permissions: RealmPermission[]; target_concept: string | null }
interface Assignment { member: string; valid_until: Date }
interface Grant { id: string; recipient_subject: string; action: RealmPermission;
  generation: string; valid_until: Date; role_id: string | null; scope_id: string }
interface Receipt { receiptId: string; generation: string; replayed: boolean }
interface MemberRosterRow { member: string; state: 'joined' | 'left' | 'not_joined';
  membership_generation: string; banned: boolean; banned_until: Date | null; joined_at: Date | null;
  roles: { id: string; name: string; validUntil: string; targetScope?: { kind: 'concept'; id: string } | null }[] }
interface RolePreviewRow extends Role {
  holders: unknown; more_holders: boolean }
interface RoleHolderPreview { member: string; banned: boolean }

const roleUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const conceptScope = (id: string | null) => id === null ? null : { kind: 'concept' as const, id };

/** The members read's ban flag. Role pages and the preview use this expression, so a ban cannot disagree. */
const banIsCurrent = (ban: string) =>
  `${ban}.active AND (${ban}.expires_at IS NULL OR ${ban}.expires_at > clock_timestamp())`;
const banJoin = (member: string) => `LEFT JOIN access.membership_ban b ON b.kind = 'realm'
    AND b.owner_subject = $1 AND b.member_subject = ${member}`;
/** A current assignment of this role. The roster lists that person, banned or not. */
const liveRoleHolder = (roleExpr: string) =>
  `holder.realm = $1 AND holder.role_id = ${roleExpr} AND holder.valid_until > clock_timestamp()`;

/** One member projection. The roster and a role filter both return it. */
function memberRosterSql(seek: string, limit = '$4'): string {
  return `SELECT team.member,
  COALESCE(m.state,'not_joined') AS state, COALESCE(m.generation,0)::text AS membership_generation,
  COALESCE(${banIsCurrent('b')}, false) AS banned,
  CASE WHEN ${banIsCurrent('b')} THEN b.expires_at ELSE NULL END AS banned_until,
  (SELECT h.changed_at FROM access.membership_history h WHERE h.membership_id = m.id
    AND h.state = 'joined' ORDER BY h.generation DESC LIMIT 1) AS joined_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name,
    'validUntil', a.valid_until, 'targetScope', CASE WHEN r.target_concept IS NULL THEN NULL
      ELSE jsonb_build_object('kind','concept','id',r.target_concept) END) ORDER BY r.id) FROM access.realm_admin_assignment a
    JOIN access.realm_admin_role r ON r.realm = a.realm AND r.id = a.role_id
    WHERE a.realm = $1 AND a.member = team.member AND a.valid_until > clock_timestamp()), '[]') AS roles
  FROM (${seek}) team
  LEFT JOIN access.membership m ON m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject = team.member
  ${banJoin('team.member')}
  ORDER BY team.member LIMIT ${limit}`;
}

/**
 * Memberships and current assignments, keyed by member id. Visibility is this
 * seek alone: inactive and institution members stay listed, and a ban is a flag.
 */
export const REALM_MEMBER_ROSTER_SQL = memberRosterSql(`(SELECT member_subject AS member FROM access.membership
    WHERE kind = 'realm' AND owner_subject = $1
      AND ($2::text IS NULL OR member_subject > $2)
      AND ($3::text[] IS NULL OR member_subject = ANY($3))
    ORDER BY member_subject LIMIT $4)
  UNION
  (SELECT DISTINCT member FROM access.realm_admin_assignment
    WHERE realm = $1 AND valid_until > clock_timestamp()
      AND ($2::text IS NULL OR member > $2)
      AND ($3::text[] IS NULL OR member = ANY($3))
    ORDER BY member LIMIT $4)`);

/**
 * The same projection, sought on (realm, role, member). An unknown role returns
 * no rows; it is not a separate existence check.
 * $1 realm, $2 after, $3 limit, $4 role.
 */
const roleHolderSeek = (matched: boolean) => `SELECT holder.member FROM access.realm_admin_assignment holder
    WHERE ${liveRoleHolder(matched ? '$5::uuid' : '$4::uuid')}
      AND holder.member > $2
      ${matched ? 'AND holder.member = ANY($3::text[])' : ''}
    ORDER BY holder.member LIMIT ${matched ? '$4' : '$3'}`;
export const REALM_ROLE_HOLDER_PAGE_SQL = memberRosterSql(roleHolderSeek(false), '$3');
/** The same page, restricted to one role-scoped name page. Never a realm-wide name page. */
export const REALM_ROLE_HOLDER_MATCH_PAGE_SQL = memberRosterSql(roleHolderSeek(true));

/**
 * Every role's first preview rows in one statement. Each lateral stops after the
 * probe, so the assignment reads are capped by the role page times that probe.
 * The people are the role filter's people, and `banned` is the roster's flag.
 */
export const REALM_ROLE_HOLDER_PREVIEW_SQL = `SELECT r.id, r.name, r.permissions, r.target_concept,
  COALESCE(h.holders, '[]'::jsonb) AS holders, COALESCE(h.more_holders, false) AS more_holders
  FROM (
    SELECT id, name, permissions, target_concept FROM access.realm_admin_role
    WHERE realm = $1 ORDER BY id LIMIT $2) r
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('member', page.member, 'banned', page.banned) ORDER BY page.ord)
        FILTER (WHERE page.ord <= $3), '[]'::jsonb) AS holders,
      COALESCE(bool_or(page.ord > $3), false) AS more_holders
    FROM (
      SELECT bounded.member, COALESCE(${banIsCurrent('b')}, false) AS banned,
        row_number() OVER (ORDER BY bounded.member) AS ord
      FROM (
        SELECT holder.member FROM access.realm_admin_assignment holder
        WHERE ${liveRoleHolder('r.id')}
        ORDER BY holder.member LIMIT $4) bounded
      ${banJoin('bounded.member')}) page) h ON true
  ORDER BY r.id`;

function holderPreviews(value: unknown): RoleHolderPreview[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { member?: unknown; banned?: unknown };
    return typeof row.member === 'string' ? [{ member: row.member, banned: row.banned === true }] : [];
  });
}

function memberItem(row: MemberRosterRow) {
  return { member: row.member, state: row.state, banned: row.banned,
    bannedUntil: row.banned_until?.toISOString() ?? null, membershipGeneration: row.membership_generation,
    joinedAt: row.joined_at?.toISOString() ?? null, roles: row.roles };
}

/** A sanction appeal is its own case. It is not a content report and has no owner escalation. */
export class AppealNotEscalable extends Error {
  constructor() {
    super('A sanction appeal cannot be escalated as a report');
  }
}

/** Access is the authority for both impact computation and role grant writes.
 * Realm roles are institutional bundles: editing a bundle updates its live
 * assignments atomically. Other direct grants remain independent. */
export class AccessRealmManagement {
  constructor(private readonly pool: Pool) {}
  configureFollowGraph(graph: Pick<FusekiClient,'query'>) { configureFollowGraph(this.pool,graph); }

  private async transaction<T>(realm: string, run: (client: PoolClient, generation: string) => Promise<T>,
    initialize = false, changesEpoch = true) {
    if (!native.test(realm)) throw new RealmAdminInvalid('Invalid Realm');
    const client = await this.pool.connect().catch(() => { throw new RealmAdminUnavailable('Access is unavailable'); });
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${REALM_ADMIN_COST.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${REALM_ADMIN_COST.statementTimeoutMs}ms'`);
      const fence = await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE');
      if (!fence.rowCount) throw new RealmAdminUnavailable('Access recovery is in progress');
      if (initialize) await client.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [realmAdminScope(realm)]);
      const gate = await client.query(`SELECT 1 FROM access.scope_gate WHERE id = $1
        AND open AND dispatch_open FOR ${changesEpoch ? 'UPDATE' : 'SHARE'}`, [realmAdminScope(realm)]);
      if (!gate.rowCount) throw new RealmAdminDenied('Realm management is unavailable');
      await client.query(`INSERT INTO access.realm_admin_revision (realm) VALUES ($1) ON CONFLICT DO NOTHING`, [realm]);
      const row = (await client.query<{ generation: string }>(`SELECT generation::text
        FROM access.realm_admin_revision WHERE realm = $1 FOR ${changesEpoch ? 'UPDATE' : 'SHARE'}`, [realm])).rows[0]!;
      const result = await run(client, row.generation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof RealmAdminDenied || error instanceof RealmAdminInvalid || error instanceof RealmAdminLimit
        || error instanceof RealmAdminStale || error instanceof RealmAdminConflict || error instanceof RealmAdminUnavailable
        || error instanceof AppealNotEscalable) throw error;
      if ((error as { code?: string }).code === '23505') throw new RealmAdminConflict('Identity is already in use');
      throw new RealmAdminUnavailable('Realm management could not complete');
    } finally { client.release(); }
  }

  private read<T>(realm: string, run: (client: PoolClient, generation: string) => Promise<T>) {
    return this.transaction(realm, run, false, false);
  }

  private async readDisclosedRoster<T>(realm: string, principal: VerifiedPrincipal,
    env: WorkActivationEnvironment | undefined, run: (client: PoolClient, generation: string) => Promise<T>) {
    const fence = async () => {
      if (!env) return;
      if (!await readRealmPolicy(env, realm)) throw new WorkReadMissing('Realm is unavailable');
      const decisions = await discloseInventory(env, [{ owner: 'graph', resource: realm,
        component: 'record' }], disclosureViewer(principal), 'read');
      if (decisions[0] !== 'visible') throw new WorkReadMissing('Realm is unavailable');
    };
    // A management grant does not exempt member identities from Realm closure.
    await fence();
    const result = await this.read(realm, run);
    await fence();
    return result;
  }

  /** One-time owner enrollment from the server-read successful creation receipt.
   * Replaying enrollment can never recreate a subsequently revoked grant.
   * Cost: one exact graph read (8 KiB), one admission probe and twelve grant rows. */
  async initialize(principal: VerifiedPrincipal, realm: string, actor: string, env: WorkActivationEnvironment) {
    if (!native.test(realm) || !native.test(actor)) throw new RealmAdminInvalid('Invalid Realm owner');
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?admission WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space rv:owner ${iri(actor)} ; rv:realmCapability ${iri(realm)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
        rv:realm ${iri(realm)} ; rv:space ?space ; rv:owner ${iri(actor)} ; rv:admissionId ?admission . }
    } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.receipt || !rows[0].admission) throw new RealmAdminDenied('Realm creation proof is unavailable');
    const proof = rows[0];
    return this.transaction(realm, async (client, generation) => {
      const identity = (await client.query<{ id: string; valid_until: string }>(`SELECT p.id,r.valid_until::text
        FROM access.principal p JOIN access.admission a ON a.principal_id = p.id
        JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3
          AND r.action IN ('space.create','agent.control') AND r.active AND r.valid_until > clock_timestamp()
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND a.id = $4
          AND a.acting_subject = $3 AND a.action = 'space.create' AND a.scope_id = 'space:create:root'
          AND a.graph_outcome = 'succeeded' AND a.graph_receipt = $5
        ORDER BY r.valid_until DESC LIMIT 1 FOR SHARE OF p,a,r,s`,
      [principal.issuer, principal.subject, actor, proof.admission!.value, proof.receipt!.value])).rows[0];
      if (!identity) throw new RealmAdminDenied('Current Realm creator authority is missing');
      const prior = (await client.query<{ receipt_id: string }>(`SELECT receipt_id
        FROM access.realm_admin_owner_bootstrap WHERE realm = $1`, [realm])).rows[0];
      if (prior) return { receiptId: prior.receipt_id, generation: '0', replayed: true };
      if (generation !== '0') throw new RealmAdminStale('Realm already has management state');
      const receiptId = randomUUID();
      await enrollRealmFounder(client, realm, actor, identity, proof.admission!.value, receiptId);
      const result = { receiptId, generation: '0', replayed: false };
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
        VALUES ($1,$2,$3,$4,$5,$6,'realm.initialize','Initialize Realm management',$7)`,
      [receiptId, realm, identity.id, actor, `realm-init:${realm.slice(-36)}`, digest({ realm, actor }), result]);
      return result;
    }, true);
  }

  /** Server-side completion of a successful Space creation; one Access commit. */
  initializeCreated(principal: VerifiedPrincipal, input: RealmInitializationInput,
    env: WorkActivationEnvironment): Promise<RealmInitializationResult> {
    return initializeCreatedRealm(this.pool, principal, input, env);
  }

  private async authorize(client: PoolClient, principal: VerifiedPrincipal, realm: string,
    actor: string, action: string): Promise<{ id: string; validUntil: Date }> {
    if (!native.test(actor)) throw new RealmAdminInvalid('Invalid acting subject');
    const row = await representedGrantProof(client, principal, actor,
      realmPermissionScope(realm, action), action, { lock: true });
    if (!row) throw new RealmAdminDenied('Realm permission is missing');
    return { id: row.principalId, validUntil: row.validUntil };
  }

  /** Whether `action` is granted. A missing grant is false; any other failure still aborts the read. */
  private async allowed(client: PoolClient, principal: VerifiedPrincipal, realm: string, actor: string, action: string) {
    try {
      await this.authorize(client, principal, realm, actor, action);
      return true;
    } catch (error) {
      if (error instanceof RealmAdminDenied) return false;
      throw error;
    }
  }

  private async write<T extends Receipt>(principal: VerifiedPrincipal, realm: string,
    input: { actingSubject: string; expectedGeneration: string; reason: string }, key: string,
    action: string, run: (client: PoolClient, principalId: string, id: string, generation: string,
      ceiling: Date) => Promise<T>, memberAction: 'add' | 'remove' | 'ban' | 'unban' | null = null): Promise<T> {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid command');
    const intent = digest({ realm, action, input });
    return this.transaction(realm, async (client, generation) => {
      const actor = await this.authorize(client, principal, realm, input.actingSubject, action);
      if (action === 'realm.settings.manage') {
        await this.authorize(client, principal, realm, input.actingSubject, 'governance.rule.publish');
      }
      const prior = (await client.query<{ request_digest: string; result: T }>(`SELECT request_digest, result
        FROM access.realm_admin_receipt WHERE principal_id = $1 AND idempotency_key = $2`, [actor.id, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== intent) throw new RealmAdminConflict('Key binds another intent');
        return { ...prior.result, replayed: true };
      }
      if (generation !== input.expectedGeneration) throw new RealmAdminStale('Realm management generation changed');
      const next = (BigInt(generation) + 1n).toString();
      const id = randomUUID();
      const result = await run(client, actor.id, id, next, actor.validUntil);
      await client.query(`UPDATE access.realm_admin_revision SET generation = generation + 1 WHERE realm = $1`, [realm]);
      if (action === 'realm.settings.manage') await client.query(`UPDATE access.scope_gate
        SET authority_epoch = authority_epoch + 1 WHERE id = $1`, [realmAdminScope(realm)]);
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id, realm, principal_id, acting_subject, idempotency_key, request_digest, action, reason, result,
          member_action)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, realm, actor.id, input.actingSubject, key, intent, action, input.reason, result, memberAction]);
      return result;
    });
  }

  async changeMember(principal: VerifiedPrincipal, realm: string, input: MemberCommand, key: string, env?: WorkActivationEnvironment) {
    if (!Value.Check(memberCommand, input)) throw new RealmAdminInvalid('Invalid member change');
    const identity = input.action==='add' ? await prepareRealmFollow(this.pool,realm,env?.fuseki) : null;
    const historyAdmission = input.action === 'add' ? await prepareRealmHistoryAdmission(this.pool,env,realm) : undefined;
    return this.write(principal, realm, input, key, 'realm.members.manage',
      async (client, principalId, receiptId, generation) => {
        if (identity) await registerFollowSpace(client,identity);
        return { receiptId, generation, replayed: false,
          ...await changeRealmMember(client, realm, input, principalId, receiptId, env, historyAdmission) };
      }, input.action);
  }

  private async settlePolicy(realm: string, env?: WorkActivationEnvironment) {
    await settleRealmPolicy(this.pool, realm, env);
  }

  async settings(principal: VerifiedPrincipal, realm: string, actor: string, env?: WorkActivationEnvironment) {
    await this.settlePolicy(realm, env);
    return this.read(realm, async (client, generation) => {
      await this.authorize(client, principal, realm, actor, 'realm.settings.manage');
      return { generation, ...await readRealmSettings(client, realm) };
    });
  }

  async changeSettings(principal: VerifiedPrincipal, realm: string, input: SettingsCommand, key: string, env?: WorkActivationEnvironment) {
    if (!Value.Check(settingsCommand, input)) throw new RealmAdminInvalid('Invalid Realm settings');
    await this.settlePolicy(realm, env);
    const result = await this.write(principal, realm, input, key, 'realm.settings.manage',
      async (client, principalId, receiptId, generation) => {
        if ((await client.query('SELECT 1 FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered', [realm])).rowCount) {
          throw new RealmAdminUnavailable('Realm policy publication is pending; retry');
        }
        if (!env && (input.settings.visibility !== 'public' || input.settings.reviewMode || !input.settings.reviewRequired)) {
          throw new RealmAdminUnavailable('Realm policy publication needs the graph owner');
        }
        const saved = await saveRealmSettings(client, realm, principalId, input, key);
        if (env) await this.queuePolicy(client, realm, receiptId, generation);
        return { receiptId, generation, replayed: false, ...saved };
      });
    await this.settlePolicy(realm, env);
    return result;
  }

  private async queuePolicy(client: PoolClient, realm: string, receipt: string, generation: string) {
    await client.query(`INSERT INTO access.realm_policy_delivery
      (realm,receipt_id,generation,policy_head,visibility,review_mode,listing,history,admission)
      SELECT s.realm,$2,$3,$4,s.visibility,s.review_mode,s.listing,s.history,
        CASE WHEN s.self_join THEN 'open' ELSE COALESCE(p.admission,'invitation') END FROM access.realm_admin_settings s
      LEFT JOIN access.membership_policy p ON p.kind = 'realm' AND p.owner_subject = s.realm WHERE s.realm = $1
      ON CONFLICT (realm) DO UPDATE SET receipt_id = EXCLUDED.receipt_id,generation = EXCLUDED.generation,
        policy_head = EXCLUDED.policy_head,
        visibility = EXCLUDED.visibility,review_mode = EXCLUDED.review_mode,listing = EXCLUDED.listing,
        history = EXCLUDED.history,admission = EXCLUDED.admission,delivered = false`, [realm,receipt,generation,policyHead(receipt)]);
  }

  /** One bounded lookup. A live Realm capability keeps the Realm settings path.
   * A Zone-only Space is the space-zone profile with no Realm capability. */
  private async spaceKind(space: string, env: WorkActivationEnvironment): Promise<
    { kind: 'realm'; realm: string } | { kind: 'zone'; zone: string }> {
    if (!native.test(space)) throw new RealmAdminInvalid('Invalid Space');
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?zone ?profile WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(space)} a rv:Space .
        OPTIONAL { ${iri(space)} rv:realmCapability ?realm .
          ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(space)} . }
        OPTIONAL { ${iri(space)} rv:definitionProfile ?profile ; rv:zoneCapability ?zone .
          ?zone a rv:Zone ; rv:space ${iri(space)} ; rv:zoneState rv:Active . } }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (rows.length !== 1) throw new RealmAdminDenied('Space management is unavailable');
    const row = rows[0]!;
    if (row.realm?.value) return { kind: 'realm', realm: row.realm.value };
    if (row.zone?.value && row.profile?.value === 'https://rezics.com/definition/space-zone-v1') {
      return { kind: 'zone', zone: row.zone.value };
    }
    throw new RealmAdminDenied('Space management is unavailable');
  }

  /** Zone edit authority: a verified Zone Space creator, or the platform
   * administrator who already holds zone.edit on this Zone. No new grant. */
  private async authorizeZone(client: PoolClient, principal: VerifiedPrincipal, zone: string,
    actor: string, env: WorkActivationEnvironment): Promise<string> {
    if (!native.test(actor)) throw new RealmAdminInvalid('Invalid acting subject');
    const identity = (await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [principal.issuer, principal.subject])).rows[0];
    if (!identity) throw new RealmAdminDenied('Zone permission is missing');
    const scope = `zone:edit:${zone}`;
    if (await platformAdministratorProof(client, identity.id, actor, true, { action: 'zone.edit', scope })
      && await platformAdministratorTargetAllowed(client, env.fuseki, identity.id, actor, 'zone.edit', scope)) {
      return identity.id;
    }
    if (principal.emailVerified === true && await maintainerControllerProof(client, identity.id, actor)
      && await zoneSpaceCreatorAllowed(client, env.fuseki, identity.id, actor, zone)) return identity.id;
    throw new RealmAdminDenied('Zone permission is missing');
  }

  private async zoneSettingsTransaction<T>(space: string, exclusive: boolean,
    run: (client: PoolClient, generation: string) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => { throw new RealmAdminUnavailable('Access is unavailable'); });
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${REALM_ADMIN_COST.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${REALM_ADMIN_COST.statementTimeoutMs}ms'`);
      const fence = await client.query('SELECT 1 FROM access.recovery_fence WHERE id AND open FOR SHARE');
      if (!fence.rowCount) throw new RealmAdminUnavailable('Access recovery is in progress');
      const generation = exclusive ? await lockSpaceSettingsGeneration(client, space)
        : await readSpaceSettingsGeneration(client, space);
      const result = await run(client, generation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof RealmAdminDenied || error instanceof RealmAdminInvalid || error instanceof RealmAdminLimit
        || error instanceof RealmAdminStale || error instanceof RealmAdminConflict || error instanceof RealmAdminUnavailable) throw error;
      if ((error as { code?: string }).code === '23505') throw new RealmAdminConflict('Identity is already in use');
      throw new RealmAdminUnavailable('Space settings could not complete');
    } finally { client.release(); }
  }

  private async publishZoneSpace(env: WorkActivationEnvironment, delivery: ZoneSpacePolicyDelivery) {
    try { await deliverZoneSpacePolicy(env, delivery); }
    catch (error) {
      if (error instanceof RealmAdminUnavailable) throw error;
      throw new RealmAdminUnavailable('Space policy publication is pending; retry', { cause: error });
    }
  }

  private async recoverZoneSpace(space: string, env: WorkActivationEnvironment) {
    const pending = (await this.pool.query<{ result: { zone: string; receiptId: string; generation: string;
      settings: ZoneSpaceSettings } }>(`SELECT result FROM access.realm_admin_receipt
      WHERE realm = $1 AND action = 'zone.edit' ORDER BY created_at DESC, id DESC LIMIT 1`, [space])).rows[0];
    if (!pending?.result?.settings || !pending.result.zone || !pending.result.receiptId) return;
    await this.publishZoneSpace(env, { space, zone: pending.result.zone, receipt_id: pending.result.receiptId,
      generation: pending.result.generation, visibility: pending.result.settings.visibility,
      listing: pending.result.settings.listing });
  }

  async spaceSettings(principal: VerifiedPrincipal, space: string, actor: string, env: WorkActivationEnvironment) {
    const kind = await this.spaceKind(space, env);
    if (kind.kind === 'realm') {
      await this.settlePolicy(kind.realm, env);
      return this.read(kind.realm, async (client, generation) => {
        await this.authorize(client, principal, kind.realm, actor, 'realm.settings.manage');
        return { space, realm: kind.realm, generation, settings: await readRealmAccessSettings(client, kind.realm) };
      });
    }
    await this.recoverZoneSpace(space, env);
    return this.zoneSettingsTransaction(space, false, async client => {
      await this.authorizeZone(client, principal, kind.zone, actor, env);
      const current = await readZoneSpaceDisclosure(env, space);
      if (!current || current.zone !== kind.zone) throw new RealmAdminDenied('Space management is unavailable');
      return { space, zone: kind.zone, generation: await readSpaceSettingsGeneration(client, space),
        settings: { visibility: current.visibility, listing: current.listing } };
    });
  }

  async changeSpaceSettings(principal: VerifiedPrincipal, space: string, input: SpaceSettingsCommand,
    key: string, env: WorkActivationEnvironment) {
    if (!Value.Check(spaceSettingsCommand, input)) throw new RealmAdminInvalid('Invalid Space settings');
    const kind = await this.spaceKind(space, env);
    if (kind.kind === 'realm') {
      const settings = applicableRealmSettings(input.settings);
      const realm = kind.realm;
      await this.settlePolicy(realm, env);
      const result = await this.write(principal, realm, input, key, 'realm.settings.manage',
        async (client, _principal, receiptId, generation) => {
          if ((await client.query('SELECT 1 FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered', [realm])).rowCount) {
            throw new RealmAdminUnavailable('Space policy publication is pending; retry');
          }
          await saveRealmAccessSettings(client, realm, settings);
          await this.queuePolicy(client, realm, receiptId, generation);
          return { space, realm, receiptId, generation, replayed: false, settings };
        });
      await this.settlePolicy(realm, env);
      return result;
    }
    const settings = applicableZoneSettings(input.settings);
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid command');
    const intent = digest({ space, action: 'zone.edit', input });
    const committed = await this.zoneSettingsTransaction(space, true, async (client, generation) => {
      const principalId = await this.authorizeZone(client, principal, kind.zone, input.actingSubject, env);
      const prior = (await client.query<{ request_digest: string; result: { receiptId: string; generation: string;
        settings: ZoneSpaceSettings; zone: string } }>(`SELECT request_digest, result
        FROM access.realm_admin_receipt WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
      if (prior) {
        if (prior.request_digest !== intent) throw new RealmAdminConflict('Key binds another intent');
        return { ...prior.result, space, replayed: true as const };
      }
      if (generation !== input.expectedGeneration) throw new RealmAdminStale('Realm management generation changed');
      const next = (BigInt(generation) + 1n).toString();
      const receiptId = randomUUID();
      const result = { space, zone: kind.zone, receiptId, generation: next, replayed: false as const, settings };
      await client.query(`UPDATE access.realm_admin_revision SET generation = generation + 1 WHERE realm = $1`, [space]);
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id, realm, principal_id, acting_subject, idempotency_key, request_digest, action, reason, result, member_action)
        VALUES ($1,$2,$3,$4,$5,$6,'zone.edit',$7,$8,NULL)`,
      [receiptId, space, principalId, input.actingSubject, key, intent, input.reason, result]);
      return result;
    });
    await this.publishZoneSpace(env, { space, zone: committed.zone, receipt_id: committed.receiptId,
      generation: committed.generation, visibility: committed.settings.visibility, listing: committed.settings.listing });
    return committed;
  }

  roles(principal: VerifiedPrincipal, realm: string, actor: string, env?: WorkActivationEnvironment) {
    return this.readDisclosedRoster(realm, principal, env, async (client, generation) => {
      await this.authorize(client, principal, realm, actor, 'realm.roles.manage');
      // Holder names are member identities. Only someone who can already read
      // members may see them. Null, not [], so a roles-only manager is not told
      // the role is unused. The holder query does not run otherwise.
      const seeHolders = await this.allowed(client, principal, realm, actor, 'realm.members.manage');
      if (!seeHolders) {
        const rows = (await client.query<Role>(
          `SELECT id, name, permissions, target_concept FROM access.realm_admin_role
           WHERE realm = $1 ORDER BY id LIMIT $2`, [realm, REALM_ROLE_READ_LIMIT + 1])).rows;
        if (rows.length > REALM_ROLE_READ_LIMIT) throw new RealmAdminLimit('Realm role budget exceeded');
        return { generation, cap: REALM_ROLE_CAP, roles: rows.map(row => ({ id: row.id, name: row.name,
          permissions: row.permissions, targetScope: conceptScope(row.target_concept), holders: null, moreHolders: null })) };
      }
      const rows = (await client.query<RolePreviewRow>(REALM_ROLE_HOLDER_PREVIEW_SQL,
        [realm, REALM_ROLE_READ_LIMIT + 1, REALM_ROLE_HOLDER_PREVIEW, REALM_ROLE_HOLDER_PROBE])).rows;
      if (rows.length > REALM_ROLE_READ_LIMIT) throw new RealmAdminLimit('Realm role budget exceeded');
      return { generation, cap: REALM_ROLE_CAP, roles: rows.map(row => ({ id: row.id, name: row.name,
        permissions: row.permissions, targetScope: conceptScope(row.target_concept),
        holders: holderPreviews(row.holders), moreHolders: row.more_holders === true })) };
    });
  }

  members(principal: VerifiedPrincipal, realm: string,
    options: { actingSubject: string; search?: string; role?: string; after?: string; limit?: number },
    env?: WorkActivationEnvironment) {
    const limit = options.limit ?? REALM_ADMIN_COST.page;
    if (!Number.isInteger(limit) || limit < 1 || limit > REALM_ADMIN_COST.page
      || options.after && !native.test(options.after) || (options.search?.length ?? 0) > 80
      || options.role !== undefined && !roleUuid.test(options.role)) {
      throw new RealmAdminInvalid('Invalid member page');
    }
    return this.readDisclosedRoster(realm, principal, env, async (client, generation) => {
      await this.authorize(client, principal, realm, options.actingSubject, 'realm.members.manage');
      // A role search seeks holders, then this page projects them. A realm-wide
      // name page would drop holders who sort after it.
      const matches = !options.search?.trim() ? null
        : await searchRealmMembers(client, realm, options.search, options.after, limit + 1, options.role);
      // This is the Agent team roster. Private principal memberships never
      // disclose account identities through this listing. A role is the same
      // roster, sought by (realm, role, member).
      const after = options.after ?? null;
      // An empty lower bound keeps the role seek a range on (realm, role, member), so it stops at the page.
      const roleAfter = options.after ?? '';
      const rows = (await client.query<MemberRosterRow>(
        !options.role ? REALM_MEMBER_ROSTER_SQL : matches ? REALM_ROLE_HOLDER_MATCH_PAGE_SQL : REALM_ROLE_HOLDER_PAGE_SQL,
      !options.role ? [realm, after, matches, limit + 1]
        : matches ? [realm, roleAfter, matches, limit + 1, options.role]
        : [realm, roleAfter, limit + 1, options.role])).rows;
      return { generation, items: rows.slice(0, limit).map(memberItem),
        nextCursor: rows.length > limit ? rows[limit - 1]!.member : null };
    });
  }

  private async plan(client: PoolClient, realm: string, input: RoleCommand, ceiling: Date) {
    const change = input.change;
    if (change.kind === 'role' && !change.name.trim()) throw new RealmAdminInvalid('Role name must not be empty');
    const role = (await client.query<Role>(`SELECT id, name, permissions, target_concept FROM access.realm_admin_role
      WHERE realm = $1 AND id = $2`, [realm, change.roleId])).rows[0];
    if (!role && change.kind === 'assignment') throw new RealmAdminInvalid('Role is unavailable');
    if (!role) {
      const count = await client.query(`SELECT 1 FROM access.realm_admin_role WHERE realm = $1 LIMIT $2`,
        [realm, REALM_ADMIN_COST.roles]);
      if (count.rows.length >= REALM_ADMIN_COST.roles) throw new RealmAdminLimit('Realm role budget exceeded');
    }
    const permissions = change.kind === 'role' ? change.permissions : role!.permissions;
    const previousConcept = role?.target_concept ?? null;
    const targetConcept = change.kind === 'role' && change.targetScope !== undefined
      ? change.targetScope?.id ?? null : previousConcept;
    if (change.kind === 'assignment' && change.targetScope !== undefined
      && (change.targetScope?.id ?? null) !== targetConcept) {
      throw new RealmAdminInvalid('Assignment jurisdiction must match its role');
    }
    const concepts = [...new Set([previousConcept, targetConcept])];
    const scopes = concepts.flatMap(concept => realmPermissions.map(action => realmPermissionScope(realm, action, concept)));
    const ownedGrants = await client.query<{ member: string }>(`SELECT member FROM access.realm_admin_role_grant
      WHERE realm = $1 AND role_id = $2 LIMIT $3`,
    [realm, change.roleId, REALM_ADMIN_COST.assignments * REALM_ADMIN_COST.permissions + 1]);
    if (ownedGrants.rows.length > REALM_ADMIN_COST.assignments * REALM_ADMIN_COST.permissions) {
      throw new RealmAdminLimit('Role grant cleanup exceeds its mutation budget');
    }
    if (change.kind === 'assignment' && change.assigned
      && ownedGrants.rows.filter(row => row.member !== change.member).length + permissions.length
        > REALM_ADMIN_COST.assignments * REALM_ADMIN_COST.permissions) {
      throw new RealmAdminLimit('Expire or remove old assignments before adding more role grants');
    }
    const assignments = change.kind === 'role'
      ? (await client.query<Assignment>(`SELECT b.member, b.valid_until FROM access.realm_admin_assignment b
          JOIN access.authority_subject a ON a.id = b.member AND a.active
          WHERE b.realm = $1 AND b.role_id = $2 AND b.valid_until > clock_timestamp()
          ORDER BY b.member LIMIT $3`, [realm, change.roleId, REALM_ADMIN_COST.assignments + 1])).rows
      : [{ member: change.member, valid_until: new Date(change.validUntil) }];
    if (assignments.length > REALM_ADMIN_COST.assignments) throw new RealmAdminLimit('Role impact exceeds its exact preview budget');
    if ((change.kind === 'role' && permissions.length > 0 || change.kind === 'assignment' && change.assigned)
      && assignments.some(a => a.valid_until <= new Date() || a.valid_until > ceiling)) {
      throw new RealmAdminDenied('Assignment exceeds administrator authority lifetime');
    }
    if (change.kind === 'assignment' && change.assigned) {
      const count = await client.query(`SELECT 1 FROM access.realm_admin_assignment
        WHERE realm = $1 AND role_id = $2 AND member <> $3 AND valid_until > clock_timestamp() LIMIT $4`,
      [realm, change.roleId, change.member, REALM_ADMIN_COST.assignments]);
      if (count.rows.length >= REALM_ADMIN_COST.assignments) throw new RealmAdminLimit('Role assignment budget exceeded');
    }
    const members = assignments.map(a => a.member);
    const subjects = (await client.query<{ id: string }>(`SELECT id FROM access.authority_subject
      WHERE id = ANY($1::text[]) AND active AND kind = 'agent' FOR SHARE`, [members])).rows;
    if (change.kind === 'assignment' && change.assigned && subjects.length !== members.length) {
      throw new RealmAdminDenied('Assignment member is unavailable');
    }
    if (change.kind === 'role' || change.assigned) {
      const ban = await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm'
        AND owner_subject = $1 AND member_subject = ANY($2::text[]) AND active
        AND (expires_at IS NULL OR expires_at > clock_timestamp()) LIMIT 1`, [realm, members]);
      if (ban.rowCount) throw new RealmAdminDenied('Role member is banned');
    }
    const grants = (await client.query<Grant>(`SELECT g.id, g.recipient_subject, g.action,
      g.generation::text, g.valid_until, g.scope_id, link.role_id FROM access.permission_grant g
      JOIN access.authority_subject a ON a.id = g.recipient_subject AND a.active
      LEFT JOIN access.realm_admin_role_grant link ON link.grant_id = g.id
      WHERE g.recipient_subject = ANY($1::text[]) AND g.scope_id = ANY($2::text[])
        AND g.action = ANY($3::text[]) AND g.active AND g.valid_until > clock_timestamp()
        AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
          WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
      ORDER BY g.id LIMIT $4 FOR SHARE OF g`,
    [members, scopes, realmPermissions, REALM_ADMIN_COST.grantRows + 1])).rows;
    if (grants.length > REALM_ADMIN_COST.grantRows) throw new RealmAdminLimit('Grant impact exceeds its exact preview budget');
    const byMember = new Map<string, Grant[]>();
    for (const grant of grants) {
      const group = byMember.get(grant.recipient_subject) ?? [];
      group.push(grant);
      byMember.set(grant.recipient_subject, group);
    }
    const changes: RoleImpact['changes'] = [];
    for (const member of members) {
      const current = byMember.get(member) ?? [];
      const jurisdictions = concepts.flatMap(concept => {
        const scoped = current.filter(g => g.scope_id === realmPermissionScope(realm, g.action, concept));
        const before = new Set(scoped.map(g => g.action));
        const after = new Set(scoped.filter(g => g.role_id !== change.roleId).map(g => g.action));
        if (concept === targetConcept && (change.kind === 'role' || change.assigned)) {
          for (const permission of permissions) after.add(permission);
        }
        const gained = realmPermissions.filter(p => !before.has(p) && after.has(p));
        const lost = realmPermissions.filter(p => before.has(p) && !after.has(p));
        return gained.length || lost.length ? [{ targetScope: conceptScope(concept), gained, lost }] : [];
      });
      const gained = realmPermissions.filter(p => jurisdictions.some(j => j.gained.includes(p)));
      const lost = realmPermissions.filter(p => jurisdictions.some(j => j.lost.includes(p)));
      if (jurisdictions.length) changes.push({ member, gained, lost, jurisdictions });
    }
    const impact: RoleImpact = { digest: digest({ realm, input, role, assignments, grants, changes }),
      generation: input.expectedGeneration, exact: true, affectedCount: changes.length, changes,
      targetScope: conceptScope(targetConcept), previousTargetScope: conceptScope(previousConcept) };
    return { role, permissions, assignments, impact, targetConcept };
  }

  preview(principal: VerifiedPrincipal, realm: string, input: RoleCommand) {
    if (!Value.Check(roleCommand, input)) throw new RealmAdminInvalid('Invalid role change');
    return this.read(realm, async (client, generation) => {
      const actor = await this.authorize(client, principal, realm, input.actingSubject, 'realm.roles.manage');
      if (generation !== input.expectedGeneration) throw new RealmAdminStale('Realm management generation changed');
      return (await this.plan(client, realm, input, actor.validUntil)).impact;
    });
  }

  changeRole(principal: VerifiedPrincipal, realm: string, input: RoleCommand, key: string, impactDigest: string) {
    if (!Value.Check(roleCommand, input) || !/^[0-9a-f]{64}$/.test(impactDigest)) throw new RealmAdminInvalid('Invalid role change');
    const boundInput = { ...input, impactDigest };
    return this.write(principal, realm, boundInput, key, 'realm.roles.manage',
      async (client, principalId, receiptId, generation, ceiling) => {
        const plan = await this.plan(client, realm, input, ceiling);
        if (plan.impact.digest !== impactDigest) throw new RealmAdminStale('Role impact changed; preview again');
        const change = input.change;
        if (change.kind === 'role') await client.query(`INSERT INTO access.realm_admin_role (realm,id,name,permissions,target_concept)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (realm,id) DO UPDATE SET name = EXCLUDED.name,
            permissions = EXCLUDED.permissions, target_concept = EXCLUDED.target_concept`,
        [realm, change.roleId, change.name.trim(), plan.permissions, plan.targetConcept]);
        // Revoke only grants owned by this bundle. Independent grants survive.
        await client.query(`UPDATE access.permission_grant g SET active = false
          FROM access.realm_admin_role_grant l WHERE l.grant_id = g.id AND l.realm = $1
            AND l.role_id = $2 AND ($3::text IS NULL OR l.member = $3) AND g.active`,
        [realm, change.roleId, change.kind === 'assignment' ? change.member : null]);
        await client.query(`DELETE FROM access.realm_admin_role_grant WHERE realm = $1
          AND role_id = $2 AND ($3::text IS NULL OR member = $3)`,
        [realm, change.roleId, change.kind === 'assignment' ? change.member : null]);
        if (change.kind === 'assignment') await client.query(`INSERT INTO access.realm_admin_assignment
          (realm,role_id,member,valid_until) VALUES ($1,$2,$3,$4)
          ON CONFLICT (realm,role_id,member) DO UPDATE SET valid_until = EXCLUDED.valid_until`,
        [realm, change.roleId, change.member, change.assigned ? change.validUntil : new Date(0)]);
        if (change.kind === 'role' || change.assigned) {
          await client.query(`INSERT INTO access.scope_gate (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
            [plan.permissions.map(action => realmPermissionScope(realm, action, plan.targetConcept))]);
          // One bounded set insert rather than one query per member/permission.
          await client.query(`WITH recipients AS (SELECT * FROM unnest($4::text[], $5::timestamptz[])
            AS r(member, valid_until)), inserted AS (
            INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
            SELECT gen_random_uuid(),$2,r.member,p.scope,p.action,r.valid_until,$7 FROM recipients r
              CROSS JOIN unnest($3::text[],$6::text[]) AS p(scope,action) RETURNING id,recipient_subject)
            INSERT INTO access.realm_admin_role_grant (realm,role_id,member,grant_id)
            SELECT $1,$8,recipient_subject,id FROM inserted`,
          [realm, input.actingSubject, plan.permissions.map(action => realmPermissionScope(realm, action, plan.targetConcept)), plan.assignments.map(a => a.member),
            plan.assignments.map(a => a.valid_until), plan.permissions, principalId, change.roleId]);
        }
        return { receiptId, generation, replayed: false, impact: plan.impact,
          auditDetail: { kind: change.kind,
            role: { id: change.roleId, name: change.kind === 'role' ? change.name.trim() : plan.role!.name,
              targetScope: conceptScope(plan.targetConcept) },
            member: change.kind === 'assignment' ? change.member : null,
            assigned: change.kind === 'assignment' ? change.assigned : null,
            validUntil: change.kind === 'assignment' && change.assigned ? change.validUntil : null,
            changes: plan.impact.changes },
          notificationRole: { id: change.roleId,
            name: change.kind === 'role' ? change.name.trim() : plan.role!.name } };
      });
  }

  escalate(principal: VerifiedPrincipal, realm: string, input: EscalationCommand, key: string) {
    if (!Value.Check(escalationCommand, input)) throw new RealmAdminInvalid('Invalid escalation');
    return this.write(principal, realm, input, key, 'governance.moderate',
      async (client, _principalId, receiptId, generation) => {
        if (input.itemKind === 'submission') await this.authorize(client, principal, realm, input.actingSubject, 'review.decide');
        const owner = await client.query(`SELECT 1 FROM access.permission_grant g
          JOIN access.authority_subject a ON a.id = g.recipient_subject AND a.active
          WHERE g.scope_id = $1 AND g.action = 'realm.owner' AND g.active
            AND g.valid_until > clock_timestamp() LIMIT 1 FOR SHARE OF g, a`, [realmAdminScope(realm)]);
        if (!owner.rowCount) throw new RealmAdminDenied('Realm owner authority is unavailable');
        if (input.itemKind === 'report') {
          const item = await client.query<{ kind: string }>(`SELECT kind FROM access.governance_case WHERE id = $1 AND context = $2
              AND authority_kind = 'realm' AND authority_scope_id = $3 AND state = 'open'
              AND generation = $4 FOR UPDATE`,
            [input.itemId, realm, realmAdminScope(realm), input.expectedItemGeneration]);
          if (!item.rowCount) throw new RealmAdminStale('Queue item is unavailable or already decided');
          if (item.rows[0]!.kind === 'realm_sanction_appeal') throw new AppealNotEscalable();
        } else {
          const item = await client.query(`SELECT id FROM access.realm_submission WHERE id = $1 AND realm = $2
              AND state = 'pending' AND generation = $3 FOR UPDATE`, [input.itemId, realm, input.expectedItemGeneration]);
          if (!item.rowCount) throw new RealmAdminStale('Queue item is unavailable or already decided');
        }
        const row = (await client.query<{ escalated_at: Date }>(`INSERT INTO access.realm_admin_escalation
          (id,realm,item_kind,item_id,reason,acting_subject) VALUES ($1,$2,$3,$4,$5,$6) RETURNING escalated_at`,
        [receiptId, realm, input.itemKind, input.itemId, input.reason, input.actingSubject])).rows[0]!;
        return { receiptId, generation, replayed: false, escalation: { id: receiptId, reason: input.reason,
          actingSubject: input.actingSubject, escalatedAt: row.escalated_at.toISOString(), target: 'owners' as const } };
      });
  }
}
