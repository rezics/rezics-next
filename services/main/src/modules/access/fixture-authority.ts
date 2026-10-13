import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Sql = Pick<Pool | PoolClient, 'query'>;

/** Fixture identities enter through Access, under its recovery fence. The caller
 * supplies a transaction so an interrupted setup cannot leave half an identity. */
export async function registerFixtureIdentity(client: PoolClient, input: {
  principalId: string; issuer: string; subject: string; actor: string;
}): Promise<void> {
  await recoveryOpen(client);
  await client.query(
    'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [input.principalId, input.issuer, input.subject]);
  await client.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [input.actor]);
}

/** Fixture mandate and grant duration, always read with clock_timestamp().
 * Seed sessions use 8 hours. Dataset administration uses 7 days because an
 * import outlasts a seed session. Web-auth agent control uses infinity
 * because that mandate must outlast the local process. A caller with no
 * separate duration uses the seed window. */
export type FixtureLifetime = '8 hours' | '7 days' | 'infinity';

const scopePattern = /^[^\s\0]{1,256}$/;
const actionPattern = /^[^\s\0]{1,128}$/;

export class FixtureAuthorityDenied extends Error {
  readonly kind: 'recovery' | 'gate' | 'policy';
  readonly scope?: string;

  constructor(kind: 'recovery' | 'gate' | 'policy', scope?: string) {
    super(kind === 'recovery' ? 'Access recovery fence is closed'
      : kind === 'policy' ? `fixture scope has a policy: ${scope}`
        : `fixture scope is closed: ${scope}`);
    this.name = 'FixtureAuthorityDenied';
    this.kind = kind;
    this.scope = scope;
  }
}

export interface FixtureRepresentation {
  principalId: string;
  actor: string;
  action: string;
  lifetime: FixtureLifetime;
}

export interface FixtureGrant {
  actor: string;
  action: string;
  lifetime: FixtureLifetime;
  /** Dataset bootstrap reuses a grant only when this actor issued it to itself. */
  requireSelfIssuer?: boolean;
}

export interface FixtureAuthorityInput {
  scope: string;
  /** Work and dataset fixtures also refuse a closed dispatch gate. */
  requireDispatch: boolean;
  /** Dataset bootstrap refuses to grant over an open policy. */
  refuseExistingPolicy?: boolean;
  representations: readonly FixtureRepresentation[];
  grant: FixtureGrant;
}

export interface FixtureAuthorityResult {
  grantId: string;
  representationIds: string[];
}

function until(lifetime: FixtureLifetime): string {
  return lifetime === 'infinity' ? "'infinity'" : `clock_timestamp() + interval '${lifetime}'`;
}

function requireToken(value: string, pattern: RegExp, scope: string): void {
  if (!pattern.test(value)) throw new FixtureAuthorityDenied('gate', scope);
}

async function recoveryOpen(client: Sql): Promise<void> {
  const fence = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (fence.rows[0]?.open !== true) throw new FixtureAuthorityDenied('recovery');
}

/** Insert a missing scope gate and stop when it is closed. No representation
 * or permission grant is written after a refusal. */
async function openFixtureScope(client: Sql, scope: string, requireDispatch: boolean): Promise<void> {
  requireToken(scope, scopePattern, scope);
  await client.query(
    'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
  const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
    'SELECT open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
  const row = gate.rows[0];
  if (!row?.open || (requireDispatch && !row.dispatch_open)) throw new FixtureAuthorityDenied('gate', scope);
}

async function ensureRepresentation(client: Sql, representation: FixtureRepresentation): Promise<string> {
  requireToken(representation.action, actionPattern, representation.action);
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp() FOR SHARE`,
    [representation.principalId, representation.actor, representation.action]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query(
    `INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,${until(representation.lifetime)})`,
    [id, representation.principalId, representation.actor, representation.action]);
  return id;
}

async function ensureGrant(client: Sql, scope: string, grant: FixtureGrant): Promise<string> {
  requireToken(grant.action, actionPattern, scope);
  const selfIssuer = grant.requireSelfIssuer ? 'AND issuer_subject = recipient_subject' : '';
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp() ${selfIssuer} FOR SHARE`,
    [grant.actor, scope, grant.action]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query(
    `INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,${until(grant.lifetime)})`,
    [id, grant.actor, scope, grant.action]);
  return id;
}

/** Local fixture authority. A closed recovery fence or scope gate refuses
 * before any representation or grant write. A retry returns the active rows
 * instead of inserting another copy. */
export async function grantFixtureAuthority(client: Sql, input: FixtureAuthorityInput):
  Promise<FixtureAuthorityResult> {
  if (!input.representations.length) throw new FixtureAuthorityDenied('gate', input.scope);
  await recoveryOpen(client);
  await openFixtureScope(client, input.scope, input.requireDispatch);
  if (input.refuseExistingPolicy) {
    const policy = await client.query(
      'SELECT id FROM access.policy WHERE scope_id = $1 AND ended_at IS NULL LIMIT 1', [input.scope]);
    if (policy.rowCount) throw new FixtureAuthorityDenied('policy', input.scope);
  }
  const representationIds: string[] = [];
  for (const representation of input.representations) {
    representationIds.push(await ensureRepresentation(client, representation));
  }
  return { grantId: await ensureGrant(client, input.scope, input.grant), representationIds };
}

