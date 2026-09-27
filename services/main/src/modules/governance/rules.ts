import type { Pool, PoolClient } from 'pg';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { communityRule, MAX_RULES } from '../realm-profile/schema.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceStale, GovernanceUnavailable,
  sha256, type RuleBasis } from './store.ts';

export const RULE_PUBLISH_ACTION = 'governance.rule.publish';
export const publicRealmRules = t.Object({ profile: t.Literal('realm-settings-rules-v1'),
  public: t.Literal(true), rules: t.Array(communityRule, { maxItems: MAX_RULES }) }, { additionalProperties: false });
export const realmRulesRef = (realm: string) => `urn:rezics:realm-rules:${realm.slice(-36)}`;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

export interface RulePublication {
  ref: string; scopeId: string; actingSubject: string; expectedRevision: string | null;
  document: Record<string, unknown>; idempotencyKey: string;
}
export interface PublishedRule {
  ref: string; scopeId: string; revision: string; digest: string;
  document: Record<string, unknown>; replayed: boolean;
}

/** Reused by aggregate settings after its Access authority check. The caller
 * owns the transaction, so rules, settings and the audit receipt commit together. */
export async function publishRuleRevision(client: PoolClient, principalId: string,
  input: RulePublication): Promise<PublishedRule> {
  const document = canonical(input.document);
  if (!input.ref || input.ref.length > 512 || !input.scopeId || input.scopeId.length > 256
    || !agentPattern.test(input.actingSubject) || !keyPattern.test(input.idempotencyKey)
    || input.expectedRevision !== null && !/^[1-9][0-9]{0,18}$/.test(input.expectedRevision)
    || typeof input.document !== 'object' || input.document === null || Array.isArray(input.document)
    || !document || Buffer.byteLength(document) > 16_384) {
    throw new GovernanceInvalid('rule publication does not match its profile');
  }
  const digest = sha256(document);
  const requestDigest = sha256(canonical({ ...input, idempotencyKey: undefined }));
  // The absent head needs the same serialization as a later head CAS.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.ref]);
  const prior = (await client.query<{ ref: string; revision: string; scope_id: string;
    digest: string; document: Record<string, unknown>; request_digest: string }>(
    `SELECT ref, revision::text, scope_id, digest, document, request_digest
     FROM access.governance_rule_revision WHERE principal_id = $1 AND idempotency_key = $2`,
  [principalId, input.idempotencyKey])).rows[0];
  if (prior) {
    if (prior.request_digest !== requestDigest) throw new GovernanceConflict('rule key binds another intent');
    return { ref: prior.ref, scopeId: prior.scope_id, revision: prior.revision, digest: prior.digest,
      document: prior.document, replayed: true };
  }
  const head = (await client.query<{ revision: string; scope_id: string }>(
    'SELECT revision::text, scope_id FROM access.governance_rule_head WHERE ref = $1 FOR UPDATE',
  [input.ref])).rows[0];
  if (head?.scope_id && head.scope_id !== input.scopeId) throw new GovernanceDenied('rule belongs to another scope');
  if ((head?.revision ?? null) !== input.expectedRevision) throw new GovernanceStale('rule head changed');
  const revision = head ? (BigInt(head.revision) + 1n).toString() : '1';
  if (head) {
    await client.query('UPDATE access.governance_rule_head SET revision = $2, digest = $3 WHERE ref = $1',
      [input.ref, revision, digest]);
  } else {
    await client.query(`INSERT INTO access.governance_rule_head (ref, scope_id, revision, digest)
      VALUES ($1, $2, $3, $4)`, [input.ref, input.scopeId, revision, digest]);
  }
  await client.query(`INSERT INTO access.governance_rule_revision (ref, revision, scope_id, digest,
    document, principal_id, acting_subject, idempotency_key, request_digest)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
  [input.ref, revision, input.scopeId, digest, document, principalId, input.actingSubject,
    input.idempotencyKey, requestDigest]);
  return { ref: input.ref, scopeId: input.scopeId, revision, digest, document: input.document,
    replayed: false };
}

/** One Access transaction publishes an immutable rule revision and advances its CAS head. */
export class GovernanceRules implements RuleBasis {
  constructor(private readonly pool: Pool) {}

  /** Only the explicit public profile crosses into Realm home reads. Generic
   * governance documents may contain private material and never fall through.
   * Localized maps use the existing Realm profile schema and read-side fallback. */
  async publishedRealmRules(realm: string, authorizedRealmRead = false) {
    const row = (await this.pool.query<{ open: boolean; document: unknown }>(`SELECT f.open,r.document
      FROM access.recovery_fence f LEFT JOIN access.governance_rule_head h
        ON h.ref = $1 AND h.scope_id = $2
      LEFT JOIN access.governance_rule_revision r ON r.ref = h.ref AND r.revision = h.revision
      WHERE f.id`, [realmRulesRef(realm), `governance:realm:${realm}`])).rows[0];
    if (!row?.open) throw new GovernanceUnavailable('Access is held for recovery');
    // The Realm owner has already fenced disclosure/membership. Keep the
    // public profile validation while allowing its private publication flag.
    const document = authorizedRealmRead && row.document && typeof row.document === 'object'
      ? { ...row.document, public: true } : row.document;
    return Value.Check(publicRealmRules, document) ? document.rules : null;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new GovernanceUnavailable('governance rule owner is unavailable');
    });
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (!fence.rows[0]?.open) throw new GovernanceUnavailable('Access is held for recovery');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
      if (error instanceof GovernanceConflict || error instanceof GovernanceDenied || error instanceof GovernanceInvalid
        || error instanceof GovernanceStale || error instanceof GovernanceUnavailable) throw error;
      const code = (error as { code?: string }).code;
      if (code === '23505' || code === '40001' || code === '40P01') {
        throw new GovernanceConflict('concurrent rule publication');
      }
      throw new GovernanceUnavailable('governance rule owner is unavailable');
    } finally { client.release(); }
  }

  private async authorized(client: PoolClient, principal: VerifiedPrincipal, actingSubject: string,
    scopeId: string): Promise<string> {
    const row = (await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3 AND r.active
      JOIN access.authority_subject a ON a.id = r.subject_id AND a.active
      JOIN access.permission_grant g ON g.recipient_subject = r.subject_id AND g.scope_id = $4
        AND g.action = $5 AND g.active AND g.valid_until > clock_timestamp()
      JOIN access.scope_gate s ON s.id = g.scope_id AND s.open AND s.dispatch_open
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.valid_until > clock_timestamp() LIMIT 1 FOR SHARE OF p, r, a, g, s`,
    [principal.issuer, principal.subject, actingSubject, scopeId, RULE_PUBLISH_ACTION])).rows[0];
    if (!row) throw new GovernanceDenied('rule authority is missing');
    return row.id;
  }

  async publish(principal: VerifiedPrincipal, input: RulePublication): Promise<PublishedRule> {
    return this.transaction(async client => {
      const principalId = await this.authorized(client, principal, input.actingSubject, input.scopeId);
      return publishRuleRevision(client, principalId, input);
    });
  }

  async current(ruleRef: string, scopeId?: string, client?: PoolClient): Promise<{ revision: string; digest: string } | null> {
    const row = (await (client ?? this.pool).query<{ revision: string; digest: string }>(`SELECT revision::text, digest
      FROM access.governance_rule_head WHERE ref = $1 AND ($2::text IS NULL OR scope_id = $2)
      ${client ? 'FOR SHARE' : ''}`,
    [ruleRef, scopeId ?? null]).catch(() => {
      throw new GovernanceUnavailable('governance rule owner is unavailable');
    })).rows[0];
    return row ?? null;
  }

  async read(principal: VerifiedPrincipal, actingSubject: string, ref: string,
    scopeId: string): Promise<PublishedRule> {
    return this.transaction(async client => {
      await this.authorized(client, principal, actingSubject, scopeId);
      const row = (await client.query<{ revision: string; digest: string;
        document: Record<string, unknown> }>(`SELECT h.revision::text, h.digest, r.document
        FROM access.governance_rule_head h JOIN access.governance_rule_revision r
          ON r.ref = h.ref AND r.revision = h.revision
        WHERE h.ref = $1 AND h.scope_id = $2`, [ref, scopeId])).rows[0];
      if (!row) throw new GovernanceDenied('rule is unavailable');
      return { ref, scopeId, revision: row.revision, digest: row.digest,
        document: row.document, replayed: false };
    });
  }
}
