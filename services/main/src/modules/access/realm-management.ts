import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from './admission.ts';
import { REALM_ADMIN_COST, RealmAdminConflict, RealmAdminDenied, RealmAdminInvalid,
  RealmAdminLimit, RealmAdminStale, RealmAdminUnavailable, escalationCommand, roleCommand,
  realmPermissions, type EscalationCommand, type RealmPermission, type RoleCommand,
  type RoleImpact, memberCommand, type MemberCommand, settingsCommand, type SettingsCommand } from '../realm-admin/contract.ts';
import { changeRealmMember } from './realm-management-members.ts';
import { configureFollowGraph, prepareRealmFollow } from '../follows/recovery.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { registerFollowSpace } from '../follows/targets.ts';
import { searchRealmMembers } from './realm-management-search.ts';
import { readRealmSettings, saveRealmSettings, readRealmAccessSettings, saveRealmAccessSettings } from './realm-management-settings.ts';
import { spaceSettingsCommand, type SpaceSettingsCommand } from '../realm-admin/contract.ts';
import { settleRealmPolicy } from './realm-management-recovery.ts';
import { DATASET, GRAPHS, iri, lit, RV, type WorkActivationEnvironment } from '../work/activate.ts';

export const realmAdminScope = (realm: string) => `governance:realm:${realm}`;
export const realmPermissionScope = (realm: string, action: string) => action === 'review.decide'
  ? `review:decide:${realm}` : action === 'publication.adopt' ? `publication:adopt:${realm}` : realmAdminScope(realm);
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
interface Role { id: string; name: string; permissions: RealmPermission[] }
interface Assignment { member: string; valid_until: Date }
interface Grant { id: string; recipient_subject: string; action: RealmPermission;
  generation: string; valid_until: Date; role_id: string | null }
interface Receipt { receiptId: string; generation: string; replayed: boolean }

/** Access is the authority for both impact computation and role grant writes.
 * Realm roles are institutional bundles: editing a bundle updates its live
 * assignments atomically. Other direct grants remain independent. */
export class AccessRealmManagement {
  constructor(private readonly pool: Pool) {}
  configureFollowGraph(graph: Pick<FusekiClient,'query'>) { configureFollowGraph(this.pool,graph); }

