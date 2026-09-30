import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { agentForHandle } from './handle.ts';

export const VANITY_HANDLE_PATTERN = '^[a-z0-9_]{3,30}$';
export const HANDLE_COOLDOWN_DAYS = 30;
// Include every current web top-level segment and names that imply site authority.
export const RESERVED_HANDLES = new Set([
  'api', 'auth', 'identity', 'discover', 'search', 'w', 'works', 'sign_in',
  'sign_out', 'studio', 'locale', 'admin', 'staff', 'moderator', 'support',
  'help', 'system', 'root', 'official', 'rezics', 'security', 'billing',
  'administrator', 'admins', 'mod', 'mods', 'moderators', 'team', 'trust',
  'safety', 'abuse', 'contact', 'recovery', 'owner', 'webmaster', 'postmaster',
  'about', 'settings', 'profile', 'me', 'home', 'new', 'login', 'signup',
  'register', 'account', 'accounts', 'user', 'users', 'agent', 'agents',
  'handles', 'v1', 'health', 'shelves', 'inbox', 'notifications', 'create',
  'library', 'groups', 'realms', 'spaces',
]);
const agentId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
export class VanityInvalid extends Error {}
export class VanityDenied extends Error {}
export class VanityConflict extends Error {}
export class VanityCooldown extends Error { constructor(readonly availableAt: string) { super('handle rename cooldown'); } }
export class VanityUnavailable extends Error {}

export function normalizeVanity(value: string): string {
  const handle = value.toLowerCase();
  if (!new RegExp(VANITY_HANDLE_PATTERN).test(handle) || RESERVED_HANDLES.has(handle)
    || agentForHandle(handle)) throw new VanityInvalid('invalid or reserved handle');
  return handle;
}
export function suggestVanity(displayName: string): string {
  const base = displayName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/g, '');
  return base.length >= 3 && !RESERVED_HANDLES.has(base) ? base : 'reader';
}
interface HandleRow { handle: string; agent_id: string; state: 'current' | 'retired';
  claimed_at: Date }
export interface HandleResolution { agent: string; handle: string; currentHandle: string;
  state: 'current' | 'retired' | 'native'; redirect: boolean }
export interface HandleChange { profile: 'agent-handle-v1'; agent: string; handle: string;
  previousHandle: string | null; changedAt: string; replayed: boolean }
export interface HandleAvailability { profile: 'agent-handle-availability-v1';
  handle: string; available: boolean; reason: 'available' | 'invalid' | 'reserved' | 'claimed' | 'retained' | 'confusable' }

/** Each read uses at most three primary-key/index probes. A write locks one
 * principal, one Agent and one skeleton, then probes the current handle, two
 * skeleton/Agent ranges, the handle key and one receipt. Fixed round trips and
 * O(log N) index seeks; no scan of an Agent's growing retained-alias inventory. */
export class AgentVanityHandles {
  constructor(private readonly pool: Pool) {}

  async current(agent: string): Promise<string | null> {
    const row = (await this.pool.query<{ handle: string }>(`SELECT handle FROM access.agent_handle
      WHERE agent_id = $1 AND state = 'current'`, [agent])).rows[0];
    return row?.handle ?? null;
  }

  /** One indexed probe for a page of Agents; an Agent without a vanity handle is absent. */
  async currents(agents: readonly string[]): Promise<Map<string, string>> {
    if (!agents.length) return new Map();
    return new Map((await this.pool.query<{ agent_id: string; handle: string }>(`SELECT agent_id, handle
      FROM access.agent_handle WHERE agent_id = ANY($1::text[]) AND state = 'current'`, [agents])).rows
      .map(row => [row.agent_id, row.handle]));
  }

  async resolve(input: string): Promise<HandleResolution | null> {
    const handle = input.toLowerCase();
    const native = agentForHandle(input);
    if (native) {
      const currentHandle = await this.current(native);
      return { agent: native, handle: input, currentHandle: currentHandle ?? input,
        state: 'native', redirect: currentHandle !== null };
    }
    if (!new RegExp(VANITY_HANDLE_PATTERN).test(handle)) return null;
    const row = (await this.pool.query<HandleRow>(`SELECT handle, agent_id, state
      FROM access.agent_handle WHERE handle = $1`, [handle])).rows[0];
    if (!row) return null;
    const currentHandle = row.state === 'current' ? handle : (await this.current(row.agent_id))
      ?? `agent-${row.agent_id.slice(-36)}`;
    return { agent: row.agent_id, handle, currentHandle, state: row.state,
      redirect: row.state === 'retired' || input !== handle };
  }

  async availability(input: string): Promise<HandleAvailability> {
    const handle = input.toLowerCase();
    let verdict: HandleAvailability['reason'];
    if (!new RegExp(VANITY_HANDLE_PATTERN).test(handle) || agentForHandle(handle)) verdict = 'invalid';
    else if (RESERVED_HANDLES.has(handle)) verdict = 'reserved';
    else {
      const exact = (await this.pool.query<Pick<HandleRow, 'state'>>(`SELECT state
        FROM access.agent_handle WHERE handle = $1`, [handle])).rows[0];
      verdict = exact ? exact.state === 'current' ? 'claimed' : 'retained'
        : (await this.pool.query(`SELECT 1 FROM access.agent_handle
          WHERE skeleton = access.handle_skeleton($1) LIMIT 1`, [handle])).rowCount
          ? 'confusable' : 'available';
    }
    return { profile: 'agent-handle-availability-v1', handle,
      available: verdict === 'available', reason: verdict };
  }

