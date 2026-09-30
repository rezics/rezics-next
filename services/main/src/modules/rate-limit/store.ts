import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import type { VerifiedAccountAssertion } from '../account/verify-assertion.ts';
import type { Budget, PrincipalClass, RateLimitFamily } from './budgets.ts';

export interface LimitDecision { allowed: boolean; retryAfter: number }
export interface RateLimitStore {
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
  classificationQueries: 66, counterQueries: 1,
} as const;

/** A proxy must replace this header and be explicitly trusted by peer address.
 * Unknown peers collapse to one conservative key, never a caller-chosen key. */
export function anonymousIdentity(request: Request, peer: string | undefined, options: RateLimitOptions): string {
  let address = peer && isIP(peer) ? peer : 'unknown';
  if (peer && options.trustedProxyPeers.has(peer)) {
    const forwarded = request.headers.get(options.clientIpHeader)?.trim();
    if (forwarded && isIP(forwarded)) address = forwarded;
  }
  return `anonymous:${address}`;
}

/** Cost: one indexed principal lookup, <=65 represented Agents and <=65
 * role candidates per Agent; overflow is unavailable, never a trust upgrade.
 * Classification is cached for the verified token's lifetime by the hook.
 * Consume uses one atomic PK upsert; an expired key resets lazily. */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: Pool, private readonly options: RateLimitOptions) {
    if (options.secret.length < 32) throw new Error('Rate limit HMAC secret must contain at least 32 characters');
  }

  async classify(principal: VerifiedAccountAssertion): Promise<PrincipalClass> {
    // Only operator-installed clients in the deployment allowlist get this
    // class. User tokens retain their Account subject even across clients.
    if (principal.accountClientId
      && this.options.serviceClientIds.has(principal.accountClientId)) return 'service';
    const row = (await this.pool.query<{ id: string; active: boolean; newcomer: boolean }>(`SELECT id, active,
      first_seen_at > now() - interval '7 days' AS newcomer FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2`, [principal.issuer, principal.subject])).rows[0];
    // The handler remains responsible for authorization, including allowing a
    // suspended principal to use safety intake. Unknown principals are new.
    if (!row || !row.active) return 'new-account';
    const agents = (await this.pool.query<{ subject_id: string; action: string }>(`SELECT DISTINCT r.subject_id, r.action
      FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
      WHERE r.principal_id = $1 AND r.active AND r.valid_until > now()
        AND r.action IN ('work.create', 'work.edit', 'governance.moderate') LIMIT $2`, [row.id, RATE_LIMIT_COST_V1.representations + 1])).rows;
    if (agents.length > RATE_LIMIT_COST_V1.representations) throw new Error('Rate limit representation budget exceeded');
    let trusted = false;
    for (const agent of agents) {
      const roles = (await this.pool.query<{ trusted: boolean }>(`SELECT $2 = ANY(v.permissions) AS trusted
        FROM access.role_binding b JOIN access.role_revision v ON v.family_id = b.family_id AND v.revision = b.role_revision
        JOIN access.role_family f ON f.id = b.family_id
        JOIN access.scope_gate g ON g.id = f.scope_id AND g.open AND g.dispatch_open
        LEFT JOIN access.membership m ON m.id = b.membership_id
        WHERE b.recipient_subject = $1 AND $2 IN ('work.create', 'work.edit') AND b.active AND b.valid_until > now()
          AND f.scope_id = 'work:create:root'
          AND (b.membership_id IS NULL OR (m.state = 'joined' AND m.member_subject = b.recipient_subject
            AND m.generation = b.membership_generation))
        UNION ALL
        SELECT true AS trusted FROM access.realm_admin_assignment a
        JOIN access.realm_admin_role_grant rg ON rg.realm = a.realm AND rg.role_id = a.role_id AND rg.member = a.member
        JOIN access.permission_grant pg ON pg.id = rg.grant_id AND pg.active AND pg.valid_until > now()
        JOIN access.scope_gate g ON g.id = pg.scope_id AND g.open
        WHERE a.member = $1 AND $2 = 'governance.moderate' AND a.valid_until > now() AND pg.action = 'governance.moderate'
        LIMIT $3`, [agent.subject_id, agent.action, RATE_LIMIT_COST_V1.roleRowsPerRepresentation + 1])).rows;
      if (roles.length > RATE_LIMIT_COST_V1.roleRowsPerRepresentation) throw new Error('Rate limit role budget exceeded');
      trusted ||= roles.some(role => role.trusted);
    }
    return trusted ? 'trusted' : row.newcomer ? 'new-account' : 'member';
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
