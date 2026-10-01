import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertSeedRequest } from './request-schema.ts';

export interface SeedEndpoints {
  enrollmentToken?: string;
  account: string;
  main: string;
  mailpit: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
}

export interface Credentials { email: string; password: string; name?: string }

export class SeedApiError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly detail: string) {
    super(`${operation}: HTTP ${status} ${detail}`);
  }
}

async function payload<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new SeedApiError(operation, response.status, text.slice(0, 500));
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${operation}: invalid JSON response`); }
}

export class SeedApi {
  constructor(readonly endpoints: SeedEndpoints) {}

  private async verifyEmail(email: string): Promise<void> {
    const { account, mailpit } = this.endpoints;
    const requestedAt = Date.now();
    const sent = await fetch(`${account}/api/auth/send-verification-email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: account,
        ...(this.endpoints.enrollmentToken ? { 'x-captcha-response': this.endpoints.enrollmentToken } : {}) },
      body: JSON.stringify({ email }) });
    await payload<unknown>(sent, `Account verification request ${email}`);
    for (let attempt = 0; attempt < 30; attempt++) {
      const inbox = await fetch(`${mailpit}/api/v1/messages?limit=100`);
      const list = await payload<{ messages: Array<{ ID: string;
        To: Array<{ Address: string }>; Created: string }> }>(inbox, 'Local mail inbox');
      const message = list.messages.find(item => item.To.some(to => to.Address === email)
        && new Date(item.Created).getTime() >= requestedAt - 5_000);
      if (message) {
        const detail = await fetch(`${mailpit}/api/v1/message/${encodeURIComponent(message.ID)}`);
        const body = await payload<{ Text: string }>(detail, 'Local verification message');
        const match = body.Text.match(/https?:\/\/[^\s<>]+/g)?.find(value => {
          try { const url = new URL(value); return url.origin === account
            && url.pathname === '/api/auth/verify-email'; } catch { return false; }
        });
        if (!match) throw new Error(`Local verification message for ${email} has no Account link`);
        const verified = await fetch(match, { redirect: 'manual' });
        if (verified.status !== 302 && !verified.ok) {
          throw new SeedApiError(`Account email verification ${email}`, verified.status,
            (await verified.text()).slice(0, 300));
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Verification email for ${email} did not reach local Mailpit`);
  }

  async signInOrUp(user: Credentials): Promise<{ cookie: string; id: string }> {
    const account = this.endpoints.account;
    const headers = { 'content-type': 'application/json', origin: account,
      ...(this.endpoints.enrollmentToken ? { 'x-captcha-response': this.endpoints.enrollmentToken } : {}) };
    const signIn = () => fetch(`${account}/api/auth/sign-in/email`, { method: 'POST', headers,
      body: JSON.stringify({ email: user.email, password: user.password }) });
    let response = await signIn();
    if ([400, 401, 404].includes(response.status) && user.name) {
      await response.body?.cancel();
      const registration = await fetch(`${account}/api/auth/sign-up/email`, { method: 'POST', headers,
        body: JSON.stringify({ name: user.name, email: user.email, password: user.password }) });
      await payload<unknown>(registration, `Account sign-up ${user.email}`);
      response = await signIn();
    }
    if (response.status === 403 && (await response.clone().text()).includes('EMAIL_NOT_VERIFIED')) {
      await response.body?.cancel();
      await this.verifyEmail(user.email);
      response = await signIn();
    }
    const data = await payload<{ user?: { id?: string } }>(response, `Account sign-in ${user.email}`);
    const cookie = response.headers.get('set-cookie');
    if (!cookie || !data.user?.id) throw new Error(`Account sign-in ${user.email}: missing session`);
    return { cookie, id: data.user.id };
  }

  async token(cookie: string): Promise<string> {
    const { account, clientId, redirectUri, resource, scope } = this.endpoints;
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${account}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId,
      redirect_uri: redirectUri, scope, state: randomUUID(), resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
    const location = authorized.headers.get('location');
    if (authorized.status !== 302 || !location) {
      throw new SeedApiError('OAuth authorize', authorized.status, (await authorized.text()).slice(0, 500));
    }
    const code = new URL(location, account).searchParams.get('code');
    if (!code) throw new Error(`OAuth authorize: no code in ${new URL(location, account).pathname}`);
    const exchanged = await fetch(`${account}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
        code, redirect_uri: redirectUri, code_verifier: verifier, resource }) });
    const result = await payload<{ access_token?: string }>(exchanged, 'OAuth token');
    if (!result.access_token) throw new Error('OAuth token: missing access_token');
    return result.access_token;
  }

  async put<T>(path: string, body: unknown, token: string, key: string): Promise<T> {
    return this.write('PUT', path, body, token, key);
  }

  async get<T>(path: string, token: string): Promise<T> {
    return this.read(path, { authorization: `Bearer ${token}` });
  }

  async getPublic<T>(path: string): Promise<T> {
    return this.read(path);
  }

  private async read<T>(path: string, headers?: HeadersInit): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(`${this.endpoints.main}${path}`, { headers });
      if ([409, 503].includes(response.status) && attempt < 9) {
        const detail = await response.clone().json().catch(() => null) as { code?: string } | null;
        if (detail?.code === 'read_basis_changed' || detail?.code === 'work_read_unavailable') {
          await response.body?.cancel();
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          continue;
        }
      }
      return payload<T>(response, `Main ${path}`);
    }
    throw new Error(`Main ${path}: read retries exhausted`);
  }

  async post<T>(path: string, body: unknown, token: string, key: string): Promise<T> {
    return this.write('POST', path, body, token, key);
  }

  private async write<T>(method: 'PUT' | 'POST', path: string, body: unknown,
    token: string, key: string): Promise<T> {
    assertSeedRequest(method, path, body);
    let attemptKey = key;
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(`${this.endpoints.main}${path}`, { method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          'idempotency-key': attemptKey }, body: JSON.stringify(body) });
      // A read fence can move while another fixture writes. Retry only that
      // explicit conflict; optimistic-head conflicts must remain failures.
      if (response.status === 409 && attempt < 7) {
        const detail = await response.clone().json().catch(() => null) as { code?: string } | null;
        if (detail?.code === 'read_basis_changed') {
          // This owner cancels its admission when the second root probe moves,
          // before saving Content. That cancelled key cannot be re-admitted.
          // A fresh deterministic attempt retains the body's expected-head CAS;
          // pending/lost-response replays still use the current attempt key.
          if (method === 'POST' && path === '/v1/member-reply-drafts') {
            attemptKey = `seed-read:${createHash('sha256').update(`${key}:${attempt + 1}`).digest('hex')}`;
          }
          await response.body?.cancel();
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
      }
      if (response.status !== 202) return payload<T>(response, `Main ${path}`);
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Main ${path}: pending after retries; rerun with the same key`);
  }
}
