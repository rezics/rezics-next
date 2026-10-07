import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import type { VerifiedAccountAssertion } from '../account/verify-assertion.ts';
import type { Budget, PrincipalClass, RateLimitFamily } from './budgets.ts';

export interface LimitDecision { allowed: boolean; retryAfter: number }
export interface RateLimitStore {
  startExpirySweep?(): void;
  stopExpirySweep?(): Promise<void>;
  classify(principal: VerifiedAccountAssertion): Promise<PrincipalClass>;
  consume(identity: string, family: RateLimitFamily, budget: Budget): Promise<LimitDecision>;
}

export interface RateLimitOptions {
  secret: string;
  serviceClientIds: ReadonlySet<string>;
  trustedProxyPeers: ReadonlySet<string>;
  clientIpHeader: string;
}

export const RATE_LIMIT_COST_V1 = {
  principalRows: 1, representations: 64, roleRowsPerRepresentation: 64,
  classificationQueries: 1, counterQueries: 1, expirySweepRows: 1000, expirySweepIntervalMs: 1000,
} as const;

/** A proxy must replace this header and be explicitly trusted by peer address.
 * Unknown peers collapse to one conservative key, never a caller-chosen key. */
export function anonymousIdentity(request: Request, peer: string | undefined, options: RateLimitOptions): string {
  let address = peer && isIP(peer) ? peer : 'unknown';
  if (peer && options.trustedProxyPeers.has(peer)) {
    const forwarded = request.headers.get(options.clientIpHeader)?.trim();
    if (forwarded && isIP(forwarded)) address = forwarded;
  }
  if (isIP(address) === 6) {
    // URL canonicalizes IPv6 spelling, including embedded IPv4. Expand only
    // to obtain the first four hextets; rotating interface IDs shares one /64.
    const canonical = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split('::');
    const prefix = left ? left.split(':') : [];
    const suffix = right ? right.split(':') : [];
    const groups = canonical.includes('::')
      ? [...prefix, ...Array<string>(8 - prefix.length - suffix.length).fill('0'), ...suffix] : prefix;
    address = `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(':')}::/64`;
  }
  return `anonymous:${address}`;
}

interface ClassificationRow {
  found: boolean;
  active: boolean;
  newcomer: boolean;
  platform_administrator: boolean;
  agent_count: number;
  max_role_rows: number;
  trusted: boolean;
}

/** The extra row past each cap is how overflow stays a refusal. Platform
 * administrators skip the representation walk; an inactive principal does too. */
const CLASSIFICATION_SQL = `WITH principal AS (
  SELECT p.id, p.active,
    p.first_seen_at > now() - interval '7 days' AS newcomer,
    CASE WHEN p.active THEN EXISTS (
      SELECT 1 FROM access.read_platform_permissions(p.id) permission
      WHERE permission.action = 'platform:use:platform-admin'
    ) ELSE false END AS platform_administrator
  FROM access.principal p
  WHERE p.account_issuer = $1 AND p.account_subject = $2
),
agents AS (
  SELECT DISTINCT representation.subject_id, representation.action
  FROM access.representation representation
  JOIN access.authority_subject authority
    ON authority.id = representation.subject_id AND authority.active
  JOIN principal ON principal.id = representation.principal_id
  WHERE principal.active AND NOT principal.platform_administrator
    AND representation.active AND representation.valid_until > now()
    AND representation.action IN ('work.create', 'work.edit', 'governance.moderate')
  LIMIT $3
),
role_rows AS (
  SELECT agent.subject_id, agent.action, role.trusted
  FROM agents agent
  JOIN LATERAL (
    SELECT trusted FROM (
      SELECT agent.action = ANY(revision.permissions) AS trusted
      FROM access.role_binding binding
      JOIN access.role_revision revision
        ON revision.family_id = binding.family_id AND revision.revision = binding.role_revision
      JOIN access.role_family family ON family.id = binding.family_id
      JOIN access.scope_gate gate ON gate.id = family.scope_id AND gate.open AND gate.dispatch_open
      LEFT JOIN access.membership membership ON membership.id = binding.membership_id
      WHERE binding.recipient_subject = agent.subject_id
        AND agent.action IN ('work.create', 'work.edit')
        AND binding.active AND binding.valid_until > now()
        AND family.scope_id = 'work:create:root'
        AND (binding.membership_id IS NULL OR (
          membership.state = 'joined' AND membership.member_subject = binding.recipient_subject
          AND membership.generation = binding.membership_generation))
      UNION ALL
      SELECT true AS trusted
      FROM access.realm_admin_assignment assignment
      JOIN access.realm_admin_role_grant grant_row
        ON grant_row.realm = assignment.realm AND grant_row.role_id = assignment.role_id
        AND grant_row.member = assignment.member
      JOIN access.permission_grant permission
        ON permission.id = grant_row.grant_id AND permission.active AND permission.valid_until > now()
      JOIN access.scope_gate permission_gate
        ON permission_gate.id = permission.scope_id AND permission_gate.open
      WHERE assignment.member = agent.subject_id
        AND agent.action = 'governance.moderate'
        AND assignment.valid_until > now()
        AND permission.action = 'governance.moderate'
    ) candidate
    LIMIT $4
  ) role ON true
)
SELECT
  EXISTS (SELECT 1 FROM principal) AS found,
  COALESCE((SELECT active FROM principal), false) AS active,
  COALESCE((SELECT newcomer FROM principal), false) AS newcomer,
  COALESCE((SELECT platform_administrator FROM principal), false) AS platform_administrator,
  (SELECT count(*)::int FROM agents) AS agent_count,
  COALESCE((SELECT max(counted.role_count)::int FROM (
    SELECT count(*) AS role_count FROM role_rows GROUP BY subject_id, action
  ) counted), 0) AS max_role_rows,
  COALESCE((SELECT bool_or(trusted) FROM role_rows), false) AS trusted`;