  async change(principal: VerifiedPrincipal, agent: string, proposed: string,
    expectedHandle: string | null, idempotencyKey: string): Promise<HandleChange> {
    if (!agentId.test(agent) || !keyPattern.test(idempotencyKey)
      || (expectedHandle !== null && !new RegExp(VANITY_HANDLE_PATTERN).test(expectedHandle))) {
      throw new VanityInvalid('invalid handle change input');
    }
    const handle = normalizeVanity(proposed);
    const digest = createHash('sha256').update(JSON.stringify({ agent, handle, expectedHandle })).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = (await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
      if (!fence?.open) throw new VanityUnavailable('Access recovery hold');
      const actor = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR UPDATE`,
      [principal.issuer, principal.subject])).rows[0];
      if (!actor || !(await client.query(`SELECT 1 FROM access.representation r
        JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
        WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = 'agent.control'
          AND r.active AND r.valid_until > clock_timestamp()
        LIMIT 1 FOR SHARE OF r, s`, [actor.id, agent])).rowCount) {
        throw new VanityDenied('Agent control is unavailable');
      }
      const priorReceipt = (await client.query<{ request_digest: string; handle: string;
        previous_handle: string | null; changed_at: Date }>(`SELECT request_digest, handle,
          previous_handle, changed_at FROM access.agent_handle_receipt
          WHERE principal_id = $1 AND idempotency_key = $2`, [actor.id, idempotencyKey])).rows[0];
      if (priorReceipt) {
        if (priorReceipt.request_digest !== digest) throw new VanityConflict('idempotency key reused');
        await client.query('COMMIT');
        return { profile: 'agent-handle-v1', agent, handle: priorReceipt.handle,
          previousHandle: priorReceipt.previous_handle,
          changedAt: priorReceipt.changed_at.toISOString(), replayed: true };
      }
      // The Agent row serializes concurrent renames even when its handle is absent.
      await client.query('SELECT id FROM access.authority_subject WHERE id = $1 FOR UPDATE', [agent]);
      const previous = (await client.query<HandleRow>(`SELECT handle, claimed_at FROM access.agent_handle
        WHERE agent_id = $1 AND state = 'current' FOR UPDATE`, [agent])).rows[0];
      if ((previous?.handle ?? null) !== expectedHandle) throw new VanityConflict('handle changed');
      if (previous?.handle === handle) throw new VanityConflict('handle is already current');
      const now = new Date();
      if (previous && now.getTime() < previous.claimed_at.getTime() + HANDLE_COOLDOWN_DAYS * 86400_000) {
        throw new VanityCooldown(new Date(previous.claimed_at.getTime()
          + HANDLE_COOLDOWN_DAYS * 86400_000).toISOString());
      }
      // An absent handle has no row to lock. All claims of equivalent spellings
      // share this transaction lock, including when different Agents race.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(
        'agent-handle:' || access.handle_skeleton($1), 0))`, [handle]);
      const foreign = (await client.query(`SELECT 1 WHERE
        EXISTS (SELECT 1 FROM access.agent_handle WHERE skeleton = access.handle_skeleton($1)
          AND agent_id < $2) OR
        EXISTS (SELECT 1 FROM access.agent_handle WHERE skeleton = access.handle_skeleton($1)
          AND agent_id > $2)`, [handle, agent])).rowCount;
      if (foreign) {
        const exact = (await client.query(`SELECT 1 FROM access.agent_handle
          WHERE handle = $1 AND agent_id <> $2`, [handle, agent])).rowCount;
        throw new VanityConflict(exact ? 'handle unavailable' : 'handle confusable');
      }
      if (previous) await client.query(`UPDATE access.agent_handle SET state = 'retired',
        retired_until = 'infinity' WHERE handle = $1`, [previous.handle]);
      const claimed = await client.query<Pick<HandleRow, 'claimed_at'>>(`INSERT INTO access.agent_handle
        (handle, agent_id, state) VALUES ($1,$2,'current')
        ON CONFLICT (handle) DO UPDATE SET state = 'current',
          claimed_at = clock_timestamp(), retired_until = NULL
        WHERE access.agent_handle.state = 'retired' AND access.agent_handle.agent_id = EXCLUDED.agent_id
        RETURNING claimed_at`, [handle, agent]);
      if (!claimed.rowCount) throw new VanityConflict('handle unavailable');
      const changedAt = claimed.rows[0]!.claimed_at;
      await client.query(`INSERT INTO access.agent_handle_receipt
        (principal_id, idempotency_key, request_digest, agent_id, handle, previous_handle, changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.id, idempotencyKey, digest, agent, handle, previous?.handle ?? null, changedAt]);
      await client.query('COMMIT');
      return { profile: 'agent-handle-v1', agent, handle,
        previousHandle: previous?.handle ?? null, changedAt: changedAt.toISOString(), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error) {
        if (String(error.code) === '23505') throw new VanityConflict('handle unavailable');
        if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
          throw new VanityUnavailable('handle owner timed out');
        }
      }
      throw error;
    } finally { client.release(); }
  }
}