  private async transaction<T>(realm: string, run: (client: PoolClient, generation: string) => Promise<T>, initialize = false) {
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
        AND open AND dispatch_open FOR UPDATE`, [realmAdminScope(realm)]);
      if (!gate.rowCount) throw new RealmAdminDenied('Realm management is unavailable');
      await client.query(`INSERT INTO access.realm_admin_revision (realm) VALUES ($1) ON CONFLICT DO NOTHING`, [realm]);
      const row = (await client.query<{ generation: string }>(`SELECT generation::text
        FROM access.realm_admin_revision WHERE realm = $1 FOR UPDATE`, [realm])).rows[0]!;
      const result = await run(client, row.generation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof RealmAdminDenied || error instanceof RealmAdminInvalid || error instanceof RealmAdminLimit
        || error instanceof RealmAdminStale || error instanceof RealmAdminConflict || error instanceof RealmAdminUnavailable) throw error;
      if ((error as { code?: string }).code === '23505') throw new RealmAdminConflict('Identity is already in use');
      throw new RealmAdminUnavailable('Realm management could not complete');
    } finally { client.release(); }
  }

  /** One-time owner enrollment from the server-read successful creation receipt.
   * Replaying enrollment can never recreate a subsequently revoked grant.
   * Cost: one exact graph read (8 KiB), one admission probe and eleven grant rows. */
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
      await client.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution') ON CONFLICT DO NOTHING`, [realm]);
      await client.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
        VALUES ('realm',$1,0,'realm-membership-v1') ON CONFLICT DO NOTHING`, [realm]);
      await client.query(`INSERT INTO access.scope_gate (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`,
        [[`review:decide:${realm}`, `publication:adopt:${realm}`,
          `realm:profile:${realm}`, `media:avatar:${realm}`]]);
      await client.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
        SELECT gen_random_uuid(),$1,$1,scope,action,$3,$4 FROM unnest($2::text[],$5::text[]) AS p(scope,action)`,
      [actor, [...realmPermissions, 'realm.owner'].map(action => realmPermissionScope(realm, action))
        .concat(`realm:profile:${realm}`, `media:avatar:${realm}`), identity.valid_until, identity.id,
        [...realmPermissions, 'realm.owner', 'realm.profile.publish', 'media.avatar']]);
      await client.query(`INSERT INTO access.representation
        (id,principal_id,subject_id,action,valid_until)
        SELECT gen_random_uuid(),$1,$2,action,$3 FROM unnest($4::text[]) AS p(action)`,
      [identity.id, actor, identity.valid_until, ['realm.profile.publish', 'media.avatar']]);
      await client.query(`INSERT INTO access.realm_admin_owner_bootstrap
        (realm,owner_subject,admission_id,receipt_id,principal_id) VALUES ($1,$2,$3,$4,$5)`,
      [realm, actor, proof.admission!.value, receiptId, identity.id]);
      const result = { receiptId, generation: '0', replayed: false };
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
        VALUES ($1,$2,$3,$4,$5,$6,'realm.initialize','Initialize Realm management',$7)`,
      [receiptId, realm, identity.id, actor, `realm-init:${realm.slice(-36)}`, digest({ realm, actor }), result]);
      return result;
    }, true);
  }

  private async authorize(client: PoolClient, principal: VerifiedPrincipal, realm: string,
    actor: string, action: string): Promise<{ id: string; validUntil: Date }> {
    if (!native.test(actor)) throw new RealmAdminInvalid('Invalid acting subject');
    const row = (await client.query<{ id: string; valid_until: Date }>(`SELECT p.id,
      LEAST(r.valid_until, g.valid_until) AS valid_until FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3
        AND r.active AND r.valid_until > clock_timestamp() AND r.action IN ($5, 'realm.owner', 'agent.control')
      JOIN access.authority_subject a ON a.id = r.subject_id AND a.kind = 'agent' AND a.active
      JOIN access.permission_grant g ON g.recipient_subject = a.id AND g.scope_id = $4
        AND g.action = $5 AND g.active AND g.valid_until > clock_timestamp()
        AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
          WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
      JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
      ORDER BY LEAST(r.valid_until, g.valid_until) DESC LIMIT 1 FOR SHARE OF p, r, a, g, gate`,
    [principal.issuer, principal.subject, actor,
      realmPermissionScope(realm, action), action])).rows[0];
    if (!row) throw new RealmAdminDenied('Realm permission is missing');
    return { id: row.id, validUntil: row.valid_until };
  }

  private async write<T extends Receipt>(principal: VerifiedPrincipal, realm: string,
    input: { actingSubject: string; expectedGeneration: string; reason: string }, key: string,
    action: string, run: (client: PoolClient, principalId: string, id: string, generation: string,
      ceiling: Date) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !input.reason.trim()) throw new RealmAdminInvalid('Invalid command');
    const intent = digest({ realm, action, input });
    return this.transaction(realm, async (client, generation) => {
      const actor = await this.authorize(client, principal, realm, input.actingSubject, action);
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
      await client.query(`UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1`, [realmAdminScope(realm)]);
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id, realm, principal_id, acting_subject, idempotency_key, request_digest, action, reason, result)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, realm, actor.id, input.actingSubject, key, intent, action, input.reason, result]);
      return result;
    });
  }

  async changeMember(principal: VerifiedPrincipal, realm: string, input: MemberCommand, key: string, env?: WorkActivationEnvironment) {
    if (!Value.Check(memberCommand, input)) throw new RealmAdminInvalid('Invalid member change');
    const identity = input.action==='add' ? await prepareRealmFollow(this.pool,realm,env?.fuseki) : null;
    return this.write(principal, realm, input, key, 'realm.members.manage',
      async (client, principalId, receiptId, generation) => {
        if (identity) await registerFollowSpace(client,identity);
        return { receiptId, generation, replayed: false,
          ...await changeRealmMember(client, realm, input, principalId, receiptId, env) };
      });
  }

  private async settlePolicy(realm: string, env?: WorkActivationEnvironment) {
    await settleRealmPolicy(this.pool, realm, env);
  }

  async settings(principal: VerifiedPrincipal, realm: string, actor: string, env?: WorkActivationEnvironment) {
    await this.settlePolicy(realm, env);
    return this.transaction(realm, async (client, generation) => {
      await this.authorize(client, principal, realm, actor, 'realm.settings.manage');
      return { generation, ...await readRealmSettings(client, realm) };
    });
  }

  async changeSettings(principal: VerifiedPrincipal, realm: string, input: SettingsCommand, key: string, env?: WorkActivationEnvironment) {
    if (!Value.Check(settingsCommand, input)) throw new RealmAdminInvalid('Invalid Realm settings');
    await this.settlePolicy(realm, env);
    const result = await this.write(principal, realm, input, key, 'realm.settings.manage',
      async (client, principalId, receiptId, generation) => {
        await this.authorize(client, principal, realm, input.actingSubject, 'governance.rule.publish');
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
      (realm,receipt_id,generation,visibility,review_mode,listing,history,admission)
      SELECT s.realm,$2,$3,s.visibility,s.review_mode,s.listing,s.history,
        CASE WHEN s.self_join THEN 'open' ELSE COALESCE(p.admission,'invitation') END FROM access.realm_admin_settings s
      LEFT JOIN access.membership_policy p ON p.kind = 'realm' AND p.owner_subject = s.realm WHERE s.realm = $1
      ON CONFLICT (realm) DO UPDATE SET receipt_id = EXCLUDED.receipt_id,generation = EXCLUDED.generation,
        visibility = EXCLUDED.visibility,review_mode = EXCLUDED.review_mode,listing = EXCLUDED.listing,
        history = EXCLUDED.history,admission = EXCLUDED.admission,delivered = false`, [realm,receipt,generation]);
  }

  /** One bounded Space capability lookup. G-937 owns creation of Zone-only
   * Spaces; its manager integration must enroll their management authority. */
  private async spaceRealm(space: string, env: WorkActivationEnvironment) {
    if (!native.test(space)) throw new RealmAdminInvalid('Invalid Space');
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(space)} a rv:Space ; rv:realmCapability ?realm .
        ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ${iri(space)} . }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.realm) throw new RealmAdminDenied('Space management is unavailable');
    return rows[0].realm.value;
  }

  async spaceSettings(principal: VerifiedPrincipal, space: string, actor: string, env: WorkActivationEnvironment) {
    const realm = await this.spaceRealm(space, env);
    await this.settlePolicy(realm, env);
    return this.transaction(realm, async (client, generation) => {
      await this.authorize(client, principal, realm, actor, 'realm.settings.manage');
      return { space, realm, generation, settings: await readRealmAccessSettings(client, realm) };
    });
  }

  async changeSpaceSettings(principal: VerifiedPrincipal, space: string, input: SpaceSettingsCommand,
    key: string, env: WorkActivationEnvironment) {
    if (!Value.Check(spaceSettingsCommand, input)) throw new RealmAdminInvalid('Invalid Space settings');
    const realm = await this.spaceRealm(space, env);
    await this.settlePolicy(realm, env);
    const result = await this.write(principal, realm, input, key, 'realm.settings.manage',
      async (client, _principal, receiptId, generation) => {
        if ((await client.query('SELECT 1 FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered', [realm])).rowCount) {
          throw new RealmAdminUnavailable('Space policy publication is pending; retry');
        }
        await saveRealmAccessSettings(client, realm, input.settings);
        await this.queuePolicy(client, realm, receiptId, generation);
        return { space, realm, receiptId, generation, replayed: false, settings: input.settings };
      });
    await this.settlePolicy(realm, env);
    return result;
  }

  roles(principal: VerifiedPrincipal, realm: string, actor: string) {
    return this.transaction(realm, async (client, generation) => {
      await this.authorize(client, principal, realm, actor, 'realm.roles.manage');
      const roles = (await client.query<Role>(`SELECT id, name, permissions FROM access.realm_admin_role
        WHERE realm = $1 ORDER BY id LIMIT $2`, [realm, REALM_ADMIN_COST.roles + 1])).rows;
      if (roles.length > REALM_ADMIN_COST.roles) throw new RealmAdminLimit('Realm role budget exceeded');
      return { generation, roles };
    });
  }

  members(principal: VerifiedPrincipal, realm: string,
    options: { actingSubject: string; search?: string; after?: string; limit?: number }) {
    const limit = options.limit ?? REALM_ADMIN_COST.page;
    if (!Number.isInteger(limit) || limit < 1 || limit > REALM_ADMIN_COST.page
      || options.after && !native.test(options.after) || (options.search?.length ?? 0) > 80) {
      throw new RealmAdminInvalid('Invalid member page');
    }
    return this.transaction(realm, async (client, generation) => {
      await this.authorize(client, principal, realm, options.actingSubject, 'realm.members.manage');
      const matches = !options.search?.trim() ? null
        : await searchRealmMembers(client, realm, options.search, options.after, limit + 1);
      // This is the Agent team roster. Private principal memberships never
      // disclose account identities through this listing.
      const rows = (await client.query<{ member: string; state: 'joined' | 'left' | 'not_joined';
        membership_generation: string; joined_at: Date | null;
        banned: boolean; banned_until: Date | null;
        roles: { id: string; name: string; validUntil: string }[] }>(`SELECT team.member,
        COALESCE(m.state,'not_joined') AS state, COALESCE(m.generation,0)::text AS membership_generation,
        COALESCE(b.active AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()), false) AS banned,
        CASE WHEN b.active AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp())
          THEN b.expires_at ELSE NULL END AS banned_until,
        (SELECT h.changed_at FROM access.membership_history h WHERE h.membership_id = m.id
          AND h.state = 'joined' ORDER BY h.generation DESC LIMIT 1) AS joined_at,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name,
          'validUntil', a.valid_until) ORDER BY r.id) FROM access.realm_admin_assignment a
          JOIN access.realm_admin_role r ON r.realm = a.realm AND r.id = a.role_id
          WHERE a.realm = $1 AND a.member = team.member AND a.valid_until > clock_timestamp()), '[]') AS roles
        FROM ((SELECT member_subject AS member FROM access.membership
          WHERE kind = 'realm' AND owner_subject = $1
            AND ($2::text IS NULL OR member_subject > $2)
            AND ($3::text[] IS NULL OR member_subject = ANY($3))
          ORDER BY member_subject LIMIT $4)
          UNION
          (SELECT DISTINCT member FROM access.realm_admin_assignment
          WHERE realm = $1 AND valid_until > clock_timestamp()
            AND ($2::text IS NULL OR member > $2)
            AND ($3::text[] IS NULL OR member = ANY($3))
          ORDER BY member LIMIT $4)) team
        LEFT JOIN access.membership m ON m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject = team.member
        LEFT JOIN access.membership_ban b ON b.kind = 'realm'
          AND b.owner_subject = $1 AND b.member_subject = team.member
        ORDER BY team.member LIMIT $4`, [realm, options.after ?? null, matches, limit + 1])).rows;
      return { generation, items: rows.slice(0, limit).map(row => ({ member: row.member, state: row.state,
        banned: row.banned, bannedUntil: row.banned_until?.toISOString() ?? null,
        membershipGeneration: row.membership_generation, joinedAt: row.joined_at?.toISOString() ?? null, roles: row.roles })),
      nextCursor: rows.length > limit ? rows[limit - 1]!.member : null };
    });
  }

  private async plan(client: PoolClient, realm: string, input: RoleCommand, ceiling: Date) {
    const change = input.change;
    if (change.kind === 'role' && !change.name.trim()) throw new RealmAdminInvalid('Role name must not be empty');
    const role = (await client.query<Role>(`SELECT id, name, permissions FROM access.realm_admin_role
      WHERE realm = $1 AND id = $2`, [realm, change.roleId])).rows[0];
    if (!role && change.kind === 'assignment') throw new RealmAdminInvalid('Role is unavailable');
    if (!role) {
      const count = await client.query(`SELECT 1 FROM access.realm_admin_role WHERE realm = $1 LIMIT $2`,
        [realm, REALM_ADMIN_COST.roles]);
      if (count.rows.length >= REALM_ADMIN_COST.roles) throw new RealmAdminLimit('Realm role budget exceeded');
    }
    const permissions = change.kind === 'role' ? change.permissions : role!.permissions;
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
      g.generation::text, g.valid_until, link.role_id FROM access.permission_grant g
      JOIN access.authority_subject a ON a.id = g.recipient_subject AND a.active
      LEFT JOIN access.realm_admin_role_grant link ON link.grant_id = g.id
      WHERE g.recipient_subject = ANY($1::text[]) AND g.scope_id = CASE g.action
        WHEN 'review.decide' THEN 'review:decide:' || $2
        WHEN 'publication.adopt' THEN 'publication:adopt:' || $2 ELSE 'governance:realm:' || $2 END
        AND g.action = ANY($3::text[]) AND g.active AND g.valid_until > clock_timestamp()
        AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
          WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
      ORDER BY g.id LIMIT $4 FOR SHARE OF g`,
    [members, realm, realmPermissions, REALM_ADMIN_COST.grantRows + 1])).rows;
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
      const before = new Set(current.map(g => g.action));
      const after = new Set(current.filter(g => g.role_id !== change.roleId).map(g => g.action));
      if (change.kind === 'role' || change.assigned) for (const permission of permissions) after.add(permission);
      const gained = realmPermissions.filter(p => !before.has(p) && after.has(p));
      const lost = realmPermissions.filter(p => before.has(p) && !after.has(p));
      if (gained.length || lost.length) changes.push({ member, gained, lost });
    }
    const impact: RoleImpact = { digest: digest({ realm, input, role, assignments, grants, changes }),
      generation: input.expectedGeneration, exact: true, affectedCount: changes.length, changes };
    return { role, permissions, assignments, impact };
  }

  preview(principal: VerifiedPrincipal, realm: string, input: RoleCommand) {
    if (!Value.Check(roleCommand, input)) throw new RealmAdminInvalid('Invalid role change');
    return this.transaction(realm, async (client, generation) => {
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
        if (change.kind === 'role') await client.query(`INSERT INTO access.realm_admin_role (realm,id,name,permissions)
          VALUES ($1,$2,$3,$4) ON CONFLICT (realm,id) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions`,
        [realm, change.roleId, change.name.trim(), plan.permissions]);
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
            [[`review:decide:${realm}`, `publication:adopt:${realm}`]]);
          // One bounded set insert rather than one query per member/permission.
          await client.query(`WITH recipients AS (SELECT * FROM unnest($4::text[], $5::timestamptz[])
            AS r(member, valid_until)), inserted AS (
            INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
            SELECT gen_random_uuid(),$2,r.member,p.scope,p.action,r.valid_until,$7 FROM recipients r
              CROSS JOIN unnest($3::text[],$6::text[]) AS p(scope,action) RETURNING id,recipient_subject)
            INSERT INTO access.realm_admin_role_grant (realm,role_id,member,grant_id)
            SELECT $1,$8,recipient_subject,id FROM inserted`,
          [realm, input.actingSubject, plan.permissions.map(action => realmPermissionScope(realm, action)), plan.assignments.map(a => a.member),
            plan.assignments.map(a => a.valid_until), plan.permissions, principalId, change.roleId]);
        }
        await client.query(`UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = ANY($1::text[])`,
          [[`review:decide:${realm}`, `publication:adopt:${realm}`]]);
        return { receiptId, generation, replayed: false, impact: plan.impact,
          auditDetail: { kind: change.kind,
            role: { id: change.roleId, name: change.kind === 'role' ? change.name.trim() : plan.role!.name },
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
        const item = input.itemKind === 'report'
          ? await client.query(`SELECT id FROM access.governance_case WHERE id = $1 AND context = $2
              AND authority_kind = 'realm' AND authority_scope_id = $3 AND state = 'open'
              AND generation = $4 FOR UPDATE`,
            [input.itemId, realm, realmAdminScope(realm), input.expectedItemGeneration])
          : await client.query(`SELECT id FROM access.realm_submission WHERE id = $1 AND realm = $2
              AND state = 'pending' AND generation = $3 FOR UPDATE`, [input.itemId, realm, input.expectedItemGeneration]);
        if (!item.rowCount) throw new RealmAdminStale('Queue item is unavailable or already decided');
        const row = (await client.query<{ escalated_at: Date }>(`INSERT INTO access.realm_admin_escalation
          (id,realm,item_kind,item_id,reason,acting_subject) VALUES ($1,$2,$3,$4,$5,$6) RETURNING escalated_at`,
        [receiptId, realm, input.itemKind, input.itemId, input.reason, input.actingSubject])).rows[0]!;
        return { receiptId, generation, replayed: false, escalation: { id: receiptId, reason: input.reason,
          actingSubject: input.actingSubject, escalatedAt: row.escalated_at.toISOString(), target: 'owners' as const } };
      });
  }
}
