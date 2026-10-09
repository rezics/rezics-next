import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Sql = Pick<PoolClient, 'query'>;

/** How long a fixture mandate or grant stays active. The clock matches the
 * statement the fixture used before this operation owned the write. */
export type FixtureLifetime = '8 hours' | '7 days' | 'infinity';

const lifetimeSql = {
  '8 hours': { until: "now() + interval '8 hours'", current: 'now()' },
  '7 days': { until: "clock_timestamp() + interval '7 days'", current: 'clock_timestamp()' },
  infinity: { until: "'infinity'", current: 'now()' },
} as const;

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

/** Replace a denied fixture write with the caller's precondition message. */
export function rethrowFixtureAuthority(error: unknown, messages: {
  gate?: string; policy?: string; recovery?: string;
}): never {
  if (error instanceof FixtureAuthorityDenied) {
    const message = messages[error.kind];
    if (message) throw new Error(message);
  }
  throw error;
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

async function recoveryOpen(client: Sql): Promise<void> {
  const fence = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (fence.rows[0]?.open !== true) throw new FixtureAuthorityDenied('recovery');
}

function requireScope(scope: string): void {
  if (!scopePattern.test(scope)) throw new FixtureAuthorityDenied('gate', scope);
}

/** Insert a missing scope gate and stop when it is closed. No representation
 * or permission grant is written after a refusal. */
async function openFixtureScope(client: Sql, scope: string, requireDispatch: boolean): Promise<void> {
  requireScope(scope);
  await client.query(
    'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
  const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
    'SELECT open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
  const row = gate.rows[0];
  if (!row?.open || (requireDispatch && !row.dispatch_open)) throw new FixtureAuthorityDenied('gate', scope);
}

async function ensureRepresentation(client: Sql, representation: FixtureRepresentation): Promise<string> {
  if (!actionPattern.test(representation.action)) {
    throw new FixtureAuthorityDenied('gate', representation.action);
  }
  const clock = lifetimeSql[representation.lifetime];
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active
        AND valid_until > ${clock.current} FOR SHARE`,
    [representation.principalId, representation.actor, representation.action]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query(
    `INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,${clock.until})`,
    [id, representation.principalId, representation.actor, representation.action]);
  return id;
}

async function ensureGrant(client: Sql, scope: string, grant: FixtureGrant): Promise<string> {
  if (!actionPattern.test(grant.action)) throw new FixtureAuthorityDenied('gate', scope);
  const clock = lifetimeSql[grant.lifetime];
  const selfIssuer = grant.requireSelfIssuer ? 'AND issuer_subject = recipient_subject' : '';
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > ${clock.current} ${selfIssuer} FOR SHARE`,
    [grant.actor, scope, grant.action]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query(
    `INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES ($1,$2,$2,$3,$4,${clock.until})`,
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

/** Record a scope gate without granting. An existing closed gate stays closed. */
export async function ensureFixtureScopeGate(client: Pick<Pool | PoolClient, 'query'>, scope: string):
  Promise<void> {
  requireScope(scope);
  await client.query(
    'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
}
