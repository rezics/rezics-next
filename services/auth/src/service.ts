import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { websiteProvider } from './website-provider.ts';
import { WEBSITE_CLIENT_ID, websiteRoutes } from './website.ts';
import { pruneExpiredProtocolState } from './protocol-maintenance.ts';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { serializeCookie } from 'better-call';
import { InvalidKeyAssertion, verifyKeyAssertion } from './key-credentials.ts';
import { passkeyPlugin, passkeyCeremonies, registrationInput, type PasskeyAssertion } from './passkeys.ts';
import { credentialEffects } from './credential-effects.ts';
import { betterAuthOptions, credentialOwnerSchema } from './better-auth.ts';
import { createSigner } from './signing.ts';
import { signSessionAccessToken } from './session-proof-capability.ts';
import { issuerOrigin } from './issuer.ts';
import { nativeAttemptRequest } from './rate-limit.ts';
import { nativeSessionLimits, pruneExpiredSessions, trimSessionHistory, sessionUpgradePage } from './session-limits.ts';
import { nativeVerificationPlugin, pruneExpiredVerifications } from './verification-maintenance.ts';
import { startNativeErasure, nativeErasurePage, redriveNativeErasure } from './erasure-native.ts';
import { chargeAccountAttempt } from './rate-limit.ts';
import { eraseDueConsents, hasDueConsentErasure } from './consent-erasure.ts';
import { clientAuthority } from './account-workflows.ts';
import { createBarrierProofVerifier, type BarrierProof } from './barrier-proofs.ts';
import { createRecoveryEstablishmentVerifier } from './recovery-establishment.ts';
import { recoveryDelivery } from './recovery-delivery.ts';
import { withCredentialRequestDeadline } from '@rezics/auth-contract';
import type { PoolClient } from 'pg';
import {
  createProvisioningEvidenceVerifier,
  validProvisioningReceipt,
  type ProvisioningReceiptMetadata,
  type ProvisioningResult,
} from './provisioning-evidence.ts';
import type {
  AccessAccount,
  AuthService,
  AuthServiceOptions,
  CredentialFloorPurpose,
  CredentialEffectAuthorization,
  EffectAuthorization,
  CredentialFloorReceipt,
  InvalidationReceipt,
  SessionAuthorizationInput,
  SessionProof,
} from './index.ts';

export { WEBSITE_CLIENT_ID } from './website.ts';

class StepUpRequired extends Error {
  readonly status = 401;
  readonly code = 'step_up_required';
}

