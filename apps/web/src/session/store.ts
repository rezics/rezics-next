import { DurableObject } from 'cloudflare:workers';
import * as oidc from 'openid-client';
import { authClient, type SessionEnv } from './client.ts';

export type Login = {
  kind: 'login'; state: string; nonce: string; verifier: string; returnTo: string; expiresAt: number;
};
export type Session = {
  kind: 'session'; subject: string; accessToken: string; accessExpiresAt: number;
  refreshToken: string; idToken: string; expiresAt: number;
};
type Credential = { status: 'active'; accessToken: string } | { status: 'absent' } | { status: 'unavailable' };

export class SessionStore extends DurableObject<SessionEnv> {
  private refreshing: Promise<Credential> | undefined;
  private ending = false;

  async create(record: Login | Session): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      await storage.put('record', record);
      await storage.setAlarm(record.expiresAt);
    });
  }

  async takeLogin(): Promise<Login | undefined> {
    return this.ctx.storage.transaction(async storage => {
      const record = await storage.get<Login | Session>('record');
      await storage.delete('record');
      await storage.deleteAlarm();
      return record?.kind === 'login' && record.expiresAt > Date.now() ? record : undefined;
    });
  }

  // A storage input gate does not span the token endpoint fetch. All callers share
  // this promise until the rotated refresh token has been durably stored.
  credential(): Promise<Credential> {
    if (this.ending) return Promise.resolve({ status: 'absent' });
    this.refreshing ??= this.readCredential().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async readCredential(): Promise<Credential> {
    const record = await this.ctx.storage.get<Login | Session>('record');
    if (record?.kind !== 'session') return { status: 'absent' };
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return { status: 'absent' };
    }
    if (record.accessExpiresAt - Date.now() < 60_000) {
      try {
        const tokens = await oidc.refreshTokenGrant(await authClient(this.env), record.refreshToken);
        record.accessToken = tokens.access_token;
        record.accessExpiresAt = Date.now() + (tokens.expires_in ?? 0) * 1000;
        record.refreshToken = tokens.refresh_token ?? record.refreshToken;
        record.idToken = tokens.id_token ?? record.idToken;
        // Sign-out and alarms wait for this write, so they can revoke the newest
        // refresh token and cannot race a write that would restore deleted state.
        await this.ctx.storage.put('record', record);
      } catch (error) {
        if (error instanceof oidc.ResponseBodyError) {
          await this.ctx.storage.deleteAll();
          await this.ctx.storage.deleteAlarm();
          return { status: 'absent' };
        }
        return { status: 'unavailable' };
      }
    }
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return { status: 'absent' };
    }
    return this.ending ? { status: 'absent' } : { status: 'active', accessToken: record.accessToken };
  }

  async end(): Promise<string | undefined> {
    this.ending = true;
    await this.refreshing;
    const record = await this.ctx.storage.get<Login | Session>('record');
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    if (record?.kind !== 'session' || record.expiresAt <= Date.now()) return undefined;
    try {
      await oidc.tokenRevocation(await authClient(this.env), record.refreshToken, { token_type_hint: 'refresh_token' });
    } catch {
      // Local sign-out succeeds even if Auth cannot revoke the refresh token.
    }
    return record.idToken;
  }

  async alarm(): Promise<void> {
    this.ending = true;
    await this.refreshing;
    await this.ctx.storage.deleteAll();
  }
}
