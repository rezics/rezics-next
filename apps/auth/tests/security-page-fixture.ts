export { signInPage } from '../../../services/auth/src/signin-page';
import type {
  SecurityPageEnvelope,
  SecurityPageSession,
  SecurityPagePasskey,
} from '../../../services/auth/src/security-page';

// Public native DTO fixture for issuer HTTP tests; no credential material.
export function securityEnvelope(
  accountId: string,
  sessions: Array<
    Omit<SecurityPageSession, 'revoke' | 'client_display_name'> &
      Partial<Pick<SecurityPageSession, 'revoke' | 'client_display_name'>>
  >,
  passkeys: Array<Omit<SecurityPagePasskey, 'remove'> & Partial<Pick<SecurityPagePasskey, 'remove'>>>,
  fresh = true,
): SecurityPageEnvelope {
  const credential = fresh ? ('allowed' as const) : ('step-up-required' as const);
  const current = sessions.find((row) => row.current)!;
  return {
    viewer: { account_id: accountId, session_id: current.id, client_id: current.client_id },
    sessions: {
      kind: 'ready',
      limit: 64,
      truncated: false,
      rows: sessions.map((row) => ({
        ...row,
        client_display_name: row.client_display_name ?? null,
        revoke: row.revoke ?? 'allowed',
      })),
    },
    passkeys: {
      kind: 'ready',
      limit: 32,
      truncated: passkeys.length > 32,
      rows: passkeys.slice(0, 32).map((row) => ({ ...row, remove: row.remove ?? credential })),
    },
    actions: { change_password: credential, register_passkey: passkeys.length >= 32 ? 'capacity' : credential },
  };
}
export const currentSecuritySession = () => ({
  id: 'current-session',
  client_id: 'login',
  current: true,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  user_agent: null,
});
