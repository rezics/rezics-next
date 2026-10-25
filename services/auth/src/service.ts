import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { publicCredential, verifyKeyAssertion } from './key-credentials.ts';
import { betterAuthOptions, credentialOwnerSchema } from './better-auth.ts';
import { createSigner } from './signing.ts';
import { issuerOrigin } from './issuer.ts';
import type {
  AccessAccount,
  AuthService,
  AuthServiceOptions,
  EffectAuthorization,
  EffectPurpose,
  InvalidationReceipt,
  SessionProof,
} from './index.ts';

class Denied extends Error {
  constructor(readonly status = 401) {
    super('Authentication denied');
  }
}
interface Binding {
  clientId: string;
  scopes: string[];
  method?: 'pwd' | 'private_key_jwt' | 'operator';
  subjectId?: string;
  epoch?: number;
  opening?: EffectAuthorization;
  authTime?: number;
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
  issuerOrigin(options.issuer);
  const audience = new URL(options.audience);
  if (audience.protocol !== 'https:') throw new Error('The API audience must be an HTTPS URL');
  if (!options.secret || options.secret.length < 32)
    throw new Error('Configure a persistent Better Auth secret of at least 32 characters');
  const signer = await createSigner(database, options.signing);
  const binding = new AsyncLocalStorage<Binding>();
  const recoveryBinding = new AsyncLocalStorage<{ accountId: string; epoch: number }>();
  const proofHash = (token: string) => createHash('sha256').update(token).digest('hex');

