import { createHash, randomBytes, randomUUID } from 'node:crypto';
/** Local authorization-code client. Client id, scope and redirect are plain values.
 * `account` resolves redirects and is the consent Origin; `service` is the Account listener. */
export interface LocalOAuthClient { account: string; service?: string; clientId: string; redirectUri: string; scope: string; resource?: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>; authorizeEndpoint?: string; tokenEndpoint?: string; consentEndpoint?: string }
export interface OAuthGrant { access_token: string; refresh_token?: string; expires_in?: number; scope: string; token_type?: string }
export class OAuthClientError extends Error {
  constructor(readonly operation: string, readonly status: number, readonly detail: string) { super(`${operation}: HTTP ${status} ${detail}`); } }
export interface AuthorizeOptions { scope?: string; prompt?: string; state?: string; verifier?: string; attempts?: number; wait?: (ms: number) => Promise<void>; recover?: (response: Response) => Promise<boolean> }
export type Authorization = { ok: true; code: string; verifier: string; scope: string } | { ok: false; response: Response };
const scopeSet = (scope: string) => scope.split(' ').filter(Boolean).sort().join(' ');
const send = (c: LocalOAuthClient, input: string | URL, init?: RequestInit) => (c.fetch ?? fetch)(input, init);
const host = (c: LocalOAuthClient) => c.service ?? c.account;
export function prepareAuthorization(c: LocalOAuthClient, o: AuthorizeOptions = {}) {
  const verifier = o.verifier ?? randomBytes(32).toString('base64url'), scope = o.scope ?? c.scope;
  const url = new URL(c.authorizeEndpoint ?? `${host(c)}/api/auth/oauth2/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope, state: o.state ?? randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(c.resource ? { resource: c.resource } : {}), ...(o.prompt ? { prompt: o.prompt } : {}) })) url.searchParams.set(k, v);
  return { verifier, url, scope }; }
export const postToken = (c: LocalOAuthClient, fields: Record<string, string>) => send(c, c.tokenEndpoint ?? `${host(c)}/api/auth/oauth2/token`,
  { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
function consentQuery(location: URL) {
  if (location.searchParams.get('code') && location.pathname !== '/consent') return;
  if (location.searchParams.has('oauth_query')) return location.searchParams.get('oauth_query')!;
  if (location.pathname === '/consent' || location.searchParams.has('sig')) return location.search.slice(1); }
async function followConsent(c: LocalOAuthClient, cookie: string, location: URL, scope: string) {
  const query = consentQuery(location); if (query === undefined) return location;
  const consent = await send(c, c.consentEndpoint ?? `${host(c)}/api/account/consent`, { method: 'POST', redirect: 'manual',
    headers: { cookie, origin: c.account, 'content-type': 'application/json' }, body: JSON.stringify({ oauth_query: query, accept: true, scope }) });
  const redirected = consent.headers.get('location'); if (redirected) return new URL(redirected, c.account);
  if (!consent.ok) throw new OAuthClientError('consent', consent.status, (await consent.text()).slice(0, 500));
  const decision = await consent.json() as { url?: string; redirect_uri?: string }, next = decision.url ?? decision.redirect_uri;
  if (!next) throw new Error('OAuth consent returned no callback');
  return new URL(next, c.account); }
/** Repeats the same PKCE request on HTTP 5xx, then once more when `recover` asks. */
export async function authorize(c: LocalOAuthClient, cookie: string, o: AuthorizeOptions = {}): Promise<Authorization> {
  const prepared = prepareAuthorization(c, o), attempts = o.attempts ?? 1, wait = o.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let recovered = false;
  for (;;) {
    let response!: Response;
    for (let attempt = 0; ; attempt++) {
      response = await send(c, prepared.url, { headers: { cookie }, redirect: 'manual' });
      if (response.status < 500 || attempt >= attempts - 1) break;
      await response.body?.cancel(); await wait(250 * (attempt + 1)); }
    if (!recovered && o.recover && await o.recover(response)) { recovered = true; continue; }
    const location = response.headers.get('location'); if (response.status !== 302 || !location) return { ok: false, response };
    const callback = await followConsent(c, cookie, new URL(location, c.account), prepared.scope), code = callback.searchParams.get('code');
    if (!code) throw new OAuthClientError('authorize', 302, `no code in ${callback.pathname}`);
    return { ok: true, code, verifier: prepared.verifier, scope: prepared.scope }; } }
async function readGrant(response: Response, operation: string, scope: string): Promise<OAuthGrant> {
  const text = await response.text(); if (!response.ok) throw new OAuthClientError(operation, response.status, text.slice(0, 500));
  const body = JSON.parse(text) as OAuthGrant; if (!body.access_token) throw new Error(`${operation}: no access token`);
  return { ...body, scope: typeof body.scope === 'string' ? body.scope : scope }; }
const fieldsOf = (c: LocalOAuthClient, fields: Record<string, string>) => ({ ...fields, client_id: c.clientId, ...(c.resource ? { resource: c.resource } : {}) });
export async function exchangeCode(c: LocalOAuthClient, pending: { code: string; verifier: string }, scope = c.scope) {
  return readGrant(await postToken(c, fieldsOf(c, { grant_type: 'authorization_code', code: pending.code, redirect_uri: c.redirectUri, code_verifier: pending.verifier })), 'token', scope); }
/** Refresh repeats `scope` and refuses a response whose scope set differs. */
export async function refreshGrant(c: LocalOAuthClient, refreshToken: string, scope = c.scope) {
  const grant = await readGrant(await postToken(c, fieldsOf(c, { grant_type: 'refresh_token', refresh_token: refreshToken, scope })), 'refresh', scope);
  if (scopeSet(grant.scope) !== scopeSet(scope)) throw new Error('Refresh changed the granted scopes'); return { ...grant, scope }; }
export class LocalOAuthSession {
  constructor(readonly client: LocalOAuthClient, private grant: OAuthGrant, private expiresAt: number) {}
  get accessToken() { return this.grant.access_token; } get refreshToken() { return this.grant.refresh_token; } get scope() { return this.grant.scope; }
  async current(now = Date.now()) {
    if (now < this.expiresAt) return this.grant.access_token; if (!this.grant.refresh_token) throw new Error('Expired token has no refresh token');
    const next = await refreshGrant(this.client, this.grant.refresh_token, this.grant.scope);
    this.grant = { ...next, scope: this.grant.scope }; this.expiresAt = next.expires_in === undefined ? Number.POSITIVE_INFINITY : now + next.expires_in * 1000;
    return this.grant.access_token; } }
export async function signIn(c: LocalOAuthClient, cookie: string, o: AuthorizeOptions & { now?: () => number } = {}) {
  const authorized = await authorize(c, cookie, o); if (!authorized.ok) throw new OAuthClientError('authorize', authorized.response.status, (await authorized.response.text()).slice(0, 500));
  const grant = await exchangeCode(c, authorized, authorized.scope), now = (o.now ?? Date.now)();
  return new LocalOAuthSession(c, grant, grant.expires_in === undefined ? Number.POSITIVE_INFINITY : now + grant.expires_in * 1000); }
