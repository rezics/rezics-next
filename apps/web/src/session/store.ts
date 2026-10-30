import { DurableObject } from 'cloudflare:workers';
import * as oidc from 'openid-client';
import { authClient, type SessionEnv } from './client.ts';
import { csrfTokenMatches } from './csrf.ts';

export type Login = {
  kind: 'login';
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
};
export type Session = {
  kind: 'session';
  subject: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  idToken: string;
  csrfToken: string;
  expiresAt: number;
};
type Credential =
  | { status: 'active'; subject: string; accessToken: string; csrfToken: string }
  | { status: 'absent' }
  | { status: 'unavailable'; csrfToken?: string };
type EndResult = { allowed: false } | { allowed: true; idToken?: string };

export class SessionStore extends DurableObject<SessionEnv> {
  private refreshing: Promise<Credential> | undefined;
  private ending = false;

  async create(record: Login | Session): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put('record', record);
      await storage.setAlarm(record.expiresAt);
    });
  }

  async takeLogin(): Promise<Login | undefined> {
    return this.ctx.storage.transaction(async (storage) => {
      const record = await storage.get<Login | Session>('record');
      await storage.delete('record');
      await storage.deleteAlarm();
      return record?.kind === 'login' && record.expiresAt > Date.now() ? record : undefined;
    });
  }

  // Pages need only the session's lifetime, never an access token or a refresh.
  async signedIn(): Promise<{ signedIn: boolean; subject?: string; csrfToken: string | null }> {
    const record = await this.ctx.storage.get<Login | Session>('record');
    const signedIn =
      !this.ending &&
      record?.kind === 'session' &&
      record.expiresAt > Date.now() &&
      typeof record.csrfToken === 'string';
    return {
      signedIn,
      ...(signedIn && record?.kind === 'session' ? { subject: record.subject } : {}),
      csrfToken: signedIn && record?.kind === 'session' ? record.csrfToken : null,
    };
  }

  // A storage input gate does not span the token endpoint fetch. All callers share
  // this promise until the rotated refresh token has been durably stored.
  credential(): Promise<Credential> {
    if (this.ending) return Promise.resolve({ status: 'absent' });
    this.refreshing ??= this.readCredential().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  // Exposure controls are a progressive enhancement. They may use a currently
  // valid token, but a page read must not refresh one or contact Auth.
  async credentialIfFresh(): Promise<Credential> {
    if (this.ending) return { status: 'absent' };
    return this.readCredential(false);
  }

  private async readCredential(refresh = true): Promise<Credential> {
    const record = await this.ctx.storage.get<Login | Session>('record');
    if (record?.kind !== 'session') return { status: 'absent' };
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return { status: 'absent' };
    }
    if (record.accessExpiresAt - Date.now() < 60_000) {
      if (!refresh) return { status: 'unavailable', csrfToken: record.csrfToken };
      try {
        const tokens = await oidc.refreshTokenGrant(await authClient(this.env), record.refreshToken, {
          resource: this.env.API_RESOURCE,
        });
        record.accessToken = tokens.access_token;
        record.accessExpiresAt = Date.now() + (tokens.expires_in ?? 0) * 1000;
        record.refreshToken = tokens.refresh_token ?? record.refreshToken;
        record.idToken = tokens.id_token ?? record.idToken;
        // Sign-out and alarms wait for this write, so they can revoke the newest
        // refresh token and cannot race a write that would restore deleted state.
        await this.ctx.storage.put('record', record);
      } catch (error) {
        if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant') {
          await this.ctx.storage.deleteAll();
          await this.ctx.storage.deleteAlarm();
          return { status: 'absent' };
        }
        return { status: 'unavailable', csrfToken: record.csrfToken };
      }
    }
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return { status: 'absent' };
    }
    return this.ending
      ? { status: 'absent' }
      : { status: 'active', subject: record.subject, accessToken: record.accessToken, csrfToken: record.csrfToken };
  }

  async end(token?: string | null): Promise<string | undefined | EndResult> {
    const csrfProtected = token !== undefined;
    if (this.ending) return csrfProtected ? { allowed: false } : undefined;
    this.ending = true;
    await this.refreshing;
    const record = await this.ctx.storage.get<Login | Session>('record');
    const session = record?.kind === 'session' && record.expiresAt > Date.now() ? record : undefined;
    if (csrfProtected && (!session || !csrfTokenMatches(session.csrfToken, token ?? null))) {
      this.ending = false;
      return { allowed: false };
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (!session) return undefined;
    try {
      await oidc.tokenRevocation(await authClient(this.env), session.refreshToken, {
        token_type_hint: 'refresh_token',
      });
    } catch {
      // Local sign-out succeeds even if Auth cannot revoke the refresh token.
    }
    return csrfProtected ? { allowed: true, idToken: session.idToken } : session.idToken;
  }

  async alarm(): Promise<void> {
    this.ending = true;
    await this.refreshing;
    await this.ctx.storage.deleteAll();
  }
}
