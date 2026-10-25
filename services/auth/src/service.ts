import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { publicCredential, verifyKeyAssertion } from './key-credentials.ts';
import { betterAuthOptions, credentialOwnerSchema } from './better-auth.ts';
import { createSigner } from './signing.ts';
import { signSessionAccessToken } from './session-proof-capability.ts';
import { issuerOrigin } from './issuer.ts';
import { nativeAttemptRequest } from './rate-limit.ts';
import { nativeSessionLimits, pruneExpiredSessions, trimSessionHistory, sessionUpgradePage } from './session-limits.ts';
import { nativeVerificationPlugin, pruneExpiredVerifications } from './verification-maintenance.ts';
import { clientAuthority } from './account-workflows.ts';
import { createBarrierProofVerifier, type BarrierProof } from './barrier-proofs.ts';
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
const assignmentUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const assignmentReference = new RegExp(`^urn:rezics:request:(${assignmentUuid}):(${assignmentUuid})$`);
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
  const { trustedAccess } = options;
  const authority = clientAuthority(
    options.database,
    trustedAccess,
    () => {
      throw new Denied();
    },
    scopes,
  );
  const { database, withIssuance, materialize } = authority;
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
  const recoveryBinding = new AsyncLocalStorage<{ accountId: string; epoch: number }>();
  // Native router admission runs before this private alias dispatch hook. A
  // request cannot install it through a header, body or native endpoint name.
  const attemptDispatch = new AsyncLocalStorage<() => Promise<Response>>();
  const proofHash = (token: string) => createHash('sha256').update(token).digest('hex');

  const barrierProofs = createBarrierProofVerifier({ database });
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
  async function clientFor(clientId: string): Promise<Client> {
    const result = await database.query<Client>(
      'SELECT client_id, first_party, scopes FROM auth_client WHERE client_id=$1 AND EXISTS (SELECT 1 FROM auth_client_coverage v WHERE v.client_id=auth_client.client_id AND v.ready) AND NOT EXISTS (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=auth_client.client_id)',
      [clientId],
    );
    if (!result.rows[0]) throw new Denied();
    return result.rows[0];
  }
  async function allowed(accountId: string, selected: Binding): Promise<Client> {
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
    if (binding.getStore()) await materialize(accountId, selected.clientId, client.scopes, client.first_party);
    return client;
  }
  function nativeAuth() {
    return betterAuth({
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
            await (await getContext()).internalAdapter.deleteVerificationByIdentifier(`reset-password:${token}`);
            await database.query('DELETE FROM auth_recovery WHERE proof_hash=$1', [proofHash(token)]);
            throw error;
          }
        },
      },
      plugins: [
        credentialOwnerSchema,
        nativeVerificationPlugin,
        nativeSessionLimits(database),
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
      !['pwd', 'private_key_jwt', 'operator'].includes(session.authMethods)
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
    const scope = { proof: human, live: true };
    const receipt = await proofScope.run(scope, async () => {
      try {
        return await trustedAccess.consumeAuthorization!({
          authorization: text(input.authorization),
          subjectAccountId: input.subjectAccountId,
          purpose,
          human,
        });
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
        await binding.run(selected, () =>
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
      account.authnEpoch < 0
    )
      throw new Denied();
    return account;
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
            (idempotency_key,account_id,digest,registration_id,reservation_id,authn_epoch,expires_at,owner_id,credential_id,provisioning_kind)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
          account,
          receipt,
          email: null,
          hash: null,
          digest,
        });
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
            value.password.length < (await getContext()).password.config.minPasswordLength ||
            value.password.length > (await getContext()).password.config.maxPasswordLength
          )
            throw new Denied(400);
          hash = await (await getContext()).password.hash(value.password);
        } else if (value.kind === 'key') {
          text(value.kid);
          if (!value.remove) publicJwk = await publicCredential(value.publicJwk, value.kid);
        }
        const { receipt, subject, previousEpoch } = await consume(input, purpose);
        const oldPassword = await (await getContext()).internalAdapter.findCredentialAccount(subject.accountId);
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
          if (hash !== null) await (await getContext()).internalAdapter.updatePassword(subject.accountId, hash);
          else
            await (
              await getContext()
            ).adapter.update({
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
        if (destructive || receipt.invalidation)
          await (await getContext()).internalAdapter.deleteUserSessions(subject.accountId);
      },
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
      async registerClient(input) {
        const id = text(input.clientId);
        if (typeof input.firstParty !== 'boolean') throw new Denied(400);
        const granted = scopes(input.scopes);
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
          await connection.query(
            'INSERT INTO auth_client (client_id, first_party, scopes) VALUES ($1,$2,$3) ON CONFLICT (client_id) DO UPDATE SET first_party=EXCLUDED.first_party, scopes=EXCLUDED.scopes',
            [id, input.firstParty, granted],
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
      try {
        const url = new URL(request.url);
        if (url.origin !== options.issuer || url.search) throw new Denied(400);
        if (url.pathname === '/.well-known/jwks.json' && request.method === 'GET') return json(await signer.getJwks());
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
        const attemptPath = {
          '/signin': '/sign-in/email',
          '/signin/key': '/sign-in/email',
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
        if (url.pathname === '/recovery/start') {
          fields(body, ['account_id']);
          const account = await recoveryAccount(text(body.account_id));
          const user = await (await getContext()).internalAdapter.findUserById(account.accountId);
          if (!user?.email) throw new Denied();
          await recoveryBinding.run({ accountId: account.accountId, epoch: account.authnEpoch }, () =>
            getAuth().api.requestPasswordReset({ body: { email: user.email } }),
          );
          return json({ success: true });
        }
        if (url.pathname === '/recovery/complete') {
          fields(body, ['account_id', 'token', 'new_password']);
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
          const connection = await database.connect();
          const lock = `auth-recovery:${sourceHash}`;
          try {
            await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
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
            const credential = await (await getContext()).internalAdapter.findCredentialAccount(accountId);
            if (!credential) throw new Denied();
            let verificationId = source.consumed_verification_id;
            let sourceExpiry = source.expires_at;
            if (!source.consumed_operation) {
              if (source.authn_epoch !== account.authnEpoch) throw new Denied();
              // Resolve with the installed native token processing before touching
              // receipt data. Delete that exact native row and consume its Auth
              // epoch binding in the same transaction as the immutable receipt.
              const nativeProof = await (
                await getContext()
              ).internalAdapter.findVerificationValue(`reset-password:${token}`);
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
            const fingerprint = digestOf([credential.password, credential.updatedAt.toISOString()]);
            const evidence = [
              'recovery-v1',
              accountId,
              source.authn_epoch,
              sourceHash,
              verificationId,
              credential.id,
              fingerprint,
              'set-password',
              createHmac('sha256', options.secret)
                .update(JSON.stringify(['auth-recovery-password-v1', accountId, sourceHash, newPassword]))
                .digest('hex'),
            ];
            const proof = await publishBarrier(
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
            if (!(await barrierProofs.verify(proof.reference, proof))) throw new Denied();
            const receipt = await trustedAccess.authorizeRecovery!({
              accountId,
              proofEpoch: proof.previousEpoch,
              proofReference: proof.reference,
              operationKey,
            });
            invalidation(receipt, accountId, proof.previousEpoch);
            if ((await recoveryAccount(accountId)).authnEpoch !== receipt.minimumAuthnEpoch) throw new Denied();
            // The native token is already spent. Use the installed native password
            // hasher and bounded native session revocation, with a credential CAS,
            // so a lost acknowledgement can retry only this exact intended reset.
            const passwordHash = await (await getContext()).password.hash(newPassword);
            await connection.query('BEGIN');
            const current = (
              await connection.query('SELECT password,"updatedAt" FROM account WHERE id=$1 FOR UPDATE', [credential.id])
            ).rows[0];
            if (!current || digestOf([current.password, current.updatedAt.toISOString()]) !== fingerprint)
              throw new Denied();
            await connection.query('SELECT auth_revoke_sessions($1)', [accountId]);
            await connection.query('UPDATE account SET password=$2,"updatedAt"=statement_timestamp() WHERE id=$1', [
              credential.id,
              passwordHash,
            ]);
            await applyBarrier(connection, proof.reference, receipt, 'recovery');
            await connection.query('COMMIT');
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
            connection.release();
          }
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
          return await establish(selected, request.headers);
        }
        if (url.pathname === '/signin') {
          fields(body, ['email', 'account_id', 'password', 'client_id', 'scope']);
          if (body.account_id !== undefined) {
            if (body.email !== undefined) throw new Denied(400);
            const account = await activeActor(text(body.account_id));
            const password = text(body.password);
            if (password.length > (await getContext()).password.config.maxPasswordLength) throw new Denied(400);
            const credential = await (await getContext()).internalAdapter.findCredentialAccount(account.accountId);
            if (
              !credential?.password ||
              !(await (await getContext()).password.verify({ hash: credential.password, password }))
            )
              throw new Denied();
            return await establish(
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
          return await withIssuance(selected.clientId, async () => {
            const response = await binding.run(selected, () =>
              getAuth().api.signInEmail({
                headers: request.headers,
                body: { email: text(body.email), password: text(body.password) },
                asResponse: true,
              }),
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
              const created = await getAuth().api.getSession({ headers });
              if (created) await (await getContext()).internalAdapter.deleteSession(created.session.token);
              throw error;
            }
          });
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
          return await withIssuance(text(body.client_id), async () => {
            const native = await getAuth().api.getSession({
              headers: request.headers,
              query: { disableCookieCache: true, disableRefresh: true },
            });
            if (!native) throw new Denied();
            const session = native.session;
            const account = await activeActor(session.userId);
            if (account.automated) throw new Denied();
            const client = await clientFor(text(body.client_id));
            const granted = scopes(body.scope);
            if (client.first_party || granted.some((scope) => !client.scopes.includes(scope))) throw new Denied(400);
            const connection = await database.connect();
            const lock = `auth-consent:${account.accountId}:${client.client_id}`;
            let reducing = false;
            try {
              await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
              await connection.query('BEGIN');
              const previous = (
                await connection.query<{ scopes: string[]; revision: string }>(
                  'SELECT scopes,revision::text FROM auth_consent WHERE account_id=$1 AND client_id=$2 FOR UPDATE',
                  [account.accountId, client.client_id],
                )
              ).rows[0];
              reducing = !!previous?.scopes.some((scope) => !granted.includes(scope));
              if (reducing) {
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
                  client.client_id,
                  client.scopes,
                  previous!.revision,
                  previous!.scopes,
                  granted,
                ];
                const operationKey = digestOf(['auth-consent-v1', evidence]);
                // A current human SessionProof is mandatory for first publication.
                // A stale cookie can only resume a previously committed exact
                // transition whose native session and consent still match.
                const resuming = session.authnEpoch < account.authnEpoch;
                if (!resuming) {
                  const human = await humanProof(request.headers);
                  if (human.account_id !== account.accountId || human.authn_epoch !== account.authnEpoch)
                    throw new Denied();
                }
                const proof = await publishBarrier(
                  connection,
                  'consent-reduction',
                  account.accountId,
                  session.authnEpoch,
                  operationKey,
                  evidence,
                  session.expiresAt,
                  resuming,
                );
                await connection.query('COMMIT');
                if (!(await barrierProofs.verify(proof.reference, proof))) throw new Denied();
                const receipt = await trustedAccess.invalidateAccount({
                  accountId: account.accountId,
                  previousEpoch: proof.previousEpoch,
                  reason: 'consent-reduction',
                  proofReference: proof.reference,
                  operationKey,
                });
                invalidation(receipt, account.accountId, proof.previousEpoch);
                if ((await activeActor(account.accountId)).authnEpoch !== receipt.minimumAuthnEpoch) throw new Denied();
                await connection.query('BEGIN');
                if (
                  !(
                    await connection.query(
                      'UPDATE auth_consent SET scopes=$3 WHERE account_id=$1 AND client_id=$2 AND revision=$4 RETURNING account_id',
                      [account.accountId, client.client_id, granted, previous!.revision],
                    )
                  ).rowCount
                )
                  throw new Denied();
                await applyBarrier(connection, proof.reference, receipt, 'consent-reduction');
              } else {
                await humanProof(request.headers);
                await connection.query(
                  'INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3) ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes',
                  [account.accountId, client.client_id, granted],
                );
              }
              await connection.query('COMMIT');
            } catch (error) {
              await connection.query('ROLLBACK');
              throw error;
            } finally {
              await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
              connection.release();
            }
            if (reducing) await (await getContext()).internalAdapter.deleteUserSessions(account.accountId);
            return json({ client_id: client.client_id, scope: granted });
          });
        }
        fields(body, []);
        // Better Auth owns cookie clearing and deletion of its own persistent session.
        const response = await getAuth().handler(
          new Request(`${options.issuer}/api/auth/sign-out`, { method: 'POST', headers: request.headers, body: '{}' }),
        );
        return json({ success: response.ok }, response.status, response.headers.getSetCookie());
      } catch (error) {
        return json({ error: 'authentication_denied' }, error instanceof Denied ? error.status : 503);
      }
    },
  };
  return service;
}