class Denied extends Error {
  constructor(readonly status = 401) {
    super('Authentication denied');
  }
}
class AccountSuspended extends Denied {
  constructor(readonly account: AccessAccount) {
    super();
  }
}
class SuspendedSignIn extends APIError {
  constructor() {
    super('FORBIDDEN', { code: 'ACCOUNT_SUSPENDED', message: 'Account suspended' });
  }
}
interface Binding {
  clientId: string;
  scopes: string[];
  method?: 'pwd' | 'pop' | 'private_key_jwt' | 'operator';
  subjectId?: string;
  epoch?: number;
  opening?: EffectAuthorization;
  authTime?: number;
  refusal?: SuspendedSignIn;
}
interface Client {
  client_id: string;
  display_name: string | null;
  first_party: boolean;
  scopes: string[];
}
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const assignmentUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const assignmentReference = new RegExp(`^urn:rezics:request:(${assignmentUuid}):(${assignmentUuid})$`);
function normalizeScopes(value: unknown, limit: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some((v) => typeof v !== 'string' || v.length > 128 || !scopePattern.test(v))
  )
    throw new Denied(400);
  return [...new Set(value as string[])].sort();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Denied(400);
  return value;
}
const recoveryEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function recoveryAddress(body: Record<string, unknown>) {
  fields(body, ['email']);
  const email = text(body.email).toLowerCase();
  if (email.length > 254 || !recoveryEmail.test(email)) throw new Denied(400);
  return email;
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
  const { trustedAccess } = options;
  const scopeLimit = options.siteActions
    ? new Set(['openid', 'offline_access', 'media:complete', ...options.siteActions.keys()]).size
    : 1000;
  const scopes = (value: unknown) => normalizeScopes(value, scopeLimit);
  const authority = clientAuthority(
    options.database,
    trustedAccess,
    () => {
      throw new Denied();
    },
    scopes,
  );
  const { database, withIssuance, withConsent, materialize } = authority;
  issuerOrigin(options.issuer);
  const audience = new URL(options.audience);
  if (audience.protocol !== 'https:') throw new Error('The API audience must be an HTTPS URL');
  if (!options.secret || options.secret.length < 32)
    throw new Error('Configure a persistent Better Auth secret of at least 32 characters');
  const signer = await createSigner(database, options.signing);
  // Object identity, source and scope belong to this instance. No caller can
  // install a brand, and inherited async contexts lose authority on callback exit.
  const proofSources = new WeakMap<SessionProof, { id: string; expiresAt: number }>();
  const proofScope = new AsyncLocalStorage<{ proof: SessionProof; live: boolean }>();
  const binding = new AsyncLocalStorage<Binding>();
  const recoveryBinding = recoveryDelivery(database, options.recoveryDelivery, options.issuer);
  // Native router admission runs before this private alias dispatch hook. A
  // request cannot install it through a header, body or native endpoint name.
  const attemptDispatch = new AsyncLocalStorage<() => Promise<Response>>();
  const proofHash = (token: string) => createHash('sha256').update(token).digest('hex');

  const credentials = credentialEffects(database, options.secret);
  const barrierProofs = createBarrierProofVerifier({ database });
  const recoveryEstablishment = createRecoveryEstablishmentVerifier({ database });
  const digestOf = (value: unknown) => proofHash(JSON.stringify(value));
  // This private writer is reachable only after native session/consent validation
  // or exact native recovery consumption. No HTTP evidence can call it directly.
  async function publishBarrier(
    connection: PoolClient,
    purpose: BarrierProof['purpose'],
    accountId: string,
    previousEpoch: number,
    operationKey: string,
    evidence: unknown[],
    sourceExpiry: Date,
    existingOnly = false,
  ) {
    const digest = digestOf(evidence);
    const reference = digestOf(['auth-barrier-reference-v1', operationKey, digest]);
    if (!existingOnly)
      await connection.query(
        `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,LEAST($8,statement_timestamp()+interval '5 minutes'))
         ON CONFLICT (account_id,purpose,operation_key) DO NOTHING`,
        [reference, accountId, purpose, previousEpoch, operationKey, digest, JSON.stringify(evidence), sourceExpiry],
      );
    const row = (
      await connection.query(
        `SELECT reference FROM auth_barrier_proof WHERE account_id=$1 AND purpose=$2 AND operation_key=$3
       AND previous_epoch=$4 AND digest=$5 AND reference=$6 AND applied_at IS NULL AND expires_at>statement_timestamp()`,
        [accountId, purpose, operationKey, previousEpoch, digest, reference],
      )
    ).rows[0];
    if (!row) throw new Denied();
    return { reference, accountId, purpose, previousEpoch, operationKey };
  }
  async function applyBarrier(
    connection: PoolClient,
    reference: string,
    receipt: InvalidationReceipt,
    purpose: BarrierProof['purpose'],
  ) {
    if (
      !(
        await connection.query(
          `UPDATE auth_barrier_proof SET applied_at=statement_timestamp() WHERE reference=$1
       AND applied_at IS NULL AND expires_at>statement_timestamp() RETURNING reference`,
          [reference],
        )
      ).rowCount
    )
      throw new Denied();
    await connection.query(
      'INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch) VALUES ($1,$2,$3,$4)',
      [receipt.receiptId, receipt.accountId, purpose, receipt.minimumAuthnEpoch],
    );
  }

  // A barrier fences its account, so only the steps that finish a committed barrier may read it fenced.
  async function activeActor(accountId: string, barrier = false, signIn = false): Promise<AccessAccount> {
    const account =
      (await trustedAccess.readAccount(accountId, signIn ? 'signin' : undefined)) ??
      (barrier ? await trustedAccess.readFencedAccount(accountId) : null);
    if (
      !account ||
      account.accountId !== accountId ||
      account.kind !== 'actor' ||
      !Number.isSafeInteger(account.authnEpoch) ||
      account.authnEpoch < 0
    )
      throw new Denied();
    if (account.state === 'suspended') throw new AccountSuspended(account);
    if (account.state !== 'active' || (account.fenced === true && !barrier)) throw new Denied();
    return account;
  }
  // A suspended human may still prove a credential, but only the session hook can disclose the refusal.
  async function credentialActor(accountId: string): Promise<AccessAccount> {
    try {
      return await activeActor(accountId, false, true);
    } catch (error) {
      if (error instanceof AccountSuspended && !error.account.automated) return error.account;
      throw error;
    }
  }
  async function sessionBinding<T>(selected: Binding, callback: () => Promise<T>): Promise<T> {
    const context = { ...selected };
    // Better Auth serializes APIError into its response; retain the typed refusal for our public aliases.
    const result = await binding.run(context, callback);
    if (context.refusal) throw context.refusal;
    return result;
  }
  async function provisioningAccount(
    accountId: string,
    commandReference: string,
  ): Promise<AccessAccount & { registrationId?: string; expiresAt?: string }> {
    const reader = trustedAccess.readProvisioningAccount;
    // Only isolated trusted-port fixtures may omit the dedicated production reader.
    const account: (AccessAccount & { registrationId?: string; expiresAt?: string }) | null = reader
      ? await reader.call(trustedAccess, accountId, commandReference)
      : await trustedAccess.readAccount(accountId);
    if (
      !account ||
      account.accountId !== accountId ||
      account.kind !== 'actor' ||
      account.state !== 'pending' ||
      account.fenced ||
      typeof account.automated !== 'boolean' ||
      !Number.isSafeInteger(account.authnEpoch) ||
      account.authnEpoch <= 0 ||
      ((reader || account.registrationId !== undefined) &&
        (typeof account.registrationId !== 'string' || account.registrationId.length === 0)) ||
      ((reader || account.expiresAt !== undefined) &&
        (typeof account.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(account.expiresAt)) ||
          Date.parse(account.expiresAt) <= Date.now()))
    )
      throw new Denied();
    return account;
  }
  async function clientFor(clientId: string, status = 401): Promise<Client> {
    // Cookie, actor-key and operator issuance cannot authenticate the website's
    // confidential OAuth client. Its registry identity is reserved for bootstrap.
    if (clientId === WEBSITE_CLIENT_ID) throw new Denied(status);
    const result = await database.query<Client>(
      'SELECT client_id, display_name, first_party, scopes FROM auth_client WHERE client_id=$1 AND EXISTS (SELECT 1 FROM auth_client_coverage v WHERE v.client_id=auth_client.client_id AND v.ready) AND NOT EXISTS (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=auth_client.client_id)',
      [clientId],
    );
    if (!result.rows[0]) throw new Denied(status);
    return result.rows[0];
  }
  async function allowed(accountId: string, selected: Binding): Promise<Client> {
    if (selected.scopes.includes('media:complete')) throw new Denied();
    const client = await clientFor(selected.clientId);
    if (selected.scopes.some((scope) => !client.scopes.includes(scope))) throw new Denied();
    const result = await database.query<{ scopes: string[]; pending_scopes: string[] | null }>(
      'SELECT scopes,pending_scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
      [accountId, selected.clientId],
    );
    const consent = result.rows[0];
    // An approved operator opening is the managing person's consent act, so it needs no stored consent;
    // issuance records it. Only a reduction in progress still bounds it.
    const consentRequired = selected.opening
      ? consent?.pending_scopes != null
      : !client.first_party || consent?.pending_scopes != null;
    if (
      (consentRequired && (!consent || selected.scopes.some((scope) => !consent.scopes.includes(scope)))) ||
      (consent?.pending_scopes && selected.scopes.some((scope) => !consent.pending_scopes!.includes(scope)))
    )
      throw new Denied();
    if (binding.getStore()) await materialize(accountId, selected.clientId, client.scopes, client.first_party);
    return client;
  }
  // Consent via issuance: the consumed opening is the managing person's consent act for its client and
  // scopes. It adds to the stored consent and never narrows it; only the reduction barrier does that.
  async function recordOpeningConsent(accountId: string, selected: Binding) {
    if ((await clientFor(selected.clientId)).first_party) return;
    await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `auth-consent:${accountId}:${selected.clientId}`,
    ]);
    await database.query(
      `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
       ON CONFLICT (account_id,client_id) DO UPDATE
       SET scopes=ARRAY(SELECT s FROM unnest(auth_consent.scopes || EXCLUDED.scopes) AS s GROUP BY s ORDER BY s COLLATE "C")
       WHERE auth_consent.pending_reference IS NULL`,
      [accountId, selected.clientId, selected.scopes],
    );
  }
  const website = websiteRoutes({
    options,
    scopeLimit,
    database,
    native: getAuth,
    withIssuance,
    sessionProof,
    getJwks: signer.getJwks,
  });
  function nativeAuth() {
    return betterAuth({
      ...betterAuthOptions(database, options.issuer, options.secret),
      emailAndPassword: {
        enabled: true,
        disableSignUp: true,
        resetPasswordTokenExpiresIn: 300,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: recoveryBinding.send,
      },
      plugins: [
        credentialOwnerSchema,
        passkeyPlugin(options.issuer),
        nativeVerificationPlugin,
        nativeSessionLimits(database),
        jwt({
          disableSettingJwtHeader: true,
          jwks: { remoteUrl: `${options.issuer}/.well-known/jwks.json`, keyPairConfig: { alg: 'ES256' } },
          jwt: {
            issuer: options.issuer,
            sign: async (payload, header) =>
              signer.signProtocol(header?.typ === 'at+jwt' ? await website.accessClaims(payload) : payload, header),
          },
        }),
        website.plugin,
        // Authorization validates against the registered client's scopes on every
        // request, so the provider list holds protocol scopes only.
        websiteProvider(['openid', 'offline_access'], website.claims),
        {
          id: 'trusted-establishment',
          async onRequest() {
            const dispatch = attemptDispatch.getStore();
            if (dispatch) return { response: await dispatch() };
          },
          endpoints: {
            establish: createAuthEndpoint('/trusted-establishment', { method: 'POST' }, async (ctx) => {
              const selected = binding.getStore();
              if (!selected?.subjectId) throw new APIError('UNAUTHORIZED');
              const user = await ctx.context.internalAdapter.findUserById(selected.subjectId);
              if (!user) throw new APIError('UNAUTHORIZED');
              // The session, its opening record and the opening's consent commit together or not at all.
              await ctx.context.adapter.transaction(async () => {
                const session = await ctx.context.internalAdapter.createSession(user.id);
                if (!session) throw new APIError('UNAUTHORIZED');
                if (selected.opening) {
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
                  await recordOpeningConsent(user.id, selected);
                }
                await setSessionCookie(ctx, { session, user });
              });
              return ctx.json({ success: true });
            }),
          },
        },
      ],
      databaseHooks: {
        verification: recoveryBinding.hooks,
        session: {
          delete: { before: website.beforeDeleteSession },
          create: {
            before: async (session) => {
              // Only a verified password, own-key assertion or consumed Access opening
              // can install this private context. Public request fields cannot install it.
              const selected = binding.getStore();
              if (!selected) throw new APIError('UNAUTHORIZED', { message: 'Trusted session establishment required' });
              try {
                const account = await activeActor(session.userId, false, !selected.opening);
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
              } catch (error) {
                if (error instanceof AccountSuspended && !error.account.automated && !selected.opening) {
                  selected.refusal = new SuspendedSignIn();
                  throw selected.refusal;
                }
                if (error instanceof Denied) throw new APIError('UNAUTHORIZED', { message: 'Authentication denied' });
                throw new APIError('SERVICE_UNAVAILABLE', { message: 'Authentication temporarily unavailable' });
              }
            },
          },
        },
      },
    });
  }
  // Public JWKS needs only the signer. Defer the provider's background schema
  // introspection until a native credential/session operation actually needs it.
  let native: ReturnType<typeof nativeAuth> | undefined;
  function getAuth() {
    return (native ??= nativeAuth());
  }
  async function getContext() {
    return getAuth().$context;
  }

  async function sessionProof(headers: Headers): Promise<SessionProof> {
    const result = await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!result) throw new Denied();
    const session = result.session;
    const account = await activeActor(session.userId);
    // Never replace a session epoch with the current floor. Only verified establishment installs it.
    if (
      !Number.isSafeInteger(session.authnEpoch) ||
      session.authnEpoch < account.authnEpoch ||
      !Number.isSafeInteger(session.authTime) ||
      session.authTime > Math.floor(Date.now() / 1000) ||
      !['pwd', 'pop', 'private_key_jwt', 'operator'].includes(session.authMethods)
    )
      throw new Denied();
    const granted = session.grantedScope ? scopes(session.grantedScope.split(' ')) : [];
    await allowed(account.accountId, { clientId: session.clientId, scopes: granted });
    const proof: SessionProof = {
      account_id: account.accountId,
      client_id: session.clientId,
      scope: granted,
      authn_epoch: session.authnEpoch,
      auth_time: session.authTime,
      amr: session.authMethods.split(' '),
    };
    Object.freeze(proof.scope);
    Object.freeze(proof.amr);
    Object.freeze(proof);
    proofSources.set(proof, { id: session.id, expiresAt: session.expiresAt.getTime() });
    return proof;
  }

  async function owner(accountId: string): Promise<void> {
    // Existing owners need no lock. Taking the only pool connection and then reading
    // through the pool deadlocks a single-connection Auth host.
    if (await (await getContext()).internalAdapter.findUserById(accountId)) return;
    // Advisory locking makes concurrent first establishment use one native owner.
    const connection = await database.connect();
    try {
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`auth-owner:${accountId}`]);
      if (await (await getContext()).internalAdapter.findUserById(accountId)) return;
      await (
        await getContext()
      ).adapter.transaction(async (transaction) => {
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
    if ((await activeActor(human.account_id)).automated || human.amr.includes('operator')) throw new Denied();
    return human;
  }
  async function operatorOpening(session: { id: string; userId: string; authMethods: string }) {
    if (session.authMethods !== 'operator') throw new Denied();
    const opening = (
      await database.query<{ acting_human_id: string; receipt_id: string }>(
        'SELECT acting_human_id,receipt_id FROM auth_session_opening WHERE session_id=$1 AND subject_account_id=$2',
        [session.id, session.userId],
      )
    ).rows[0];
    if (!opening || (await activeActor(opening.acting_human_id)).automated) throw new Denied();
    return opening.receipt_id;
  }
  function freshAuthentication(human: SessionProof) {
    if (Math.floor(Date.now() / 1000) - human.auth_time > 600) throw new StepUpRequired();
  }
  function freshCredentialProof(human: SessionProof, subjectId: string) {
    if (human.account_id === subjectId) freshAuthentication(human);
  }
  async function withCredentialProof<T>(
    human: SessionProof,
    callback: () => Promise<T>,
    deadline?: number,
  ): Promise<T> {
    const scope = { proof: human, live: true };
    const work = () =>
      proofScope.run(scope, async () => {
        try {
          return await callback();
        } finally {
          scope.live = false;
        }
      });
    return deadline === undefined ? work() : withCredentialRequestDeadline(human, deadline, work);
  }
  async function credentialStage(
    input: { key: string; effectRef: string; subjectAccountId: string },
    human: SessionProof,
  ) {
    const stage = await credentials.read(text(input.effectRef));
    const b = stage.binding;
    if (
      b.operationKey !== text(input.key) ||
      b.subjectAccountId !== text(input.subjectAccountId) ||
      b.actingHumanId !== human.account_id ||
      b.clientId !== human.client_id ||
      JSON.stringify(b.scopes) !== JSON.stringify(human.scope)
    )
      throw new Denied();
    return stage;
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
  // Nothing is applied for a receipt Access does not confirm for this account, purpose, operation and floor.
  async function confirmReceipt(receipt: InvalidationReceipt, purpose: BarrierProof['purpose'], operationKey: string) {
    const confirmed = await trustedAccess.confirmBarrier({
      accountId: receipt.accountId,
      purpose,
      operationKey,
      receiptId: receipt.receiptId,
      minimumAuthnEpoch: receipt.minimumAuthnEpoch,
    });
    if (confirmed !== true) throw new Denied();
  }
  async function consume(
    input: { authorization: string; subjectAccountId: string; headers: Headers },
    purpose: 'session',
  ) {
    if (!trustedAccess.consumeAuthorization) throw new Denied();
    const human = await humanProof(input.headers);
    const before = await activeActor(input.subjectAccountId);
    const previousEpoch = before.authnEpoch;
    const scope = { proof: human, live: true };
    const receipt = await proofScope.run(scope, async () => {
      try {
        const authorization: SessionAuthorizationInput = {
          authorization: text(input.authorization),
          subjectAccountId: input.subjectAccountId,
          purpose,
          human,
        };
        return await trustedAccess.consumeAuthorization!(authorization);
      } finally {
        scope.live = false;
      }
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
    if (response.status >= 500) throw new APIError('SERVICE_UNAVAILABLE');
    if (!response.ok) throw new Denied();
    const setCookies = response.headers.getSetCookie();
    const headers = new Headers({ cookie: setCookies.map((cookie) => cookie.split(';')[0]).join('; ') });
    try {
      return json(await sessionProof(headers), 200, setCookies);
    } catch (error) {
      const created = await getAuth().api.getSession({ headers });
      if (created) await (await getContext()).internalAdapter.deleteSession(created.session.token);
      throw error;
    }
  }
  async function establish(selected: Binding, headers: Headers): Promise<Response> {
    return await withIssuance(selected.clientId, async () =>
      established(
        await sessionBinding(selected, () =>
          getAuth().api.establish({
            headers: new Headers({
              origin: options.issuer,
              'content-type': 'application/json',
              'user-agent': headers.get('user-agent') ?? '',
            }),
            asResponse: true,
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
      account.authnEpoch < 0 ||
      account.authnEpoch > 2147483647
    )
      throw new Denied();
    return account;
  }
  function recoverableHuman(account: AccessAccount | null, accountId: string): account is AccessAccount {
    return (
      !!account &&
      account.accountId === accountId &&
      account.kind === 'actor' &&
      !account.automated &&
      account.state === 'active' &&
      Number.isSafeInteger(account.authnEpoch) &&
      account.authnEpoch >= 0 &&
      account.authnEpoch <= 2147483647
    );
  }
  async function deliverRecovery(email: string) {
    const found = await database.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email]);
    const accountId = found.rows[0]?.id;
    if (
      !accountId ||
      !trustedAccess.readRecoveryAccount ||
      !trustedAccess.authorizeRecovery ||
      !options.recoveryDelivery
    )
      return;
    const account = await trustedAccess.readRecoveryAccount(accountId);
    if (!recoverableHuman(account, accountId)) return;
    // Admit the account before minting a proof, so a cooled-down start stores nothing.
    const key = createHmac('sha256', options.secret)
      .update(JSON.stringify(['auth-recovery-mail-v1', accountId]))
      .digest('hex');
    const consumed = await chargeAccountAttempt(database, accountId, key, 60, 1);
    if (!consumed.rows[0]?.allowed) return;
    // requestPasswordReset resolves after a failed send; Better Auth only logs it.
    const outcome = { failed: false };
    try {
      await recoveryBinding.run(
        { accountId, epoch: account.authnEpoch },
        () => getAuth().api.requestPasswordReset({ body: { email } }),
        outcome,
      );
      if (outcome.failed) throw new Error('Recovery delivery failed');
    } catch (error) {
      await database.query('DELETE FROM auth_attempt_counter WHERE key=$1', [key]).catch(() => {});
      throw error;
    }
  }
  async function presentedSession(headers: Headers) {
    return await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
  }
  async function replacePreviousSession(previous: Awaited<ReturnType<typeof presentedSession>>, response: Response) {
    if (!previous || !response.ok) return response;
    const headers = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    });
    const created = await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    // Issuance has released its connection. Delete only the session this request presented.
    if (created && created.session.id !== previous.session.id)
      await (await getContext()).internalAdapter.deleteSession(previous.session.token);
    return response;
  }

  const provisioningEvidence = createProvisioningEvidenceVerifier({ database });
  async function pendingProvisioning(authorization: string) {
    if (typeof authorization !== 'string' || !authorization || authorization.length > 4096) throw new Denied();
    const approval = await trustedAccess.authorizeProvisioning(authorization);
    const account = { ...(await provisioningAccount(approval.accountId, authorization)) };
    if (
      !account ||
      account.accountId !== approval.accountId ||
      account.kind !== 'actor' ||
      account.state !== 'pending' ||
      account.fenced
    )
      throw new Denied();
    const receipt =
      approval.receipt === undefined
        ? undefined
        : {
            registrationId: approval.receipt?.registrationId,
            reservationId: approval.receipt?.reservationId,
            authnEpoch: approval.receipt?.authnEpoch,
            expiresAt: approval.receipt?.expiresAt,
          };
    if (
      receipt !== undefined &&
      (!validProvisioningReceipt(receipt) ||
        Date.parse(receipt.expiresAt) <= Date.now() ||
        receipt.authnEpoch !== account.authnEpoch ||
        (account.registrationId !== undefined && receipt.registrationId !== account.registrationId) ||
        (account.expiresAt !== undefined && Date.parse(receipt.expiresAt) !== Date.parse(account.expiresAt)))
    )
      throw new Denied();
    return { account, receipt };
  }
  function receiptBinding(receipt: ProvisioningReceiptMetadata | undefined) {
    return receipt ? [receipt.registrationId, receipt.reservationId, receipt.authnEpoch, receipt.expiresAt] : null;
  }
  async function commitProvisioning(input: {
    authorization: string;
    receiptKey: string;
    sourceRegistrationId?: string;
    account: AccessAccount;
    receipt: ProvisioningReceiptMetadata | undefined;
    email: string | null;
    hash: string | null;
    digest: Buffer;
  }): Promise<ProvisioningResult> {
    const { account, receipt, receiptKey } = input;
    text(receiptKey);
    async function recheck() {
      const current = await pendingProvisioning(input.authorization);
      if (
        current.account.accountId !== account.accountId ||
        current.account.automated !== account.automated ||
        JSON.stringify(receiptBinding(current.receipt)) !== JSON.stringify(receiptBinding(receipt))
      )
        throw new Denied();
    }
    const connection = await database.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `auth-owner:${account.accountId}`,
      ]);
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`auth-provision:${receiptKey}`]);
      const previous = (
        await connection.query<{ account_id: string; digest: Buffer }>(
          'SELECT account_id, digest FROM auth_provisioning_receipt WHERE idempotency_key=$1',
          [receiptKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.account_id !== account.accountId || !previous.digest.equals(input.digest)) throw new Denied();
      } else {
        // These are the installed Better Auth owner and credential models, not a
        // second credential registry. Their receipt commits in this same transaction.
        await connection.query(
          'INSERT INTO "user" (id,name,email,"emailVerified",image) VALUES ($1,\'\',$2,false,NULL)',
          [account.accountId, input.email],
        );
        const credentialId = randomUUID();
        await connection.query(
          'INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt") VALUES ($1,$2,\'credential\',$2,$3,CURRENT_TIMESTAMP)',
          [credentialId, account.accountId, input.hash],
        );
        await connection.query(
          `INSERT INTO auth_provisioning_receipt
            (idempotency_key,account_id,digest,registration_id,reservation_id,authn_epoch,expires_at,owner_id,credential_id,provisioning_kind,erasure_stage_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            receiptKey,
            account.accountId,
            input.digest,
            receipt?.registrationId ?? null,
            receipt?.reservationId ?? null,
            receipt?.authnEpoch ?? null,
            receipt?.expiresAt ?? null,
            receipt ? account.accountId : null,
            receipt ? credentialId : null,
            receipt ? (input.hash === null ? 'credentialless' : 'password') : null,
            input.sourceRegistrationId ?? null,
          ],
        );
      }
      if (receipt) await recheck();
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    if (!receipt) return { accountId: account.accountId };
    // A pending change during the native commit cannot publish an activation
    // proof. A retry must still authorize the original registration, never adopt
    // a later epoch/reservation. The immutable receipt is not upgraded on replay.
    await recheck();
    const reference = await provisioningEvidence.createReference({
      receiptKey,
      accountId: account.accountId,
      ...receipt,
    });
    if (!reference) throw new Denied();
    return { accountId: account.accountId, provisioningEvidence: reference };
  }

  const service: AuthService = {
    verifier: {
      issuer: options.issuer,
      audience: options.audience,
      jwksUrl: `${options.issuer}/.well-known/jwks.json`,
      algorithms: ['ES256'],
      accessTokenLifetimeSeconds: 300,
    },
    internal: {
      resolveRecoveryEstablishment: recoveryEstablishment.resolve,
      async accessTokenForProof(proof) {
        const scope = proofScope.getStore();
        const source = proofSources.get(proof);
        const live = () => {
          if (!source || !scope?.live || scope.proof !== proof || source.expiresAt <= Date.now()) throw new Denied();
        };
        // Copies, foreign instances and non-live proofs fail before any I/O.
        live();
        const issued = await withIssuance(proof.client_id, async () => {
          live();
          const current = (
            await database.query<{
              userId: string;
              clientId: string;
              grantedScope: string;
              authnEpoch: number;
              authTime: number;
              authMethods: string;
              expiresAt: Date;
            }>(
              'SELECT "userId","clientId","grantedScope","authnEpoch","authTime","authMethods","expiresAt" FROM session WHERE id=$1',
              [source!.id],
            )
          ).rows[0];
          if (
            !current ||
            current.userId !== proof.account_id ||
            current.clientId !== proof.client_id ||
            current.grantedScope !== proof.scope.join(' ') ||
            current.authnEpoch !== proof.authn_epoch ||
            current.authTime !== proof.auth_time ||
            current.authMethods !== proof.amr.join(' ') ||
            current.expiresAt.getTime() <= Date.now() ||
            proof.amr.includes('operator')
          )
            throw new Denied();
          const account = await activeActor(proof.account_id);
          if (account.automated || account.authnEpoch > proof.authn_epoch) throw new Denied();
          const client = await allowed(proof.account_id, { clientId: proof.client_id, scopes: proof.scope });
          await materialize(proof.account_id, proof.client_id, client.scopes, client.first_party);
          live();
          const expiresAt = Math.min(source!.expiresAt, current.expiresAt.getTime());
          const token = await signSessionAccessToken(signer, options, proof, expiresAt);
          live();
          if (expiresAt <= Date.now()) throw new Denied();
          return { token, expiresAt };
        });
        // Releasing the native issuance barrier is asynchronous too.
        live();
        if (issued.expiresAt <= Date.now()) throw new Denied();
        return issued.token;
      },
      pruneExpiredVerifications: () => pruneExpiredVerifications(database),
      pruneExpiredSessions: (batch) => pruneExpiredSessions(database, batch),
      eraseDueConsents: (batch) => eraseDueConsents(database, batch),
      hasDueConsentErasure: () => hasDueConsentErasure(database),
      pruneExpiredProtocolState: (batch) => pruneExpiredProtocolState(database, batch),
      trimSessionHistory: (accountId, batch) => trimSessionHistory(database, accountId, batch),
      sessionUpgradePage: (after, limit) => sessionUpgradePage(database, after, limit),
      signing: signer.control,
      async provisionPassword(input) {
        const { account, receipt } = await pendingProvisioning(input.authorization);
        if (
          typeof input.email !== 'string' ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
          input.email.length > 254 ||
          typeof input.password !== 'string' ||
          input.password.length < (await getContext()).password.config.minPasswordLength ||
          input.password.length > (await getContext()).password.config.maxPasswordLength
        )
          throw new Denied(400);
        const hash = await (await getContext()).password.hash(input.password);
        if (input.idempotencyKey !== undefined || receipt) {
          const digest = createHmac('sha256', options.secret)
            .update(
              JSON.stringify(
                receipt
                  ? [
                      'auth-provisioning-v2',
                      account.accountId,
                      input.email.toLowerCase(),
                      input.password,
                      receiptBinding(receipt),
                    ]
                  : ['auth-provisioning-v1', account.accountId, input.email.toLowerCase(), input.password],
              ),
            )
            .digest();
          return commitProvisioning({
            authorization: input.authorization,
            receiptKey: input.idempotencyKey ?? `password:${account.accountId}`,
            sourceRegistrationId: input.sourceRegistrationId,
            account,
            receipt,
            email: input.email.toLowerCase(),
            hash,
            digest,
          });
        }
        // Use the official PostgreSQL adapter and its explicit external-ID facility.
        await (
          await getContext()
        ).adapter.transaction(async (transaction) => {
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
        const { account, receipt } = await pendingProvisioning(input.authorization);
        if (!account.automated) throw new Denied();
        const digest = createHmac('sha256', options.secret)
          .update(JSON.stringify(['auth-credentialless-v1', account.accountId, receiptBinding(receipt)]))
          .digest();
        return commitProvisioning({
          authorization: input.authorization,
          receiptKey: input.idempotencyKey ?? `credentialless:${account.accountId}`,
          sourceRegistrationId: input.sourceRegistrationId,
          account,
          receipt,
          email: null,
          hash: null,
          digest,
        });
      },
      async startAccountErasure(accountId) {
        const account = trustedAccess.readErasureAccount
          ? await trustedAccess.readErasureAccount(accountId)
          : await trustedAccess.readAccount(accountId);
        if (!account || account.accountId !== accountId || account.state !== 'deleted' || !account.fenced)
          throw new Denied();
        return startNativeErasure(database, accountId, account.authnEpoch);
      },
      nativeErasurePage: (id) => nativeErasurePage(database, id),
      redriveNativeErasure: () => redriveNativeErasure(database),
      async eraseAccount(accountId) {
        const account = trustedAccess.readErasureAccount
          ? await trustedAccess.readErasureAccount(accountId)
          : await trustedAccess.readAccount(accountId);
        if (!account || account.accountId !== accountId || account.state !== 'deleted' || !account.fenced)
          throw new Denied();
        const id = await startNativeErasure(database, accountId, account.authnEpoch);
        // Direct native callers share the exact obligation with host recovery.
        // Every page commits/releases before continuing; no owner/client list is retained.
        for (;;) {
          const page = await nativeErasurePage(database, id);
          if (page.state !== 'more') return;
        }
      },
      async stageCredentialEffect(input) {
        const human = await humanProof(input.headers);
        freshCredentialProof(human, input.subjectAccountId);
        await activeActor(text(input.subjectAccountId));
        if ((input.credential as { kind?: string })?.kind === 'passkey') throw new Denied(400);
        const { credential } = await credentials.normalize(input.credential);
        if (credential.kind === 'password' && credential.password !== null) {
          const config = (await getContext()).password.config;
          if (
            credential.password.length < config.minPasswordLength ||
            credential.password.length > config.maxPasswordLength
          )
            throw new Denied(400);
        }
        await owner(input.subjectAccountId);
        const stage = await credentials.stage({
          ...input,
          credential,
          human,
          sourceSessionId: proofSources.get(human)?.id,
        });
        if (stage.purpose === 'add-passkey' || stage.purpose === 'remove-passkey') throw new Denied(400);
        return {
          effectRef: stage.effectReference,
          key: stage.operationKey,
          subjectId: stage.subjectAccountId,
          purpose: stage.purpose,
          digest: stage.effectDigest,
        };
      },
      async stagePasskeyEffect(input) {
        const human = await humanProof(input.headers);
        freshCredentialProof(human, input.subjectAccountId);
        const subject = await activeActor(text(input.subjectAccountId));
        if (subject.automated || human.account_id !== input.subjectAccountId) throw new Denied();
        if (input.credential?.kind !== 'passkey' || input.credential.remove !== true) throw new Denied(400);
        const { credential } = await credentials.normalize(input.credential);
        await owner(input.subjectAccountId);
        const stage = await credentials.stage({
          ...input,
          credential,
          human,
          sourceSessionId: proofSources.get(human)?.id,
        });
        if (stage.purpose !== 'remove-passkey') throw new Denied();
        return {
          effectRef: stage.effectReference,
          key: stage.operationKey,
          subjectId: stage.subjectAccountId,
          purpose: stage.purpose,
          digest: stage.effectDigest,
        };
      },
      async withFreshHuman(input, work) {
        const human = await humanProof(input.headers);
        if (input.fresh !== false) freshAuthentication(human);
        return withCredentialProof(human, () => work(human));
      },
      async approveCredentialEffect(input) {
        // Direct internal callers also receive one boundary deadline here;
        // Auth hosts pass the one created when their request arrived.
        const deadline = input.deadline ?? Date.now() + 3000;
        if (!trustedAccess.approveCredentialEffect) throw new Denied(503);
        const human = await humanProof(input.headers);
        freshCredentialProof(human, input.subjectAccountId);
        await activeActor(input.subjectAccountId);
        const stage = await credentialStage(input, human);
        if (!stage.row.committed_at) await credentials.current(database, stage);
        const approval = await withCredentialProof(
          human,
          () => {
            if (trustedAccess.passkeys)
              return trustedAccess.approveCredentialEffect!({ stage: stage.binding, human, deadline });
            const purpose = stage.binding.purpose;
            if (purpose === 'add-passkey' || purpose === 'remove-passkey') throw new Denied(503);
            return trustedAccess.approveCredentialEffect!({ stage: { ...stage.binding, purpose }, human, deadline });
          },
          deadline,
        );
        const expires = Date.parse(approval?.expiresAt);
        const source = proofSources.get(human);
        if (
          !approval?.reference ||
          !Number.isFinite(expires) ||
          expires <= Date.now() ||
          expires > Date.now() + 60000 ||
          !source ||
          expires > source.expiresAt
        )
          throw new Denied();
        const live = await database.query(
          "SELECT 1 WHERE $1::timestamptz > statement_timestamp() AND $1::timestamptz <= statement_timestamp()+interval '60 seconds'",
          [approval.expiresAt],
        );
        if (live.rowCount !== 1) throw new Denied();
        return { reference: approval.reference, expiresAt: approval.expiresAt };
      },
      async applyCredentialEffect(input) {
        // Direct internal callers also receive one boundary deadline here;
        // Auth hosts pass the one created when their request arrived.
        const deadline = input.deadline ?? Date.now() + 3000;
        if (!trustedAccess.revalidateCredentialEffect) throw new Denied(503);
        const human = await humanProof(input.headers);
        freshCredentialProof(human, input.subjectAccountId);
        const subject = await activeActor(input.subjectAccountId);
        const stage = await credentialStage(input, human);
        const authorization = text(input.authorization);
        const revalidate = async (
          replay: boolean,
          consumedOpening?: CredentialEffectAuthorization<CredentialFloorPurpose>,
          floorReceipt?: CredentialFloorReceipt,
          committedOpeningReceiptId?: string,
        ) => {
          // This receipt identity comes only from Auth's atomically committed row.
          // It is never accepted from the public credential command's input.
          const validation = {
            stage: stage.binding,
            human,
            authorization,
            replay,
            deadline,
            ...(consumedOpening ? { consumedOpening } : {}),
            ...(floorReceipt ? { floorReceipt } : {}),
            ...(committedOpeningReceiptId ? { committedOpeningReceiptId } : {}),
          };
          await withCredentialProof(
            human,
            () => {
              if (trustedAccess.passkeys) return trustedAccess.revalidateCredentialEffect!(validation);
              const purpose = validation.stage.purpose;
              if (purpose === 'add-passkey' || purpose === 'remove-passkey') throw new Denied(503);
              const { consumedOpening: opening, ...pendingValidation } = validation;
              return trustedAccess.revalidateCredentialEffect!({
                ...pendingValidation,
                stage: { ...validation.stage, purpose },
                ...(opening ? { consumedOpening: { ...opening, purpose } } : {}),
              });
            },
            deadline,
          );
        };
        if (stage.row.committed_at) {
          await revalidate(true, undefined, undefined, stage.row.opening_receipt_id ?? undefined);
          await humanProof(input.headers);
          return { receiptId: stage.row.receipt_id, replayed: true };
        }
        await credentials.current(database, stage);
        const consumeInput = {
          authorization,
          subjectAccountId: input.subjectAccountId,
          operationKey: stage.binding.operationKey,
          effectReference: stage.binding.effectReference,
          human,
          deadline,
        };
        const purpose = stage.binding.purpose;
        const receipt = await withCredentialProof<
          EffectAuthorization | CredentialEffectAuthorization<CredentialFloorPurpose>
        >(
          human,
          () => {
            if (purpose === 'add-passkey' || purpose === 'remove-passkey') {
              if (subject.automated || human.account_id !== subject.accountId) throw new Denied();
              if (!trustedAccess.consumePasskeyAuthorization) throw new Denied(503);
              return trustedAccess.consumePasskeyAuthorization({ ...consumeInput, purpose });
            }
            if (!trustedAccess.consumeAuthorization) throw new Denied(503);
            return trustedAccess.consumeAuthorization({ ...consumeInput, purpose });
          },
          deadline,
        );
        const b = stage.binding;
        if (
          !receipt?.receiptId ||
          receipt.operationKey !== b.operationKey ||
          receipt.effectReference !== b.effectReference ||
          receipt.effectDigest !== b.effectDigest ||
          receipt.purpose !== b.purpose ||
          receipt.subjectAccountId !== b.subjectAccountId ||
          receipt.actingHumanId !== human.account_id ||
          receipt.clientId !== human.client_id ||
          JSON.stringify(receipt.scopes) !== JSON.stringify(human.scope) ||
          receipt.humanEpoch !== human.authn_epoch ||
          receipt.subjectEpoch !== subject.authnEpoch ||
          !Number.isFinite(Date.parse(receipt.expiresAt)) ||
          Date.parse(receipt.expiresAt) <= Date.now() ||
          Date.parse(receipt.expiresAt) > Date.now() + 60000 ||
          Date.parse(receipt.expiresAt) > (proofSources.get(human)?.expiresAt ?? 0) ||
          (subject.automated
            ? !receipt.operatorAccountId
            : receipt.operatorAccountId !== null || human.account_id !== subject.accountId)
        )
          throw new Denied();
        const consumed = receipt as CredentialEffectAuthorization<CredentialFloorPurpose>;
        const destructive =
          b.purpose === 'remove-password' ||
          b.purpose === 'remove-key' ||
          b.purpose === 'remove-passkey' ||
          (b.purpose === 'set-password' && b.credentialRowId !== null);
        let hash: string | null = null;
        if (stage.credential.kind === 'password' && stage.credential.password !== null)
          hash = await (await getContext()).password.hash(stage.credential.password);
        const connection = await database.connect();
        try {
          await connection.query('BEGIN');
          // Same native owner lock as session issuance/revocation. Credential-row
          // CAS still arbitrates recovery and legacy writers that use other locks.
          await connection.query('SELECT auth_assert_session_capacity($1,true)', [subject.accountId]);
          const locked = await credentials.read(input.effectRef, b, connection, true);
          if (locked.row.committed_at) {
            await revalidate(true, undefined, undefined, locked.row.opening_receipt_id ?? undefined);
            await humanProof(input.headers);
            await connection.query('COMMIT');
            return { receiptId: locked.row.receipt_id, replayed: true };
          }
          await credentials.current(connection, locked);
          if (
            !subject.automated &&
            (b.purpose === 'remove-password' || b.purpose === 'remove-key' || b.purpose === 'remove-passkey')
          ) {
            const remaining = (
              await connection.query(
                `SELECT
              EXISTS(SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"='credential' AND password IS NOT NULL AND $2 <> 'remove-password')
              OR EXISTS(SELECT 1 FROM auth_public_key WHERE account_id=$1 AND $2 <> 'remove-passkey' AND ($2 <> 'remove-key' OR kid<>$3) LIMIT 1)
              OR EXISTS(SELECT 1 FROM passkey WHERE "userId"=$1 AND ($2 <> 'remove-passkey' OR id<>$4) LIMIT 1) AS allowed`,
                [
                  subject.accountId,
                  b.purpose,
                  stage.credential.kind === 'key' ? stage.credential.kid : '',
                  stage.credential.kind === 'passkey' ? stage.credential.id : '',
                ],
              )
            ).rows[0];
            if (!remaining.allowed) throw new Denied(409);
          }
          await revalidate(false, consumed);
          await humanProof(input.headers);
          const before = await activeActor(subject.accountId);
          if (before.authnEpoch !== subject.authnEpoch) throw new Denied();
          let floor: CredentialFloorReceipt | undefined;
          if (destructive) {
            if (!trustedAccess.advanceCredentialFloor) throw new Denied(503);
            floor = await withCredentialProof(
              human,
              () => {
                const input = {
                  stage: b,
                  consumedOpening: consumed,
                  expectedPreviousFloor: subject.authnEpoch,
                  key: b.operationKey,
                  purpose: b.purpose,
                  deadline,
                };
                if (trustedAccess.passkeys) return trustedAccess.advanceCredentialFloor!(input);
                const purpose = b.purpose;
                if (purpose === 'add-passkey' || purpose === 'remove-passkey') throw new Denied(503);
                return trustedAccess.advanceCredentialFloor!({
                  ...input,
                  stage: { ...b, purpose },
                  consumedOpening: { ...consumed, purpose },
                  purpose,
                });
              },
              deadline,
            );
            if (
              !floor?.receiptId ||
              floor.accountId !== b.subjectAccountId ||
              floor.operationKey !== b.operationKey ||
              floor.effectReference !== b.effectReference ||
              floor.effectDigest !== b.effectDigest ||
              floor.purpose !== b.purpose ||
              floor.openingReceiptId !== consumed.receiptId ||
              floor.previousFloor !== subject.authnEpoch ||
              floor.minimumAuthnEpoch !== subject.authnEpoch + 1 ||
              floor.fenced !== !!before.fenced
            )
              throw new Denied();
          }
          const current = await activeActor(subject.accountId);
          if (
            current.authnEpoch !== (floor?.minimumAuthnEpoch ?? subject.authnEpoch) ||
            !!current.fenced !== !!before.fenced
          )
            throw new Denied();
          // A destructive own operation invalidates its source proof. Only the
          // exact committed barrier can finish this in-flight operation; native
          // revalidation must enforce that exception, never authorize a retry.
          if (human.account_id !== subject.accountId || !floor) await humanProof(input.headers);
          await credentials.mutate(connection, locked, hash);
          if (destructive) await connection.query('SELECT auth_revoke_sessions($1)', [subject.accountId]);
          await revalidate(false, consumed, floor);
          if (human.account_id !== subject.accountId || !floor) await humanProof(input.headers);
          if ((await activeActor(subject.accountId)).authnEpoch !== current.authnEpoch) throw new Denied();
          await connection
            .query('SELECT 1 WHERE $1::timestamptz > statement_timestamp()', [consumed.expiresAt])
            .then((result) => {
              if (result.rowCount !== 1) throw new Denied();
            });
          const result = { receiptId: locked.row.receipt_id, replayed: false };
          const committed = await connection.query(
            `UPDATE auth_effect_receipt SET opening_receipt_id=$2,minimum_authn_epoch=$3,committed_result=$4,opening_reference=$5,committed_at=statement_timestamp()
            WHERE receipt_id=$1 AND committed_at IS NULL`,
            [locked.row.receipt_id, consumed.receiptId, current.authnEpoch, result, authorization],
          );
          if (committed.rowCount !== 1) throw new Denied();
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
      },
      verifyCredentialEffect: credentials.verify,
      async reduceConsent(input) {
        const granted = scopes(input.scopes);
        const client = await clientFor(text(input.clientId));
        if (client.first_party || granted.some((scope) => !client.scopes.includes(scope))) throw new Denied();
        const current = trustedAccess.readRecoveryAccount
          ? await trustedAccess.readRecoveryAccount(input.accountId)
          : await trustedAccess.readAccount(input.accountId);
        if (
          !current ||
          current.accountId !== input.accountId ||
          !current.fenced ||
          !input.barrier.receiptId ||
          input.barrier.accountId !== input.accountId ||
          !Number.isSafeInteger(input.barrier.minimumAuthnEpoch) ||
          input.barrier.minimumAuthnEpoch <= 0 ||
          current.authnEpoch < input.barrier.minimumAuthnEpoch
        )
          throw new Denied();
        const connection = await database.connect();
        try {
          await connection.query('BEGIN');
          await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `auth-consent:${input.accountId}:${client.client_id}`,
          ]);
          const prior = (
            await connection.query<{ scopes: string[] }>(
              'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2 FOR UPDATE',
              [input.accountId, client.client_id],
            )
          ).rows[0];
          if (!prior || granted.some((scope) => !prior.scopes.includes(scope))) throw new Denied();
          const receipt = (
            await connection.query<{ account_id: string; purpose: string; minimum_authn_epoch: number }>(
              'INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch) VALUES ($1,$2,$3,$4) ON CONFLICT (receipt_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id RETURNING account_id,purpose,minimum_authn_epoch',
              [input.barrier.receiptId, input.accountId, 'consent-reduction', input.barrier.minimumAuthnEpoch],
            )
          ).rows[0]!;
          if (
            receipt.account_id !== input.accountId ||
            receipt.purpose !== 'consent-reduction' ||
            receipt.minimum_authn_epoch !== input.barrier.minimumAuthnEpoch
          )
            throw new Denied();
          await connection.query('UPDATE auth_consent SET scopes=$3 WHERE account_id=$1 AND client_id=$2', [
            input.accountId,
            client.client_id,
            granted,
          ]);
          await connection.query('COMMIT');
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
        await (await getContext()).internalAdapter.deleteUserSessions(input.accountId);
      },
      ...authority.internal,
      async revokeSessions(accountId, cleanup) {
        if (cleanup?.boundedCleanup) return authority.cleanupFencedSessions(accountId, cleanup.barrier);
        await (await getContext()).internalAdapter.deleteUserSessions(accountId);
      },
      registerWebsiteClient: website.register,
      async registerClient(input) {
        if (input.mode !== undefined && input.mode !== 'create-or-match') throw new Denied(400);
        const id = text(input.clientId);
        let displayName: string | null = null;
        if (input.displayName !== undefined) {
          if (typeof input.displayName !== 'string') throw new Denied(400);
          displayName = input.displayName.trim();
          if (!displayName || displayName.length > 100) throw new Denied(400);
        }
        if (typeof input.firstParty !== 'boolean') throw new Denied(400);
        const granted = scopes(input.scopes);
        if (id === WEBSITE_CLIENT_ID || granted.includes('media:complete')) throw new Denied(400);
        const connection = await database.connect();
        try {
          await connection.query('BEGIN');
          await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`auth-client:${id}`]);
          if ((await connection.query('SELECT client_id FROM auth_client_reduction WHERE client_id=$1', [id])).rowCount)
            throw new Denied();
          const previous = (
            await connection.query<Client>('SELECT * FROM auth_client WHERE client_id=$1 FOR UPDATE', [id])
          ).rows[0];
          // Shrink requires a durable multi-account coordinator. Refuse it at this boundary.
          if (
            previous &&
            (previous.scopes.some((scope) => !granted.includes(scope)) || (previous.first_party && !input.firstParty))
          )
            throw new Denied();
          if (previous && input.mode === 'create-or-match') {
            if (
              previous.first_party !== input.firstParty ||
              new Set(previous.scopes).size !== granted.length ||
              previous.scopes.some((scope) => !granted.includes(scope))
            )
              throw new Denied();
            await connection.query('COMMIT');
            return;
          }
          await connection.query(
            'INSERT INTO auth_client (client_id, first_party, scopes, display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (client_id) DO UPDATE SET first_party=EXCLUDED.first_party, scopes=EXCLUDED.scopes, display_name=EXCLUDED.display_name',
            [id, input.firstParty, granted, displayName],
          );
          if (!previous)
            await connection.query(
              'INSERT INTO auth_client_coverage (client_id,ready,ready_after) VALUES ($1,true,CURRENT_TIMESTAMP)',
              [id],
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
      const url = new URL(request.url);
      const deadline = Date.now() + 3000;
      try {
        const protocol = await website.handler(request);
        if (protocol) return protocol;
        if (url.origin !== options.issuer || url.search) throw new Denied(400);
        if (url.pathname === '/.well-known/jwks.json' && request.method === 'GET') return json(await signer.getJwks());
        if (url.pathname === '/session' && request.method === 'GET') return json(await sessionProof(request.headers));
        if (url.pathname === '/passkeys' && request.method === 'GET') {
          if (request.headers.get('origin') !== options.issuer) throw new Denied(403);
          const human = await humanProof(request.headers);
          const result = await database.query(
            'SELECT id,name,"createdAt" AS created_at,last_used_at FROM passkey WHERE "userId"=$1 ORDER BY id LIMIT 32',
            [human.account_id],
          );
          return json({ passkeys: result.rows });
        }
        if (request.method === 'GET' && /^\/consent\/[^/]+$/.test(url.pathname)) {
          const human = await humanProof(request.headers);
          let clientId: string;
          try {
            clientId = decodeURIComponent(url.pathname.slice('/consent/'.length));
          } catch {
            throw new Denied(400);
          }
          const client = await clientFor(clientId, 404);
          if (client.first_party) throw new Denied(404);
          const consent = (
            await database.query<{ scopes: string[]; pending_scopes: string[] | null }>(
              'SELECT scopes,pending_scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
              [human.account_id, client.client_id],
            )
          ).rows[0];
          return json({
            client_id: client.client_id,
            display_name: client.display_name,
            scopes: client.scopes,
            granted:
              consent?.scopes.filter(
                (scope) =>
                  client.scopes.includes(scope) &&
                  (consent.pending_scopes === null || consent.pending_scopes.includes(scope)),
              ) ?? [],
          });
        }
        if (url.pathname === '/sessions' && request.method === 'GET') {
          const human = await humanProof(request.headers);
          const currentId = proofSources.get(human)!.id;
          const sessions = await database.query(
            `SELECT s.id,s."clientId" AS client_id,c.display_name AS client_display_name,
                    s."createdAt" AS created_at,s."expiresAt" AS expires_at,
                    s."userAgent" AS user_agent,s.id=$2 AS current
             FROM session s LEFT JOIN auth_client c ON c.client_id=s."clientId"
             WHERE s."userId"=$1 AND s."expiresAt">CURRENT_TIMESTAMP
             ORDER BY s."createdAt" DESC,s.id DESC LIMIT 64`,
            [human.account_id, currentId],
          );
          return json({ sessions: sessions.rows });
        }
        if (
          ![
            '/signin',
            '/signin/key',
            '/signin/passkey/options',
            '/signin/passkey',
            '/passkeys/register/options',
            '/passkeys/register',
            '/passkeys/remove',
            '/recovery/start',
            '/recovery/complete',
            '/token',
            '/consent',
            '/signout',
            '/sessions/revoke',
          ].includes(url.pathname) ||
          request.method !== 'POST'
        )
          throw new Denied(404);
        // All mutations require the configured origin, including first-login CSRF protection.
        if (request.headers.get('origin') !== options.issuer || request.headers.get('sec-fetch-site') === 'cross-site')
          throw new Denied(403);
        // Validate before the attempt limit so a malformed address is not charged.
        if (url.pathname === '/recovery/start' && !attemptDispatch.getStore())
          recoveryAddress(await bodyOf(request.clone()));
        const attemptPath = {
          '/signin': '/sign-in/email',
          '/signin/key': '/sign-in/email',
          '/signin/passkey/options': '/sign-in/email',
          '/signin/passkey': '/sign-in/email',
          '/passkeys/register/options': '/sign-in/email',
          '/passkeys/register': '/sign-in/email',
          '/passkeys/remove': '/sign-in/email',
          '/recovery/start': '/request-password-reset',
          '/recovery/complete': '/reset-password',
        }[url.pathname];
        if (attemptPath && !attemptDispatch.getStore()) {
          const response = await attemptDispatch.run(
            () => service.handler(request),
            () => getAuth().handler(nativeAttemptRequest(request, options.issuer, attemptPath)),
          );
          if (response.status === 429) {
            const denied = json({ error: 'authentication_denied' }, 429);
            // The pinned router emits X-Retry-After; expose the standard header
            // without forwarding endpoint bodies or releasing session cookies.
            denied.headers.set('retry-after', response.headers.get('x-retry-after') ?? '1');
            return denied;
          }
          if (response.status >= 500) return json({ error: 'authentication_denied' }, 503);
          return response;
        }
        const body = await bodyOf(request);
        if (url.pathname === '/sessions/revoke') {
          fields(body, ['session_id']);
          const sessionId = text(body.session_id);
          const human = await humanProof(request.headers);
          // Preserve unknown/foreign concealment before attempting the mutation.
          const target = (
            await database.query<{ userId: string }>('SELECT "userId" FROM session WHERE id=$1', [sessionId])
          ).rows[0];
          if (target?.userId !== human.account_id) throw new Denied(404);
          const cookies: string[] = [];
          if (sessionId === proofSources.get(human)!.id) {
            const { authCookies } = await getContext();
            for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken])
              cookies.push(serializeCookie(cookie.name, '', { ...cookie.attributes, maxAge: 0 }));
          }
          // Both mutation and ownership proof address only the exact key. An
          // ordinary owner predicate here lets the planner scan owner history.
          // Recheck ownership in this statement's snapshot, including key reuse
          // since the read above. Native (id,userId) immutability also preserves
          // that guard if DELETE must recheck a concurrently updated tuple.
          await database.query('DELETE FROM session WHERE id=$1 AND (SELECT "userId" FROM session WHERE id=$1)=$2', [
            sessionId,
            human.account_id,
          ]);
          return json({}, 200, cookies);
        }
        if (url.pathname === '/recovery/start') {
          const email = recoveryAddress(body);
          // Lookup, Access and delivery stay off this response. Failures are logged without the address.
          void deliverRecovery(email).catch(() => {
            console.error('Recovery start failed');
          });
          return json({ success: true });
        }
        if (url.pathname === '/recovery/complete') {
          fields(body, ['account_id', 'token', 'new_password']);
          if (!trustedAccess.completeRecovery) throw new Denied(503);
          const accountId = text(body.account_id);
          const token = text(body.token);
          const newPassword = text(body.new_password);
          if (
            newPassword.length < (await getContext()).password.config.minPasswordLength ||
            newPassword.length > (await getContext()).password.config.maxPasswordLength
          )
            throw new Denied(400);
          const account = await recoveryAccount(accountId);
          const sourceHash = proofHash(token);
          const operationKey = digestOf(['auth-recovery-v1', accountId, sourceHash]);
          const effectCommitment = createHmac('sha256', options.secret)
            .update(JSON.stringify(['auth-recovery-password-v1', accountId, sourceHash, newPassword]))
            .digest('hex');
          // Detect committed success before comparing the old credential. No
          // verification read, hashing, Access barrier or password effect repeats.
          const completed = (
            await database.query(
              `SELECT reference,evidence,applied_at FROM auth_barrier_proof
               WHERE account_id=$1 AND purpose='recovery' AND operation_key=$2`,
              [accountId, operationKey],
            )
          ).rows[0];
          if (completed?.applied_at) {
            const success = await recoveryEstablishment.resolve(completed.reference);
            if (!success || completed.evidence[8] !== effectCommitment || success.authnEpoch !== account.authnEpoch)
              throw new Denied();
            await trustedAccess.completeRecovery(completed.reference);
            return json({ success: true });
          }
          // Native adapter reads use the same pool. Finish them before leasing a
          // transaction connection, including with a real max=1 pool.
          const credential = await (await getContext()).internalAdapter.findCredentialAccount(accountId);
          if (!credential) throw new Denied();
          const nativeProof = await (
            await getContext()
          ).internalAdapter.findVerificationValue(`reset-password:${token}`);
          const fingerprint = digestOf([credential.password, credential.updatedAt.toISOString()]);
          const connection = await database.connect();
          let proof;
          try {
            await connection.query('BEGIN');
            const source = (
              await connection.query<{
                authn_epoch: number;
                expires_at: Date;
                consumed_operation: string | null;
                consumed_verification_id: string | null;
              }>(
                `SELECT authn_epoch,expires_at,consumed_operation,consumed_verification_id FROM auth_recovery
                WHERE proof_hash=$1 AND account_id=$2 AND expires_at>statement_timestamp() FOR UPDATE`,
                [sourceHash, accountId],
              )
            ).rows[0];
            if (!source) throw new Denied();
            let verificationId = source.consumed_verification_id;
            let sourceExpiry = source.expires_at;
            if (!source.consumed_operation) {
              if (source.authn_epoch !== account.authnEpoch) throw new Denied();
              // Delete the exact installed native verification and consume its
              // Auth source in the same transaction as the immutable proof.
              if (!nativeProof || nativeProof.value !== accountId || nativeProof.expiresAt.getTime() <= Date.now())
                throw new Denied();
              verificationId = nativeProof.id;
              sourceExpiry = new Date(Math.min(sourceExpiry.getTime(), nativeProof.expiresAt.getTime()));
              if (
                !(
                  await connection.query(
                    'DELETE FROM verification WHERE id=$1 AND value=$2 AND "expiresAt">statement_timestamp() RETURNING id',
                    [verificationId, accountId],
                  )
                ).rowCount
              )
                throw new Denied();
              await connection.query(
                `UPDATE auth_recovery SET consumed_operation=$2,consumed_verification_id=$3,
                 consumed_at=statement_timestamp(),expires_at=$4 WHERE proof_hash=$1 AND consumed_operation IS NULL`,
                [sourceHash, operationKey, verificationId, sourceExpiry],
              );
            } else if (source.consumed_operation !== operationKey) throw new Denied();
            const evidence = [
              'recovery-v1',
              accountId,
              source.authn_epoch,
              sourceHash,
              verificationId,
              credential.id,
              fingerprint,
              'set-password',
              effectCommitment,
            ];
            proof = await publishBarrier(
              connection,
              'recovery',
              accountId,
              source.authn_epoch,
              operationKey,
              evidence,
              sourceExpiry,
              !!source.consumed_operation,
            );
            await connection.query('COMMIT');
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            connection.release();
          }
          // No lease or session advisory lock crosses a callback that can read
          // Auth again. Immutable operation/effect binding and the final native
          // credential/proof CAS serialize concurrent callers across both phases.
          if (!(await barrierProofs.verify(proof.reference, proof))) throw new Denied();
          const receipt = await trustedAccess.authorizeRecovery!({
            accountId,
            proofEpoch: proof.previousEpoch,
            proofReference: proof.reference,
            operationKey,
          });
          invalidation(receipt, accountId, proof.previousEpoch);
          await confirmReceipt(receipt, 'recovery', operationKey);
          if (
            receipt.minimumAuthnEpoch > 2147483647 ||
            (await recoveryAccount(accountId)).authnEpoch !== receipt.minimumAuthnEpoch
          )
            throw new Denied();
          const passwordHash = await (await getContext()).password.hash(newPassword);
          const mutation = await database.connect();
          try {
            await mutation.query('BEGIN');
            const current = (
              await mutation.query(
                'SELECT password,"updatedAt","userId","accountId","providerId" FROM account WHERE id=$1 FOR UPDATE',
                [credential.id],
              )
            ).rows[0];
            if (
              !current ||
              current.userId !== accountId ||
              current.accountId !== accountId ||
              current.providerId !== 'credential' ||
              digestOf([current.password, current.updatedAt.toISOString()]) !== fingerprint
            )
              throw new Denied();
            await mutation.query('SELECT auth_revoke_sessions($1)', [accountId]);
            const updated = (
              await mutation.query(
                'UPDATE account SET password=$2,"updatedAt"=statement_timestamp() WHERE id=$1 RETURNING password,"updatedAt"',
                [credential.id, passwordHash],
              )
            ).rows[0];
            await applyBarrier(mutation, proof.reference, receipt, 'recovery');
            await mutation.query(
              `INSERT INTO auth_recovery_establishment
               (reference,receipt_id,account_id,credential_id,credential_fingerprint,effect_commitment,establishment_id,authn_epoch)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                proof.reference,
                receipt.receiptId,
                accountId,
                credential.id,
                digestOf([updated.password, updated.updatedAt.toISOString()]),
                effectCommitment,
                randomUUID(),
                receipt.minimumAuthnEpoch,
              ],
            );
            await mutation.query('COMMIT');
          } catch (error) {
            await mutation.query('ROLLBACK');
            throw error;
          } finally {
            mutation.release();
          }
          await trustedAccess.completeRecovery(proof.reference);
          return json({ success: true });
        }
        if (url.pathname === '/signin/passkey/options' || url.pathname === '/passkeys/register/options') {
          fields(body, []);
          const registering = url.pathname === '/passkeys/register/options';
          if (registering) {
            const human = await humanProof(request.headers);
            freshCredentialProof(human, human.account_id);
          }
          const response = registering
            ? await getAuth().api.generatePasskeyRegistrationOptions({ headers: request.headers, asResponse: true })
            : await getAuth().api.generatePasskeyAuthenticationOptions({
                headers: new Headers({ origin: options.issuer }),
                asResponse: true,
              });
          if (response.status >= 500) throw new APIError('SERVICE_UNAVAILABLE');
          if (!response.ok) throw new Denied();
          const result = await response.json();
          if (!registering) result.userVerification = 'required';
          return json(result, 200, response.headers.getSetCookie());
        }
        if (url.pathname === '/signin/passkey') {
          fields(body, ['response', 'client_id', 'scope']);
          if (!body.response || typeof body.response !== 'object' || Array.isArray(body.response))
            throw new Denied(400);
          const previous = await presentedSession(request.headers);
          const selected: Binding = { clientId: text(body.client_id), scopes: scopes(body.scope), method: 'pop' };
          await clientFor(selected.clientId);
          const response = await withIssuance(selected.clientId, async () =>
            established(
              await sessionBinding(selected, () =>
                getAuth().api.verifyPasskeyAuthentication({
                  headers: request.headers,
                  body: { response: body.response as PasskeyAssertion },
                  asResponse: true,
                }),
              ),
            ),
          );
          return await replacePreviousSession(previous, response);
        }
        if (url.pathname === '/passkeys/register' || url.pathname === '/passkeys/remove') {
          const registering = url.pathname === '/passkeys/register';
          fields(body, registering ? ['response', 'name'] : ['id']);
          const human = await humanProof(request.headers);
          freshCredentialProof(human, human.account_id);
          let stage;
          if (registering) {
            const input = registrationInput(body.response, body.name);
            const existing = (
              await database.query(
                'SELECT effect_reference FROM auth_effect_receipt WHERE account_id=$1 AND operation_key=$2',
                [human.account_id, input.key],
              )
            ).rows[0];
            if (existing) {
              stage = await credentials.read(existing.effect_reference);
              if (
                stage.credential.kind !== 'passkey' ||
                stage.credential.remove ||
                stage.credential.registrationDigest !== input.digest ||
                stage.binding.actingHumanId !== human.account_id ||
                stage.binding.clientId !== human.client_id ||
                JSON.stringify(stage.binding.scopes) !== JSON.stringify(human.scope)
              )
                throw new Denied(409);
            } else {
              const ceremony: Parameters<typeof passkeyCeremonies.run>[0] = {};
              await passkeyCeremonies.run(ceremony, () =>
                getAuth().api.verifyPasskeyRegistration({
                  headers: request.headers,
                  body: { response: body.response, ...(input.name === null ? {} : { name: input.name }) },
                  asResponse: true,
                }),
              );
              if (!ceremony.credential) throw new Denied();
              const binding = await credentials.stage({
                key: input.key,
                subjectAccountId: human.account_id,
                credential: ceremony.credential,
                human,
                sourceSessionId: proofSources.get(human)?.id,
              });
              stage = await credentials.read(binding.effectReference);
            }
          } else {
            const staged = await service.internal.stagePasskeyEffect({
              key: `passkey-remove:${randomUUID()}`,
              subjectAccountId: human.account_id,
              headers: request.headers,
              credential: { kind: 'passkey', id: text(body.id), remove: true },
            });
            stage = await credentials.read(staged.effectRef);
          }
          const input = {
            key: stage.binding.operationKey,
            effectRef: stage.binding.effectReference,
            subjectAccountId: human.account_id,
            headers: request.headers,
            deadline,
          };
          const reference = stage.row.committed_at
            ? stage.row.opening_reference
            : (await service.internal.approveCredentialEffect(input)).reference;
          if (!reference) throw new Denied();
          await service.internal.applyCredentialEffect({ ...input, authorization: reference });
          if (registering && stage.credential.kind === 'passkey' && !stage.credential.remove)
            return json(
              { id: stage.credential.id, name: stage.credential.name, created_at: stage.credential.createdAt },
              201,
            );
          return json({ success: true });
        }
        if (url.pathname === '/signin/key') {
          fields(body, ['account_id', 'assertion', 'client_id', 'scope']);
          const account = await credentialActor(text(body.account_id));
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
          } catch (error) {
            if (error instanceof InvalidKeyAssertion) throw new Denied();
            throw error;
          }
          return await establish(selected, request.headers);
        }
        if (url.pathname === '/signin') {
          fields(body, ['email', 'account_id', 'password', 'client_id', 'scope']);
          const previous = await presentedSession(request.headers);
          let response: Response;
          if (body.account_id !== undefined) {
            if (body.email !== undefined) throw new Denied(400);
            const account = await credentialActor(text(body.account_id));
            const password = text(body.password);
            if (password.length > (await getContext()).password.config.maxPasswordLength) throw new Denied(400);
            const credential = await (await getContext()).internalAdapter.findCredentialAccount(account.accountId);
            if (
              !credential?.password ||
              !(await (await getContext()).password.verify({ hash: credential.password, password }))
            )
              throw new Denied();
            response = await establish(
              {
                clientId: text(body.client_id),
                scopes: scopes(body.scope),
                method: 'pwd',
                subjectId: account.accountId,
                epoch: account.authnEpoch,
              },
              request.headers,
            );
          } else {
            const selected = { clientId: text(body.client_id), scopes: scopes(body.scope) };
            await clientFor(selected.clientId);
            response = await withIssuance(selected.clientId, async () => {
              const signed = await sessionBinding(selected, () =>
                getAuth().api.signInEmail({
                  headers: request.headers,
                  body: { email: text(body.email), password: text(body.password) },
                  asResponse: true,
                }),
              );
              if (!signed.ok)
                return json({ error: 'authentication_denied' }, signed.status >= 400 ? signed.status : 401);
              const setCookies = signed.headers.getSetCookie();
              const headers = new Headers({ cookie: setCookies.map((cookie) => cookie.split(';')[0]).join('; ') });
              try {
                const proof = await sessionProof(headers);
                return json(proof, 200, setCookies);
              } catch (error) {
                // A state/consent change during establishment must not release its cookie.
                const created = await getAuth().api.getSession({ headers });
                if (created) await (await getContext()).internalAdapter.deleteSession(created.session.token);
                throw error;
              }
            });
          }
          return await replacePreviousSession(previous, response);
        }
        if (url.pathname === '/token') {
          fields(body, ['requested_by']);
          const native = await getAuth().api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true, disableRefresh: true },
          });
          if (!native) throw new Denied();
          return await withIssuance(native.session.clientId, async () => {
            const proof = await sessionProof(request.headers);
            const client = await clientFor(proof.client_id);
            await materialize(proof.account_id, proof.client_id, client.scopes, client.first_party);
            let requestedBy: string | undefined;
            if (Object.hasOwn(body, 'requested_by')) {
              const reference = body.requested_by;
              const match = typeof reference === 'string' ? assignmentReference.exec(reference) : null;
              if (!match || match[0] !== reference || !trustedAccess.readAssignment) throw new Denied();
              // The cookie supplies actor/client/scopes. The body supplies only an
              // untrusted reference, resolved by the separately anchored Access reader.
              const assignment = await trustedAccess.readAssignment(reference as string, proof.account_id);
              if (
                assignment.kind !== 'resolved' ||
                assignment.principalId !== match[1] ||
                assignment.requestId !== match[2] ||
                assignment.assignedActorId !== proof.account_id
              )
                throw new Denied();
              await activeActor(assignment.principalId);
              requestedBy = `urn:rezics:request:${assignment.principalId}:${assignment.requestId}`;
            }
            const accessToken = await signSessionAccessToken(signer, options, proof, Infinity, requestedBy);
            return json({ access_token: accessToken, token_type: 'Bearer', expires_in: 300 });
          });
        }
        if (url.pathname === '/consent') {
          fields(body, ['client_id', 'scope']);
          const clientId = text(body.client_id);
          const granted = scopes(body.scope);
          const reduction = await withIssuance(clientId, async () => {
            const native = await getAuth().api.getSession({
              headers: request.headers,
              query: { disableCookieCache: true, disableRefresh: true },
            });
            if (!native) throw new Denied();
            const session = native.session;
            const account = await activeActor(session.userId, true);
            // An automated account is reduced only from a session its operator's manager opened for it.
            const operated = account.automated;
            const openingReceiptId = operated ? await operatorOpening(session) : undefined;
            const client = await clientFor(clientId);
            if (client.first_party || granted.some((scope) => !client.scopes.includes(scope))) throw new Denied(400);
            return withConsent(account.accountId, clientId, async (connection) => {
              const previous = (
                await connection.query<{
                  scopes: string[];
                  revision: string;
                  pending_reference: string | null;
                }>(
                  'SELECT scopes,revision::text,pending_reference FROM auth_consent WHERE account_id=$1 AND client_id=$2 FOR UPDATE',
                  [account.accountId, clientId],
                )
              ).rows[0];
              if (operated && (!previous || granted.some((scope) => !previous.scopes.includes(scope))))
                throw new Denied();
              if (!previous?.scopes.some((scope) => !granted.includes(scope))) {
                if (operated) throw new Denied();
                // Only a current native human session can supersede a pending
                // request. A first-party materialization never clears it.
                await humanProof(request.headers);
                await connection.query(
                  `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
                   ON CONFLICT (account_id,client_id) DO UPDATE
                   SET scopes=EXCLUDED.scopes,pending_scopes=NULL,pending_reference=NULL`,
                  [account.accountId, clientId, granted],
                );
                return null;
              }
              if (!trustedAccess.invalidateAccount) throw new Denied();
              const evidence = [
                'consent-v1',
                account.accountId,
                session.authnEpoch,
                session.id,
                session.clientId,
                session.grantedScope,
                session.authTime,
                session.authMethods,
                clientId,
                client.scopes,
                previous.revision,
                previous.scopes,
                granted,
                ...(openingReceiptId === undefined ? [] : [openingReceiptId]),
              ];
              const operationKey = digestOf(['auth-consent-v1', evidence]);
              const resuming = session.authnEpoch < account.authnEpoch || previous.pending_reference !== null;
              if (!resuming && !operated) {
                const human = await humanProof(request.headers);
                if (human.account_id !== account.accountId || human.authn_epoch !== account.authnEpoch)
                  throw new Denied();
              }
              const proof = {
                ...(await publishBarrier(
                  connection,
                  'consent-reduction',
                  account.accountId,
                  session.authnEpoch,
                  operationKey,
                  evidence,
                  session.expiresAt,
                  resuming,
                )),
                ...(openingReceiptId === undefined ? {} : { openingReceiptId }),
              };
              if (resuming && previous.pending_reference !== proof.reference) throw new Denied();
              // Publish the ceiling with the proof, preserving original scopes
              // and revision for immutable evidence and the final compare-and-set.
              await connection.query(
                'UPDATE auth_consent SET pending_scopes=$3,pending_reference=$4 WHERE account_id=$1 AND client_id=$2',
                [account.accountId, clientId, granted, proof.reference],
              );
              return { proof, revision: previous.revision, clientScopes: client.scopes };
            });
          });
          if (reduction) {
            // Both issuance context and every Auth connection/client lock have
            // ended. Access's verifier may borrow the very same max=1 pool.
            const { proof } = reduction;
            if (!(await barrierProofs.verify(proof.reference, proof))) throw new Denied();
            const receipt = await trustedAccess.invalidateAccount!({
              accountId: proof.accountId,
              previousEpoch: proof.previousEpoch,
              reason: 'consent-reduction',
              proofReference: proof.reference,
              operationKey: proof.operationKey,
              ...(proof.openingReceiptId === undefined ? {} : { openingReceiptId: proof.openingReceiptId }),
            });
            invalidation(receipt, proof.accountId, proof.previousEpoch);
            await confirmReceipt(receipt, 'consent-reduction', proof.operationKey);
            await withIssuance(clientId, () =>
              withConsent(proof.accountId, clientId, async (connection) => {
                const client = await clientFor(clientId);
                if (
                  client.first_party ||
                  JSON.stringify(client.scopes) !== JSON.stringify(reduction.clientScopes) ||
                  granted.some((scope) => !client.scopes.includes(scope)) ||
                  (await activeActor(proof.accountId, true)).authnEpoch !== receipt.minimumAuthnEpoch ||
                  !(await barrierProofs.verify(proof.reference, proof))
                )
                  throw new Denied();
                if (
                  !(
                    await connection.query(
                      `UPDATE auth_consent SET scopes=$3,pending_scopes=NULL,pending_reference=NULL
                       WHERE account_id=$1 AND client_id=$2 AND revision=$4 AND pending_reference=$5
                       AND pending_scopes=$3 RETURNING account_id`,
                      [proof.accountId, clientId, granted, reduction.revision, proof.reference],
                    )
                  ).rowCount
                )
                  throw new Denied();
                await applyBarrier(connection, proof.reference, receipt, 'consent-reduction');
              }),
            );
            await (await getContext()).internalAdapter.deleteUserSessions(proof.accountId);
            await trustedAccess.completeBarrier?.({
              accountId: proof.accountId,
              purpose: 'consent-reduction',
              operationKey: proof.operationKey,
              receiptId: receipt.receiptId,
              minimumAuthnEpoch: receipt.minimumAuthnEpoch,
            });
          }
          return json({ client_id: clientId, scope: granted });
        }
        fields(body, []);
        // Better Auth owns cookie clearing and deletion of its own persistent session.
        const response = await getAuth().handler(
          new Request(`${options.issuer}/api/auth/sign-out`, { method: 'POST', headers: request.headers, body: '{}' }),
        );
        return json({ success: response.ok }, response.status, response.headers.getSetCookie());
      } catch (error) {
        if (error instanceof SuspendedSignIn) return json({ error: 'account_suspended' }, 403);
        if (error instanceof StepUpRequired)
          return json({ error: 'step_up_required', effect_status: 'not_applied' }, 401);
        const status =
          error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
            ? error.status
            : error instanceof APIError
              ? error.statusCode
              : 503;
        const credentialRoute = new URL(request.url).pathname.startsWith('/passkeys/');
        return json(
          credentialRoute
            ? { error: 'credential_effect_denied', effect_status: 'not_applied' }
            : { error: 'authentication_denied' },
          status,
        );
      }
    },
  };
  return service;
}
