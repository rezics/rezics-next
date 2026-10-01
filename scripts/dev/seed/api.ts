import { signupPolicyFixture } from '../signup-policy-fixture.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertSeedRequest } from './request-schema.ts';
import { recoverSeedPut, seedPutConflict } from './put-recovery.ts';

export interface SeedWriteCounts { written: number; replayed: number; reconciled: number; lookups: number }

export interface SeedEndpoints {
  enrollmentToken?: string;
  account: string;
  accountService?: string;
  main: string;
  mailpit: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  writeCounts?: SeedWriteCounts;
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
  constructor(readonly endpoints: SeedEndpoints,
    private readonly mainTransport: (url: string, init?: RequestInit) => Promise<Response> = fetch) {}

  /** A closed socket can lose a response after Main has committed. Repeat the
   * exact request: stable creation keys and refreshed PUT keys retain the same
   * intent, and the owner receipt determines whether it already completed. */
  private async mainResponse(path: string, init: RequestInit, attempt: number, lastAttempt: number): Promise<Response | null> {
    try { return await this.mainTransport(`${this.endpoints.main}${path}`, init); }
    catch (cause) {
      if (attempt >= lastAttempt) throw new Error(`Main ${path}: transport failed after retries`, { cause });
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      return null;
    }
  }

  /** Account's public origin defines its issuer and Origin checks; the native
   * service serves the same API without requiring the Accounts UI proxy. */
  private accountFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    if (this.endpoints.accountService && url.origin === this.endpoints.account) {
      const service = new URL(this.endpoints.accountService);
      url.protocol = service.protocol;
      url.host = service.host;
    }
    return fetch(url, init);
  }

  private async verifyEmail(email: string): Promise<void> {
    const { account, mailpit } = this.endpoints;
    const requestedAt = Date.now();
    const sent = await this.accountFetch(`${account}/api/auth/send-verification-email`, { method: 'POST',
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
        const verified = await this.accountFetch(match, { redirect: 'manual' });
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
    const signIn = () => this.accountFetch(`${account}/api/auth/sign-in/email`, { method: 'POST', headers,
      body: JSON.stringify({ email: user.email, password: user.password }) });
    let response = await signIn();
    if ([400, 401, 404].includes(response.status) && user.name) {
      await response.body?.cancel();
      const registration = await this.accountFetch(`${account}/api/auth/sign-up/email`, { method: 'POST', headers,
        body: JSON.stringify({ ...signupPolicyFixture, name: user.name, email: user.email, password: user.password }) });
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
    // Demo accounts may predate the policy journal; record current acceptance
    // through the authenticated API when reusing them, never by database edits.
    await payload<unknown>(await fetch(`${account}/api/account/policies/acceptance`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: account, cookie },
      body: JSON.stringify({ acceptedPolicies: signupPolicyFixture.acceptedPolicies }),
    }), `Account policy acceptance ${user.email}`);
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
    const authorized = await this.accountFetch(authorize, { headers: { cookie }, redirect: 'manual' });
    const location = authorized.headers.get('location');
    if (authorized.status !== 302 || !location) {
      throw new SeedApiError('OAuth authorize', authorized.status, (await authorized.text()).slice(0, 500));
    }
    const code = new URL(location, account).searchParams.get('code');
    if (!code) throw new Error(`OAuth authorize: no code in ${new URL(location, account).pathname}`);
    const exchanged = await this.accountFetch(`${account}/api/auth/oauth2/token`, { method: 'POST',
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
      const response = await this.mainResponse(path, { headers }, attempt, 9);
      if (!response) continue;
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
      const response = await this.mainResponse(path, { method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          'idempotency-key': attemptKey }, body: JSON.stringify(body) }, attempt, 7);
      if (!response) continue;
      if (response.status === 503 && method === 'POST' && path === '/v1/catalogue/candidates' && attempt < 7) {
        const detail = await response.clone().json().catch(() => null) as { code?: string } | null;
        if (detail?.code === 'search_index_unavailable' || detail?.code === 'catalogue_unavailable') {
          // Just-updated metadata can outpace the public index. Search only;
          // creation keys and bodies remain unchanged while it catches up.
          await response.body?.cancel();
          await new Promise(resolve => setTimeout(resolve, Math.min(4000, 500 * 2 ** attempt)));
          continue;
        }
      }
      // A stale seed-owned PUT can converge through its public read contract.
      // Pending operations retain their exact body/key until they settle.
      if (response.status === 409 && attempt < 7) {
        const detail = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
        // On a long-lived stack a contract change can give a PUT a new body under
        // its old key. Refresh its state and basis before binding a new key;
        // POST keys stay stable because a new key would create a record.
        const code = typeof detail?.code === 'string' ? detail.code : '';
        if (method === 'POST' && path === '/v1/spaces' && code === 'idempotency_conflict'
          && body && typeof body === 'object' && !('language' in body)) {
          // Older Space creation digests treated an omitted language as English.
          // Replay that exact intent under its existing key, never a new key.
          body = { ...body, language: 'en' };
          assertSeedRequest(method, path, body);
          await response.body?.cancel();
          continue;
        }
        if (method === 'PUT' && seedPutConflict(path, code)) {
          let recovery;
          try {
            recovery = await recoverSeedPut(path, body, (route, authenticated) => authenticated
              ? this.get<Record<string, unknown>>(route, token) : this.getPublic<Record<string, unknown>>(route), detail!);
          } catch (error) {
            // A fresh target may not have a read representation yet. Only an
            // idempotency conflict permits the original body-bound fallback.
            if (!(error instanceof SeedApiError) || error.status !== 404 || code !== 'idempotency_conflict') {
              await response.body?.cancel();
              throw error;
            }
          }
          if (recovery?.matches) {
            await response.body?.cancel();
            if (this.endpoints.writeCounts) this.endpoints.writeCounts.reconciled++;
            return recovery.result as T;
          }
          if (recovery || code === 'idempotency_conflict' && attemptKey === key) {
            body = recovery?.body ?? body;
            assertSeedRequest(method, path, body);
            // Hash the entire body, including the refreshed basis. Keep keys
            // bounded even when the original key already uses all 128 bytes.
            const nextKey = `seed-put:${createHash('sha256').update(`${path}:${key}:${JSON.stringify(body)}`).digest('hex')}`;
            if (nextKey !== attemptKey) {
              attemptKey = nextKey;
              await response.body?.cancel();
              continue;
            }
          }
        }
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
      if (response.status !== 202) {
        const result = await payload<T>(response, `Main ${path}`);
        if (this.endpoints.writeCounts) {
          // Like the catalogue fixture's createdWrites, count seed-record
          // commands separately from candidate searches and their evidence.
          const replayed = !!result && typeof result === 'object' && 'replayed' in result && result.replayed === true;
          this.endpoints.writeCounts[path === '/v1/catalogue/candidates' || path === '/v1/classification-resolutions'
            ? 'lookups' : replayed ? 'replayed' : 'written']++;
        }
        return result;
      }
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Main ${path}: pending after retries; rerun with the same key`);
  }
}