/** Owner fixtures need the same active Person provenance as member authoring,
 * in addition to an open-ended direct controller. Call inside the fixture transaction. */
export async function provisionFixturePerson(client: Sql, input: {
  principalId: string; actor: string; dataEpoch: string;
}): Promise<void> {
  const authority = await grantFixtureAuthority(client, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: input.principalId, actor: input.actor,
      action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: input.actor, action: 'agent.control', lifetime: 'infinity' },
  });
  await client.query(`INSERT INTO access.agent_provision
    (id,principal_id,idempotency_key,request_digest,agent_id,agent_kind,display_name,
      principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    SELECT $1,p.id,$2,$3,$4,'person','Fixture Person',p.enforcement_epoch,'active',$5,1,$6
    FROM access.principal p WHERE p.id = $7 AND p.active`,
  [randomUUID(), `fixture:${randomUUID()}`, '0'.repeat(64), input.actor, input.dataEpoch,
    authority.representationIds[0], input.principalId]);
}

/** Institutional controller edges use the same recovery/scope-checked fixture
 * boundary as mandates. Install before a recovery policy requires approval. */
export async function grantFixtureControllerEdge(client: Sql, input: {
  principalId: string; representative: string; represented: string;
}): Promise<string> {
  const action = 'access.representation.assign.agent.control';
  const authority = await grantFixtureAuthority(client, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: input.principalId, actor: input.represented,
      action: 'access.representation.manage', lifetime: 'infinity' }],
    grant: { actor: input.represented, action, lifetime: 'infinity' },
  });
  await openFixtureScope(client, 'access:representation-topology', false);
  const existing = await client.query<{ id: string }>(`SELECT id FROM access.representation_edge
    WHERE representative_subject = $1 AND represented_subject = $2
      AND action = 'agent.control' AND active AND valid_until > clock_timestamp()`,
  [input.representative, input.represented]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query(`INSERT INTO access.representation_edge (id, representative_subject,
    represented_subject, action, max_path_edges, valid_until, assigned_by_principal,
    issuer_representation_id, issuer_representation_generation, issuer_representation_action,
    ceiling_grant_id, ceiling_grant_generation, ceiling_scope_id, ceiling_action)
    SELECT $1,$2,$3,'agent.control',2,'infinity',$4,r.id,r.generation,r.action,
      g.id,g.generation,g.scope_id,g.action FROM access.representation r
    CROSS JOIN access.permission_grant g WHERE r.id = $5 AND g.id = $6`,
  [id, input.representative, input.represented, input.principalId,
    authority.representationIds[0], authority.grantId]);
  return id;
}

/** Exercise controller removal through the fixture boundary while retaining
 * the database continuity check, including after recovery reattachment. */
export async function deactivateFixtureController(client: Sql, representationId: string): Promise<void> {
  await recoveryOpen(client);
  await client.query(`UPDATE access.representation SET active = false
    WHERE id = $1 AND action = 'agent.control'`, [representationId]);
}

/** End this actor's live fixture mandates and self-grants. A load baseline
 * expires the seed window so a later read meets closed authority. */
export async function expireFixtureAuthority(client: Sql, actor: string): Promise<void> {
  requireToken(actor, scopePattern, actor);
  await recoveryOpen(client);
  await client.query(
    `UPDATE access.representation SET valid_until = clock_timestamp() - interval '1 second'
      WHERE subject_id = $1 AND valid_until > clock_timestamp()`, [actor]);
  await client.query(
    `UPDATE access.permission_grant SET valid_until = clock_timestamp() - interval '1 second'
      WHERE issuer_subject = $1 AND valid_until > clock_timestamp()`, [actor]);
}

/** Negative authority fixtures can end or shorten an existing grant, never
 * create authority, widen its lifetime or reactivate a terminal episode. */
export async function reduceFixtureGrant(client: Sql, grantId: string,
  change: { validUntil: Date } | { active: false }): Promise<void> {
  requireToken(grantId, /^[0-9a-f-]{36}$/, grantId);
  await recoveryOpen(client);
  if ('validUntil' in change) {
    if (!Number.isFinite(change.validUntil.getTime())) throw new FixtureAuthorityDenied('gate', grantId);
    await client.query(`UPDATE access.permission_grant SET valid_until = LEAST(valid_until,$2)
      WHERE id = $1`, [grantId, change.validUntil]);
  } else {
    await client.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grantId]);
  }
}

/** Record a scope gate without granting. An existing closed gate stays closed
 * unless a test explicitly changes its state; state changes advance the fence. */
export async function ensureFixtureScopeGate(client: Sql, scope: string,
  state?: { open: boolean }): Promise<void> {
  requireToken(scope, scopePattern, scope);
  if (state) {
    await recoveryOpen(client);
    await client.query(`INSERT INTO access.scope_gate AS gate (id,open) VALUES ($1,$2)
      ON CONFLICT (id) DO UPDATE SET open = EXCLUDED.open,
        authority_epoch = gate.authority_epoch + CASE WHEN gate.open = EXCLUDED.open THEN 0 ELSE 1 END`,
    [scope, state.open]);
    return;
  }
  await client.query(
    'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
}
