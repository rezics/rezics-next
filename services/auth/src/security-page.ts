import { securityResponseLimits as limits } from '@rezics/auth-contract';
import { securityId, securityDisplay, securityDate, securityPasskey } from './security-response-bounds.ts';
import type { Pool } from 'pg';

/** Observations of the existing own-human command guards, never an authorization. */
export type SecurityAdvice = 'allowed' | 'step-up-required' | 'last-credential' | 'capacity' | 'unavailable';
export type SecurityPageSession = {
  id: string;
  client_id: string;
  client_display_name: string | null;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  current: boolean;
  revoke: SecurityAdvice;
};
export type SecurityPagePasskey = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  remove: SecurityAdvice;
};
export type SecurityPageInventory<T> =
  | { kind: 'ready'; rows: T[]; limit: number; truncated: boolean }
  | { kind: 'unavailable' };
export type SecurityPageEnvelope = {
  viewer: { account_id: string; session_id: string; client_id: string };
  sessions: SecurityPageInventory<SecurityPageSession>;
  passkeys: SecurityPageInventory<SecurityPagePasskey>;
  actions: { change_password: SecurityAdvice; register_passkey: SecurityAdvice };
};
type Viewer = SecurityPageEnvelope['viewer'] & {
  fresh: boolean;
  credentialCommands: boolean;
  passwordCommands: boolean;
  now: number;
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** One finite page, no cursor or selected account input. Owner/id seeks use
 * erasure_session_0 and passkey_userid_idx. Read one sentinel beyond each window;
 * never infer completeness from a saturated window. Authority surrounds this read.
 */
export async function composeSecurityPage(database: Pool, viewer: Viewer): Promise<SecurityPageEnvelope> {
  const credential: SecurityAdvice = !viewer.credentialCommands
    ? 'unavailable'
    : viewer.fresh
      ? 'allowed'
      : 'step-up-required';
  const page: SecurityPageEnvelope = {
    viewer: {
      account_id: securityId(viewer.account_id),
      session_id: securityId(viewer.session_id),
      client_id: securityId(viewer.client_id),
    },
    sessions: { kind: 'unavailable' },
    passkeys: { kind: 'unavailable' },
    actions: {
      change_password: viewer.passwordCommands ? (viewer.fresh ? 'allowed' : 'step-up-required') : 'unavailable',
      register_passkey: 'unavailable',
    },
  };
  // Separate failures retain the usable section. No exception fabricates an empty inventory.
  try {
    const { rows } = await database.query(
      `SELECT s.id,s."clientId" AS client_id,
              CASE WHEN c.display_name_writer=1 AND NOT c.erasure_fenced THEN c.display_name END AS client_display_name,
              s."createdAt" AS created_at,s."expiresAt" AS expires_at,s."userAgent" AS user_agent
       FROM session s LEFT JOIN auth_client c ON c.client_id=s."clientId"
       WHERE s."userId"=$1 AND s.id>$2 ORDER BY s.id LIMIT 65`,
      [viewer.account_id, ''],
    );
    const seen = new Set<string>();
    const valid: SecurityPageSession[] = [];
    for (const row of rows) {
      if (
        !record(row) ||
        !text(row.id) ||
        seen.has(row.id) ||
        !text(row.client_id) ||
        (row.client_display_name !== null && typeof row.client_display_name !== 'string') ||
        (row.user_agent !== null && typeof row.user_agent !== 'string')
      )
        throw new Error('Invalid session');
      const created = securityDate(row.created_at),
        expires = securityDate(row.expires_at);
      if (!created || !expires) throw new Error('Invalid session date');
      seen.add(row.id);
      valid.push({
        id: securityId(row.id),
        client_id: securityId(row.client_id),
        client_display_name: securityDisplay(row.client_display_name, limits.displayName),
        created_at: created,
        expires_at: expires,
        user_agent: securityDisplay(row.user_agent, limits.userAgent),
        current: row.id === viewer.session_id,
        revoke: 'allowed',
      });
    }
    if (rows.length > 65) throw new Error('Invalid session window');
    const visible = valid.slice(0, 64).filter((row) => Date.parse(row.expires_at) > viewer.now * 1000);
    // Keep the current session recognizable even on a legacy oversized owner.
    if (!visible.some((row) => row.current)) throw new Error('Current session outside window');
    page.sessions = { kind: 'ready', rows: visible, limit: 64, truncated: valid.length > 64 };
  } catch {
    /* Keep explicit unavailable. */
  }
  try {
    const { rows } = await database.query(
      'SELECT id,name,"createdAt" AS created_at,last_used_at FROM passkey WHERE "userId"=$1 AND id>$2 ORDER BY id LIMIT 33',
      [viewer.account_id, ''],
    );
    const password = await database.query(
      `SELECT id FROM account WHERE "userId"=$1 AND "providerId"='credential' AND password IS NOT NULL LIMIT 1`,
      [viewer.account_id],
    );
    if (rows.length > 33) throw new Error('Invalid passkey window');
    const seen = new Set<string>();
    const valid: SecurityPagePasskey[] = [];
    for (const row of rows) {
      if (!record(row) || !text(row.id) || seen.has(row.id) || (row.name !== null && typeof row.name !== 'string'))
        throw new Error('Invalid passkey');
      seen.add(row.id);
      valid.push({
        ...securityPasskey(row),
        remove: credential === 'allowed' && !password.rows.length && rows.length === 1 ? 'last-credential' : credential,
      });
    }
    page.passkeys = { kind: 'ready', rows: valid.slice(0, 32), limit: 32, truncated: valid.length > 32 };
    page.actions.register_passkey = valid.length >= 32 ? 'capacity' : credential;
  } catch {
    /* Keep explicit unavailable. */
  }
  return page;
}