  async function activeActor(accountId: string): Promise<AccessAccount> {
    const account = await trustedAccess.readAccount(accountId);
    if (
      !account ||
      account.accountId !== accountId ||
      account.kind !== 'actor' ||
      account.state !== 'active' ||
      account.fenced === true ||
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
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      resetPasswordTokenExpiresIn: 300,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, token }) {
        const selected = recoveryBinding.getStore();
        if (!selected || selected.accountId !== user.id || !options.recoveryDelivery) throw new Denied();
        const expiresAt = new Date(Date.now() + 300000);
        try {
          await database.query(
            'INSERT INTO auth_recovery (proof_hash, account_id, authn_epoch, expires_at) VALUES ($1,$2,$3,$4)',
            [proofHash(token), user.id, selected.epoch, expiresAt],
          );
          await options.recoveryDelivery.deliver({ accountId: user.id, email: user.email, token, expiresAt });
        } catch (error) {
          await context.internalAdapter.deleteVerificationByIdentifier(`reset-password:${token}`);
          await database.query('DELETE FROM auth_recovery WHERE proof_hash=$1', [proofHash(token)]);
          throw error;
        }
      },
    },
    plugins: [
      credentialOwnerSchema,
      {
        id: 'trusted-establishment',
        endpoints: {
          establish: createAuthEndpoint('/trusted-establishment', { method: 'POST' }, async (ctx) => {
            const selected = binding.getStore();
            if (!selected?.subjectId) throw new APIError('UNAUTHORIZED');
            const user = await ctx.context.internalAdapter.findUserById(selected.subjectId);
            if (!user) throw new APIError('UNAUTHORIZED');
            const session = await ctx.context.internalAdapter.createSession(user.id);
            if (!session) throw new APIError('UNAUTHORIZED');
            try {
              if (selected.opening)
                await database.query(
                  'INSERT INTO auth_session_opening (session_id, subject_account_id, acting_human_id, operator_account_id, receipt_id) VALUES ($1,$2,$3,$4,$5)',
                  [
                    session.id,
                    user.id,
                    selected.opening.actingHumanId,
                    selected.opening.operatorAccountId,
                    selected.opening.receiptId,
                  ],
                );
              await setSessionCookie(ctx, { session, user });
              return ctx.json({ success: true });
            } catch (error) {
              await ctx.context.internalAdapter.deleteSession(session.token);
              throw error;
            }
          }),
        },
      },
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // Only a verified password, own-key assertion or consumed Access opening
            // can install this private context. Public request fields cannot install it.
            const selected = binding.getStore();
            if (!selected) throw new APIError('UNAUTHORIZED', { message: 'Trusted session establishment required' });
            try {
              const account = await activeActor(session.userId);
              await allowed(account.accountId, selected);
              if (
                (selected.subjectId && selected.subjectId !== session.userId) ||
                (selected.epoch !== undefined && selected.epoch !== account.authnEpoch)
              )
                throw new Denied();
              if (selected.opening) {
                if (!account.automated || Date.parse(selected.opening.expiresAt) <= Date.now()) throw new Denied();
                const human = await activeActor(selected.opening.actingHumanId);
                if (human.automated || human.authnEpoch > selected.opening.humanEpoch) throw new Denied();
              }
              return {
                data: {
                  ...session,
                  clientId: selected.clientId,
                  grantedScope: selected.scopes.join(' '),
                  authnEpoch: account.authnEpoch,
                  authTime: selected.authTime ?? Math.floor(Date.now() / 1000),
                  authMethods: selected.method ?? 'pwd',
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
    // Never replace a session epoch with the current floor. Only verified establishment installs it.
    if (
      !Number.isSafeInteger(session.authnEpoch) ||
      session.authnEpoch < account.authnEpoch ||
      !Number.isSafeInteger(session.authTime) ||
      session.authTime > Math.floor(Date.now() / 1000) ||
      !['pwd', 'private_key_jwt', 'operator'].includes(session.authMethods)
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

  async function owner(accountId: string): Promise<void> {
    // Advisory locking makes concurrent first establishment use one native owner.
    const connection = await database.connect();
    try {
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`auth-owner:${accountId}`]);
      if (await context.internalAdapter.findUserById(accountId)) return;
      await context.adapter.transaction(async (transaction) => {
        const now = new Date();
        await transaction.create({
          model: 'user',
          forceAllowId: true,
          data: {
            id: accountId,
            name: '',
            email: null,
            emailVerified: false,
            image: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        await transaction.create({
          model: 'account',
          data: {
            userId: accountId,
            accountId,
            providerId: 'credential',
            password: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      });
    } finally {
      await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`auth-owner:${accountId}`]);
      connection.release();
    }
  }
  async function humanProof(headers: Headers): Promise<SessionProof> {
    const human = await sessionProof(headers);
    if ((await activeActor(human.account_id)).automated) throw new Denied();
    return human;
  }
  function invalidation(receipt: InvalidationReceipt, accountId: string, previousEpoch: number): void {
    if (
      !receipt?.receiptId ||
      receipt.accountId !== accountId ||
      !Number.isSafeInteger(receipt.minimumAuthnEpoch) ||
      receipt.minimumAuthnEpoch <= previousEpoch
    )
      throw new Denied();
  }
  async function consume(
    input: { authorization: string; subjectAccountId: string; headers: Headers },
    purpose: EffectPurpose,
  ) {
    if (!trustedAccess.consumeAuthorization) throw new Denied();
    const human = await humanProof(input.headers);
    const before = await activeActor(input.subjectAccountId);
    const previousEpoch = before.authnEpoch;
    const receipt = await trustedAccess.consumeAuthorization({
      authorization: text(input.authorization),
      subjectAccountId: input.subjectAccountId,
      purpose,
      human,
    });
    if (
      !receipt?.receiptId ||
      receipt.subjectAccountId !== input.subjectAccountId ||
      receipt.purpose !== purpose ||
      receipt.actingHumanId !== human.account_id ||
      receipt.humanEpoch !== human.authn_epoch ||
      receipt.clientId !== human.client_id ||
      JSON.stringify(scopes(receipt.scopes)) !== JSON.stringify(human.scope) ||
      !Number.isFinite(Date.parse(receipt.expiresAt)) ||
      Date.parse(receipt.expiresAt) <= Date.now() ||
      (before.automated
        ? !receipt.operatorAccountId
        : receipt.operatorAccountId !== null || human.account_id !== before.accountId)
    )
      throw new Denied();
    const subject = await activeActor(input.subjectAccountId);
    // Access may have raised the floor as part of a destructive credential command.
    if (receipt.subjectEpoch !== subject.authnEpoch) throw new Denied();
    if (purpose !== 'session') {
      const currentHuman = await activeActor(human.account_id);
      if (currentHuman.authnEpoch > human.authn_epoch && human.account_id !== subject.accountId) throw new Denied();
    } else await humanProof(input.headers);
    await database.query(
      'INSERT INTO auth_effect_receipt (receipt_id, account_id, purpose, minimum_authn_epoch) VALUES ($1,$2,$3,$4)',
      [receipt.receiptId, subject.accountId, purpose, subject.authnEpoch],
    );
    return { receipt, subject, previousEpoch, human };
  }
  async function established(response: Response): Promise<Response> {
    if (!response.ok) throw new Denied();
    const setCookies = response.headers.getSetCookie();
    const headers = new Headers({ cookie: setCookies.map((cookie) => cookie.split(';')[0]).join('; ') });
    try {
      return json(await sessionProof(headers), 200, setCookies);
    } catch (error) {
      const created = await auth.api.getSession({ headers });
      if (created) await context.internalAdapter.deleteSession(created.session.token);
      throw error;
    }
  }
  async function establish(selected: Binding, headers: Headers): Promise<Response> {
    return established(
      await binding.run(selected, () =>
        auth.handler(
          new Request(`${options.issuer}/api/auth/trusted-establishment`, {
            method: 'POST',
            headers: {
              origin: options.issuer,
              'content-type': 'application/json',
              'user-agent': headers.get('user-agent') ?? '',
            },
            body: '{}',
          }),
        ),
      ),
    );
  }
  async function recoveryAccount(accountId: string): Promise<AccessAccount> {
    if (!trustedAccess.readRecoveryAccount || !trustedAccess.authorizeRecovery || !options.recoveryDelivery)
      throw new Denied();
    const account = await trustedAccess.readRecoveryAccount(accountId);
    if (
      !account ||
      account.accountId !== accountId ||
      account.kind !== 'actor' ||
      account.automated ||
      account.state !== 'active' ||
      !Number.isSafeInteger(account.authnEpoch) ||
      account.authnEpoch < 0
    )
      throw new Denied();
    return account;
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
        if (input.idempotencyKey !== undefined) {
          text(input.idempotencyKey);
          const digest = createHmac('sha256', options.secret)
            .update(
              JSON.stringify(['auth-provisioning-v1', account.accountId, input.email.toLowerCase(), input.password]),
            )
            .digest();
          const connection = await database.connect();
          try {
            await connection.query('BEGIN');
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
              `auth-provision:${input.idempotencyKey}`,
            ]);
            const previous = (
              await connection.query<{ account_id: string; digest: Buffer }>(
                'SELECT account_id, digest FROM auth_provisioning_receipt WHERE idempotency_key=$1',
                [input.idempotencyKey],
              )
            ).rows[0];
            if (previous) {
              if (previous.account_id !== account.accountId || !previous.digest.equals(digest)) throw new Denied();
            } else {
              // Same Better Auth owner model and official password hash. These
              // writes and their retry receipt commit in one Auth transaction.
              await connection.query(
                'INSERT INTO "user" (id,name,email,"emailVerified",image) VALUES ($1,\'\',$2,false,NULL)',
                [account.accountId, input.email.toLowerCase()],
              );
              await connection.query(
                'INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt") VALUES ($1,$2,\'credential\',$2,$3,CURRENT_TIMESTAMP)',
                [randomUUID(), account.accountId, hash],
              );
              await connection.query('INSERT INTO auth_provisioning_receipt VALUES ($1,$2,$3)', [
                input.idempotencyKey,
                account.accountId,
                digest,
              ]);
            }
            await connection.query('COMMIT');
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            connection.release();
          }
          return { accountId: account.accountId };
        }
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
      async openAutomatedSession(input) {
        const subject = await activeActor(input.subjectAccountId);
        if (!subject.automated) throw new Denied();
        const { receipt, subject: current, human } = await consume(input, 'session');
        await owner(current.accountId);
        const selected: Binding = {
          clientId: receipt.clientId,
          scopes: scopes(receipt.scopes),
          method: 'operator',
          subjectId: current.accountId,
          epoch: current.authnEpoch,
          opening: receipt,
          authTime: human.auth_time,
        };
        return establish(selected, input.headers);
      },
      async provisionCredentialless(input) {
        const approval = await trustedAccess.authorizeProvisioning(input.authorization);
        const account = await trustedAccess.readAccount(approval.accountId);
        if (!account || account.kind !== 'actor' || account.state !== 'pending' || !account.automated || account.fenced)
          throw new Denied();
        await owner(account.accountId);
        return { accountId: account.accountId };
      },
      async eraseAccount(accountId) {
        const account = await trustedAccess.readAccount(accountId);
        if (!account || account.state !== 'deleted' || !account.fenced) throw new Denied();
        await database.query('DELETE FROM "user" WHERE id=$1', [accountId]);
      },
      async setCredential(input) {
        const value = input.credential;
        const purpose =
          value.kind === 'password'
            ? value.password === null
              ? 'remove-password'
              : 'set-password'
            : value.remove
              ? 'remove-key'
              : 'add-key';
        // Validate material before spending Access authorization or changing its floor.
        let hash: string | null = null;
        let publicJwk;
        if (value.kind === 'password' && value.password !== null) {
          if (
            value.password.length < context.password.config.minPasswordLength ||
            value.password.length > context.password.config.maxPasswordLength
          )
            throw new Denied(400);
          hash = await context.password.hash(value.password);
        } else if (value.kind === 'key') {
          text(value.kid);
          if (!value.remove) publicJwk = await publicCredential(value.publicJwk, value.kid);
        }
        const { receipt, subject, previousEpoch } = await consume(input, purpose);
        const oldPassword = await context.internalAdapter.findCredentialAccount(subject.accountId);
        const destructive =
          purpose === 'remove-password' ||
          purpose === 'remove-key' ||
          (purpose === 'set-password' && !!oldPassword?.password);
        if (destructive) {
          if (!receipt.invalidation) throw new Denied();
          invalidation(receipt.invalidation, subject.accountId, previousEpoch);
        }
        await owner(subject.accountId);
        if (value.kind === 'password') {
          if (hash !== null) await context.internalAdapter.updatePassword(subject.accountId, hash);
          else
            await context.adapter.update({
              model: 'account',
              where: [
                { field: 'userId', value: subject.accountId },
                { field: 'providerId', value: 'credential' },
              ],
              update: { password: null },
            });
        } else if (value.remove)
          await database.query('DELETE FROM auth_public_key WHERE account_id=$1 AND kid=$2', [
            subject.accountId,
            value.kid,
          ]);
        else
          await database.query('INSERT INTO auth_public_key (account_id, kid, public_jwk) VALUES ($1,$2,$3)', [
            subject.accountId,
            value.kid,
            publicJwk,
          ]);
        if (destructive || receipt.invalidation) await context.internalAdapter.deleteUserSessions(subject.accountId);
      },
      async revokeSessions(accountId) {
        await context.internalAdapter.deleteUserSessions(accountId);
      },
      async registerClient(input) {
        const id = text(input.clientId);
        if (typeof input.firstParty !== 'boolean') throw new Denied(400);
        const granted = scopes(input.scopes);
        const connection = await database.connect();
        try {
          await connection.query('BEGIN');
          await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`auth-client:${id}`]);
          const previous = (
            await connection.query<Client>('SELECT * FROM auth_client WHERE client_id=$1 FOR UPDATE', [id])
          ).rows[0];
          // Shrink requires a durable multi-account coordinator. Refuse it at this boundary.
          if (
            previous &&
            (previous.scopes.some((scope) => !granted.includes(scope)) || (previous.first_party && !input.firstParty))
          )
            throw new Denied();
          await connection.query(
            'INSERT INTO auth_client (client_id, first_party, scopes) VALUES ($1,$2,$3) ON CONFLICT (client_id) DO UPDATE SET first_party=EXCLUDED.first_party, scopes=EXCLUDED.scopes',
            [id, input.firstParty, granted],
          );
          await connection.query('COMMIT');
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
      },
    },
    async handler(request) {
      try {
        const url = new URL(request.url);
        if (url.origin !== options.issuer || url.search) throw new Denied(400);
        if (url.pathname === '/.well-known/jwks.json' && request.method === 'GET') return json(signer.jwks);
        if (url.pathname === '/session' && request.method === 'GET') return json(await sessionProof(request.headers));
        if (
          ![
            '/signin',
            '/signin/key',
            '/recovery/start',
            '/recovery/complete',
            '/token',
            '/consent',
            '/signout',
          ].includes(url.pathname) ||
          request.method !== 'POST'
        )
          throw new Denied(404);
        // All mutations require the configured origin, including first-login CSRF protection.
        if (request.headers.get('origin') !== options.issuer || request.headers.get('sec-fetch-site') === 'cross-site')
          throw new Denied(403);
        const body = await bodyOf(request);
        if (url.pathname === '/recovery/start') {
          fields(body, ['account_id']);
          const account = await recoveryAccount(text(body.account_id));
          const user = await context.internalAdapter.findUserById(account.accountId);
          if (!user?.email) throw new Denied();
          await recoveryBinding.run({ accountId: account.accountId, epoch: account.authnEpoch }, () =>
            auth.api.requestPasswordReset({ body: { email: user.email } }),
          );
          return json({ success: true });
        }
        if (url.pathname === '/recovery/complete') {
          fields(body, ['account_id', 'token', 'new_password']);
          const accountId = text(body.account_id);
          const token = text(body.token);
          const newPassword = text(body.new_password);
          if (
            newPassword.length < context.password.config.minPasswordLength ||
            newPassword.length > context.password.config.maxPasswordLength
          )
            throw new Denied(400);
          const account = await recoveryAccount(accountId);
          const result = await database.query<{ authn_epoch: number }>(
            'DELETE FROM auth_recovery WHERE proof_hash=$1 AND account_id=$2 AND expires_at>CURRENT_TIMESTAMP RETURNING authn_epoch',
            [proofHash(token), accountId],
          );
          const proof = result.rows[0];
          if (!proof || proof.authn_epoch !== account.authnEpoch) throw new Denied();
          const receipt = await trustedAccess.authorizeRecovery!({ accountId, proofEpoch: proof.authn_epoch });
          invalidation(receipt, accountId, proof.authn_epoch);
          if ((await recoveryAccount(accountId)).authnEpoch !== receipt.minimumAuthnEpoch) throw new Denied();
          await database.query(
            'INSERT INTO auth_effect_receipt (receipt_id, account_id, purpose, minimum_authn_epoch) VALUES ($1,$2,$3,$4)',
            [receipt.receiptId, accountId, 'recovery', receipt.minimumAuthnEpoch],
          );
          await auth.api.resetPassword({ body: { token, newPassword } });
          return json({ success: true });
        }
        if (url.pathname === '/signin/key') {
          fields(body, ['account_id', 'assertion', 'client_id', 'scope']);
          const account = await activeActor(text(body.account_id));
          const selected: Binding = {
            clientId: text(body.client_id),
            scopes: scopes(body.scope),
            method: 'private_key_jwt',
            subjectId: account.accountId,
            epoch: account.authnEpoch,
          };
          await allowed(account.accountId, selected);
          // Assertions can approach the HTTP body bound without the generic short-text bound.
          if (typeof body.assertion !== 'string' || !body.assertion || body.assertion.length > 15000)
            throw new Denied(400);
          try {
            await verifyKeyAssertion(database, account.accountId, body.assertion, `${options.issuer}/token`);
          } catch {
            throw new Denied();
          }
          return establish(selected, request.headers);
        }
        if (url.pathname === '/signin') {
          fields(body, ['email', 'account_id', 'password', 'client_id', 'scope']);
          if (body.account_id !== undefined) {
            if (body.email !== undefined) throw new Denied(400);
            const account = await activeActor(text(body.account_id));
            const password = text(body.password);
            if (password.length > context.password.config.maxPasswordLength) throw new Denied(400);
            const credential = await context.internalAdapter.findCredentialAccount(account.accountId);
            if (!credential?.password || !(await context.password.verify({ hash: credential.password, password })))
              throw new Denied();
            return establish(
              {
                clientId: text(body.client_id),
                scopes: scopes(body.scope),
                method: 'pwd',
                subjectId: account.accountId,
                epoch: account.authnEpoch,
              },
              request.headers,
            );
          }
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
          const connection = await database.connect();
          let reducing = false;
          try {
            await connection.query('BEGIN');
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
              `auth-consent:${proof.account_id}:${client.client_id}`,
            ]);
            const previous = (
              await connection.query<{ scopes: string[] }>(
                'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2 FOR UPDATE',
                [proof.account_id, client.client_id],
              )
            ).rows[0];
            reducing = !!previous?.scopes.some((scope) => !granted.includes(scope));
            if (reducing) {
              if (!trustedAccess.invalidateAccount) throw new Denied();
              const current = await activeActor(proof.account_id);
              if (proof.authn_epoch < current.authnEpoch) throw new Denied();
              const previousEpoch = current.authnEpoch;
              const receipt = await trustedAccess.invalidateAccount({
                accountId: proof.account_id,
                previousEpoch,
                reason: 'consent-reduction',
              });
              invalidation(receipt, proof.account_id, previousEpoch);
              await connection.query(
                'INSERT INTO auth_effect_receipt (receipt_id, account_id, purpose, minimum_authn_epoch) VALUES ($1,$2,$3,$4)',
                [receipt.receiptId, proof.account_id, 'consent-reduction', receipt.minimumAuthnEpoch],
              );
            }
            await connection.query(
              'INSERT INTO auth_consent (account_id, client_id, scopes) VALUES ($1,$2,$3) ON CONFLICT (account_id, client_id) DO UPDATE SET scopes=EXCLUDED.scopes',
              [proof.account_id, client.client_id, granted],
            );
            await connection.query('COMMIT');
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            connection.release();
          }
          if (reducing) await context.internalAdapter.deleteUserSessions(proof.account_id);
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
