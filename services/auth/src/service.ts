import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { betterAuthOptions } from './better-auth.ts';
import { createSigner } from './signing.ts';
import type { AccessAccount, AuthService, AuthServiceOptions, SessionProof } from './index.ts';

class Denied extends Error {
  constructor(readonly status = 401) {
    super('Authentication denied');
  }
}
interface Binding {
  clientId: string;
  scopes: string[];
}
interface Client {
  client_id: string;
  first_party: boolean;
  scopes: string[];
}
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
function scopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((v) => typeof v !== 'string' || v.length > 128 || !scopePattern.test(v))
  )
    throw new Denied(400);
  return [...new Set(value as string[])].sort();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Denied(400);
  return value;
}
function fields(body: Record<string, unknown>, names: string[]): void {
  if (Object.keys(body).some((key) => !names.includes(key))) throw new Denied(400);
}
function json(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new Denied(415);
  if (Number(request.headers.get('content-length') ?? 0) > 16384) throw new Denied(413);
  // Bound the streamed body too; Content-Length is not evidence of its size.
  const reader = request.body?.getReader();
  if (!reader) throw new Denied(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Denied(413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Denied(400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Denied(400);
  return parsed as Record<string, unknown>;
}

export async function buildAuthService(options: AuthServiceOptions): Promise<AuthService> {
  const { database, trustedAccess } = options;
  const issuer = new URL(options.issuer);
  if (issuer.origin !== options.issuer || issuer.protocol !== 'https:')
    throw new Error('Issuer must be an HTTPS origin');
  const audience = new URL(options.audience);
  if (audience.protocol !== 'https:') throw new Error('The API audience must be an HTTPS URL');
  if (!options.secret || options.secret.length < 32)
    throw new Error('Configure a persistent Better Auth secret of at least 32 characters');
  const signer = await createSigner(database, options.signing);
  const binding = new AsyncLocalStorage<Binding>();

  async function activeActor(accountId: string): Promise<AccessAccount> {
    const account = await trustedAccess.readAccount(accountId);
    if (
      !account ||
      account.accountId !== accountId ||
      account.kind !== 'actor' ||
      account.state !== 'active' ||
      !Number.isSafeInteger(account.authnEpoch) ||
      account.authnEpoch < 0
    )
      throw new Denied();
    return account;
  }
  async function clientFor(clientId: string): Promise<Client> {
    const result = await database.query<Client>(
      'SELECT client_id, first_party, scopes FROM auth_client WHERE client_id=$1',
      [clientId],
    );
    if (!result.rows[0]) throw new Denied();
    return result.rows[0];
  }
  async function allowed(accountId: string, selected: Binding): Promise<void> {
    const client = await clientFor(selected.clientId);
    if (selected.scopes.some((scope) => !client.scopes.includes(scope))) throw new Denied();
    if (!client.first_party) {
      const result = await database.query<{ scopes: string[] }>(
        'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
        [accountId, selected.clientId],
      );
      const consent = result.rows[0];
      if (!consent || selected.scopes.some((scope) => !consent.scopes.includes(scope))) throw new Denied();
    }
  }
  const auth = betterAuth({
    ...betterAuthOptions(database, options.issuer, options.secret),
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // This hook runs after Better Auth has verified the owner's password.
            // The request context carries only a client selection, never identity evidence.
            const selected = binding.getStore();
            if (!selected) throw new APIError('UNAUTHORIZED', { message: 'Trusted session establishment required' });
            try {
              const account = await activeActor(session.userId);
              await allowed(account.accountId, selected);
              return {
                data: {
                  ...session,
                  clientId: selected.clientId,
                  grantedScope: selected.scopes.join(' '),
                  authnEpoch: account.authnEpoch,
                  authTime: Math.floor(Date.now() / 1000),
                  authMethods: 'pwd',
                },
              };
            } catch {
              throw new APIError('UNAUTHORIZED', { message: 'Authentication denied' });
            }
          },
        },
      },
    },
  });
  const context = await auth.$context;

  async function sessionProof(headers: Headers): Promise<SessionProof> {
    const result = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!result) throw new Denied();
    const session = result.session;
    const account = await activeActor(session.userId);
    // Never replace a session epoch with the current floor. Only password verification installs it.
    if (
      !Number.isSafeInteger(session.authnEpoch) ||
      session.authnEpoch < account.authnEpoch ||
      !Number.isSafeInteger(session.authTime) ||
      session.authTime > Math.floor(Date.now() / 1000) ||
      session.authMethods !== 'pwd'
    )
      throw new Denied();
    const granted = session.grantedScope ? scopes(session.grantedScope.split(' ')) : [];
    await allowed(account.accountId, { clientId: session.clientId, scopes: granted });
    return {
      account_id: account.accountId,
      client_id: session.clientId,
      scope: granted,
      authn_epoch: session.authnEpoch,
      auth_time: session.authTime,
      amr: session.authMethods.split(' '),
    };
  }

  return {
    verifier: {
      issuer: options.issuer,
      audience: options.audience,
      jwksUrl: `${options.issuer}/.well-known/jwks.json`,
      algorithms: ['ES256'],
      accessTokenLifetimeSeconds: 300,
    },
    internal: {
      async provisionPassword(input) {
        // Authorization resolves an approved Access command; HTTP cannot supply this result.
        const approval = await trustedAccess.authorizeProvisioning(input.authorization);
        const account = await trustedAccess.readAccount(approval.accountId);
        if (
          !account ||
          account.accountId !== approval.accountId ||
          account.kind !== 'actor' ||
          account.state !== 'pending'
        )
          throw new Denied();
        if (
          typeof input.email !== 'string' ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
          input.email.length > 254 ||
          typeof input.password !== 'string' ||
          input.password.length < context.password.config.minPasswordLength ||
          input.password.length > context.password.config.maxPasswordLength
        )
          throw new Denied(400);
        const hash = await context.password.hash(input.password);
        // Use the official PostgreSQL adapter and its explicit external-ID facility.
        await context.adapter.transaction(async (transaction) => {
          const now = new Date();
          await transaction.create({
            model: 'user',
            forceAllowId: true,
            data: {
              id: account.accountId,
              name: '',
              email: input.email.toLowerCase(),
              emailVerified: false,
              image: null,
              createdAt: now,
              updatedAt: now,
            },
          });
          await transaction.create({
            model: 'account',
            data: {
              userId: account.accountId,
              accountId: account.accountId,
              providerId: 'credential',
              password: hash,
              createdAt: now,
              updatedAt: now,
            },
          });
        });
        return { accountId: account.accountId };
      },
      async revokeSessions(accountId) {
        await context.internalAdapter.deleteUserSessions(accountId);
      },
      async registerClient(input) {
        const id = text(input.clientId);
        if (typeof input.firstParty !== 'boolean') throw new Denied(400);
        const granted = scopes(input.scopes);
        await database.query(
          'INSERT INTO auth_client (client_id, first_party, scopes) VALUES ($1,$2,$3) ON CONFLICT (client_id) DO UPDATE SET first_party=EXCLUDED.first_party, scopes=EXCLUDED.scopes',
          [id, input.firstParty, granted],
        );
      },
    },
    async handler(request) {
      try {
        const url = new URL(request.url);
        if (url.origin !== options.issuer || url.search) throw new Denied(400);
        if (url.pathname === '/.well-known/jwks.json' && request.method === 'GET') return json(signer.jwks);
        if (url.pathname === '/session' && request.method === 'GET') return json(await sessionProof(request.headers));
        if (!['/signin', '/token', '/consent', '/signout'].includes(url.pathname) || request.method !== 'POST')
          throw new Denied(404);
        // All mutations require the configured origin, including first-login CSRF protection.
        if (request.headers.get('origin') !== options.issuer || request.headers.get('sec-fetch-site') === 'cross-site')
          throw new Denied(403);
        const body = await bodyOf(request);
        if (url.pathname === '/signin') {
          fields(body, ['email', 'password', 'client_id', 'scope']);
          const selected = { clientId: text(body.client_id), scopes: scopes(body.scope) };
          await clientFor(selected.clientId);
          const response = await binding.run(selected, () =>
            auth.handler(
              new Request(`${options.issuer}/api/auth/sign-in/email`, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify({ email: text(body.email), password: text(body.password) }),
              }),
            ),
          );
          if (!response.ok)
            return json({ error: 'authentication_denied' }, response.status >= 400 ? response.status : 401);
          const setCookies = response.headers.getSetCookie();
          const headers = new Headers({ cookie: setCookies.map((cookie) => cookie.split(';')[0]).join('; ') });
          try {
            const proof = await sessionProof(headers);
            return json(proof, 200, setCookies);
          } catch (error) {
            // A state/consent change during establishment must not release its cookie.
            const created = await auth.api.getSession({ headers });
            if (created) await context.internalAdapter.deleteSession(created.session.token);
            throw error;
          }
        }
        if (url.pathname === '/token') {
          fields(body, []);
          const proof = await sessionProof(request.headers);
          const now = Math.floor(Date.now() / 1000);
          const accessToken = await signer.sign({
            iss: options.issuer,
            aud: options.audience,
            sub: proof.account_id,
            client_id: proof.client_id,
            scope: proof.scope.join(' '),
            authn_epoch: proof.authn_epoch,
            iat: now,
            exp: now + 300,
            auth_time: proof.auth_time,
            amr: proof.amr,
          });
          return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 300 });
        }
        if (url.pathname === '/consent') {
          fields(body, ['client_id', 'scope']);
          const proof = await sessionProof(request.headers);
          const client = await clientFor(text(body.client_id));
          const granted = scopes(body.scope);
          if (client.first_party || granted.some((scope) => !client.scopes.includes(scope))) throw new Denied(400);
          await database.query(
            'INSERT INTO auth_consent (account_id, client_id, scopes) VALUES ($1,$2,$3) ON CONFLICT (account_id, client_id) DO UPDATE SET scopes=EXCLUDED.scopes',
            [proof.account_id, client.client_id, granted],
          );
          return json({ client_id: client.client_id, scope: granted });
        }
        fields(body, []);
        // Better Auth owns cookie clearing and deletion of its own persistent session.
        const response = await auth.handler(
          new Request(`${options.issuer}/api/auth/sign-out`, { method: 'POST', headers: request.headers, body: '{}' }),
        );
        return json({ success: response.ok }, response.status, response.headers.getSetCookie());
      } catch (error) {
        return json({ error: 'authentication_denied' }, error instanceof Denied ? error.status : 503);
      }
    },
  };
}