/** One statement classifies a token: the principal by its unique account key,
 * the bounded live platform grant proof, then at most 65 represented Agents
 * and 65 role rows for each. Overflow is unavailable, never a trust upgrade.
 * The hook caches the result for at most
 * the verified token's lifetime. Consume uses one atomic PK upsert; an expired
 * key resets lazily. */
export class PostgresRateLimitStore implements RateLimitStore {
  private expiryTimer?: ReturnType<typeof setInterval>;
  private expiryPending?: Promise<void>;

  /** Separate lifecycle work: requests still issue exactly one counter query.
   * Indexed, locked batches keep each sweep bounded across Main replicas. */
  async sweepExpired(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM access.rate_limit_v1 WHERE (key, family) IN (
      SELECT key, family FROM access.rate_limit_v1 WHERE expires_at <= now()
      ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`, [RATE_LIMIT_COST_V1.expirySweepRows]);
    return result.rowCount ?? 0;
  }

  startExpirySweep(): void {
    if (this.expiryTimer) return;
    const tick = () => {
      if (this.expiryPending) return;
      this.expiryPending = this.sweepExpired().then(() => undefined)
        .catch(error => { logWorkerFault('main.rate-limit.expiry', error); })
        .finally(() => { this.expiryPending = undefined; });
    };
    this.expiryTimer = setInterval(tick, RATE_LIMIT_COST_V1.expirySweepIntervalMs);
    this.expiryTimer.unref();
    tick();
  }

  async stopExpirySweep(): Promise<void> {
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    await this.expiryPending;
  }

  constructor(private readonly pool: Pool, private readonly options: RateLimitOptions) {
    if (options.secret.length < 32) throw new Error('Rate limit HMAC secret must contain at least 32 characters');
  }

  async classify(principal: VerifiedAccountAssertion): Promise<PrincipalClass> {
    // Account marks a client-credentials token workload and sets its subject to
    // the client. A person's token keeps that person's class even when the
    // client is on the deployment allowlist.
    const clientId = principal.accountClientId;
    if (principal.accountAuthMode === 'workload'
      && typeof clientId === 'string' && clientId.length > 0
      && principal.subject === clientId
      && this.options.serviceClientIds.has(clientId)) return 'service';
    const result = await this.pool.query<ClassificationRow>(CLASSIFICATION_SQL, [
      principal.issuer, principal.subject,
      RATE_LIMIT_COST_V1.representations + 1,
      RATE_LIMIT_COST_V1.roleRowsPerRepresentation + 1,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('Rate limit classification unavailable');
    // The handler remains responsible for authorization, including allowing a
    // suspended principal to use safety intake. Unknown principals are new.
    if (row.found !== true || row.active !== true) return 'new-account';
    // Platform moderation uses the existing trusted class. Startup configuration
    // never changes budgets or installs a service client.
    if (row.platform_administrator === true) return 'trusted';
    const agents = Number(row.agent_count);
    const roleRows = Number(row.max_role_rows);
    if (!Number.isInteger(agents) || !Number.isInteger(roleRows)) {
      throw new Error('Rate limit classification unavailable');
    }
    if (agents > RATE_LIMIT_COST_V1.representations) throw new Error('Rate limit representation budget exceeded');
    if (roleRows > RATE_LIMIT_COST_V1.roleRowsPerRepresentation) throw new Error('Rate limit role budget exceeded');
    return row.trusted === true ? 'trusted' : row.newcomer === true ? 'new-account' : 'member';
  }

  async consume(identity: string, family: RateLimitFamily, budget: Budget): Promise<LimitDecision> {
    const key = createHmac('sha256', this.options.secret).update(identity).digest('hex');
    // Cap rejected counts and retain the original expiry. Rejects never keep a
    // principal locked out by extending its window. Class is not in the key.
    const result = await this.pool.query<{ allowed: boolean; retry_after: number }>(`INSERT INTO access.rate_limit_v1 AS r
      (key, family, count, expires_at) VALUES ($1, $2, 1, now() + $3 * interval '1 second')
      ON CONFLICT (key, family) DO UPDATE SET
        count = CASE WHEN r.expires_at <= now() THEN 1 ELSE GREATEST(r.count, LEAST(r.count + 1, $4 + 1)) END,
        expires_at = CASE WHEN r.expires_at <= now() THEN now() + $3 * interval '1 second' ELSE r.expires_at END
      RETURNING count <= $4 AS allowed, GREATEST(1, ceil(extract(epoch FROM expires_at - now())))::int AS retry_after`,
    [key, family, budget.seconds, budget.maximum]);
    const row = result.rows[0];
    if (!row) throw new Error('Rate limit counter unavailable');
    return { allowed: row.allowed, retryAfter: row.retry_after };
  }
}
