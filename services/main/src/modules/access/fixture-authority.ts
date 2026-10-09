import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Sql = Pick<Pool | PoolClient, 'query'>;

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

/** Record a scope gate without granting. An existing closed gate stays closed. */
export async function ensureFixtureScopeGate(client: Sql, scope: string): Promise<void> {
  requireToken(scope, scopePattern, scope);
  await client.query(
    'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
}
