import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface SeedEndpoints {
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
      headers: { 'content-type': 'application/json', origin: account },
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
    const headers = { 'content-type': 'application/json', origin: account };
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
    const response = await fetch(`${this.endpoints.main}${path}`, { method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        'idempotency-key': key }, body: JSON.stringify(body) });
    return payload<T>(response, `Main ${path}`);
  }

  async post<T>(path: string, body: unknown, token: string, key: string): Promise<T> {
    const response = await fetch(`${this.endpoints.main}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        'idempotency-key': key }, body: JSON.stringify(body) });
    const result = await payload<T>(response, `Main ${path}`);
    if (response.status === 202) throw new Error(`Main ${path}: pending; rerun with the same key`);
    return result;
  }

  async put<T>(path: string, body: unknown, token: string, key: string): Promise<T> {
    const response = await fetch(`${this.endpoints.main}${path}`, { method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        'idempotency-key': key }, body: JSON.stringify(body) });
    return payload<T>(response, `Main ${path}`);
  }
}
