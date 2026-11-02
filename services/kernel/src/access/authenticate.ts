import {
  accessNativeWork,
  accessCheckout,
  addAccessWork,
  EMPTY_ACCESS_WORK,
  type AccessWork,
  type AccessWorkAccounting,
} from './work.ts';
import { readNativePermissionAccount } from './account-authority.ts';
import { mintReadTime, authoritativeTimeValue } from '../command/command.ts';
import timeRead from './permission-time.sql';
import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { identityExpired, type IdentityExpiry } from './identity-expiry.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { AccessUnavailableError, throwAccessUnavailable } from './unavailable.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type FetchImplementation, type JWTPayload } from 'jose';
import { withConnection } from '../database/pool.ts';
import type { QueryConfig } from 'pg';
import {
  AuthenticationError,
  type Access,
  type AccessClient,
  type AccessContext,
  type AccountActor,
} from '../request/access.ts';
import { consumeDurableIdentity, type DurableIdentity } from './durable-identity.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { approvedIdentityClaims, type ApprovedIdentity } from './approved-identity.ts';
import { readAccount, type Account } from './account-data.ts';
import { readAssignment } from './delegation-commands.ts';
import { bindAccountRateIdentity, stageDurableRateIdentity } from './write-rate-identity.ts';
import { ProblemError } from '../http/problem.ts';
import {
  AUTHENTICATION_JWKS_LIMITS,
  authenticationVerificationWorkBound,
  installOriginalAuthenticator,
  runOriginalAuthentication,
  type OriginalAuthenticationInvocation,
} from './authentication-work.ts';

export type AuthenticationConfig = {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Public JWKS transport only. No credential, token or private key is passed. */
  fetch?: FetchImplementation;
};

type Identity = IdentityExpiry & {
  account: Account;
  pool: AccessContext['pool'];
  deadline: number;
  observedAt: number;
  requestContext?: AccessContext;
  requestWork?: AccessContext['work'];
  requestTime?: AuthoritativeTime;
  durableTime?: AuthoritativeTime;
  durableAction?: string;
};
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`);
const requestedByPattern = new RegExp(`^urn:rezics:request:(${uuid}):(${uuid})$`);
const routeOf = (id: string) => Number.parseInt(id.slice(24, 28), 16);
const invalid = () => new AuthenticationError(401, 'Bearer error="invalid_token"');

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

type AuthenticationMetrics = {
  jwksFetches: number;
  fetchedKeyCounts: number[];
  scannedKeys: number;
  jwksUsage: AccessWork;
};
type AuthenticationInvocation = Readonly<{
  token: string;
  pool: AccessContext['pool'];
  deadline: number;
  work?: AccessWorkAccounting;
  metrics: AuthenticationMetrics;
}>;

function authenticationMetrics(): AuthenticationMetrics {
  return { jwksFetches: 0, fetchedKeyCounts: [], scannedKeys: 0, jwksUsage: EMPTY_ACCESS_WORK };
}

/** Read only a bounded public JWKS response; keep JOSE's own parser and key selection authoritative. */
async function boundedJwksResponse(
  response: Response,
  deadline: number,
): Promise<Readonly<{ response: Response; bytes: number; keys: number }>> {
  if (response.status !== 200 || response.body === null) return { response, bytes: 0, keys: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await within(deadline, () => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > AUTHENTICATION_JWKS_LIMITS.responseBytes) {
        await within(deadline, () => reader.cancel());
        throw new TypeError('JWKS response exceeds the supported byte limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await within(deadline, () => reader.cancel());
    } catch {
      // Preserve the first read, size or deadline failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  const keys =
    typeof parsed === 'object' && parsed !== null && 'keys' in parsed && Array.isArray(parsed.keys)
      ? parsed.keys.length
      : 0;
  if (keys > AUTHENTICATION_JWKS_LIMITS.keys)
    throw new TypeError(`JWKS contains more than ${AUTHENTICATION_JWKS_LIMITS.keys} supported keys`);
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    bytes: size,
    keys,
  };
}

function remaining(deadline: number): number {
  if (!Number.isFinite(deadline)) throw invalid();
  if (Date.now() >= deadline) throw new AccessUnavailableError('deadline');
  return Math.max(1, Math.floor(deadline - Date.now()));
}

/** Also bounds pool queueing and transports that do not honor AbortSignal. */
export async function within<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const ms = remaining(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AccessUnavailableError('deadline')), ms);
      }),
    ]);
    remaining(deadline);
    return result;
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Preserve pg's decoding capabilities when wrapping reylo's query transport. */
export function deadlineClient(client: AccessClient, deadline: number): AccessClient {
  const bounded = Object.create(client) as AccessClient;
  bounded.query = ((query: QueryConfig | string, values?: unknown[]) => {
    const config = {
      ...(typeof query === 'string' ? { text: query, values: values ?? [] } : query),
      query_timeout: remaining(deadline),
    };
    return within(deadline, () => client.query(config));
  }) as AccessClient['query'];
  return bounded;
}

function settings(config?: AuthenticationConfig): AuthenticationConfig {
  const value = config ?? {
    issuer: process.env.AUTH_ISSUER ?? '',
    audience: process.env.AUTH_AUDIENCE ?? '',
    jwksUrl: process.env.AUTH_JWKS_URL ?? '',
  };
  const issuer = new URL(value.issuer);
  const audience = new URL(value.audience);
  const jwks = new URL(value.jwksUrl);
  const localHttp = issuer.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname);
  if (
    (issuer.protocol !== 'https:' && !localHttp) ||
    issuer.origin !== value.issuer ||
    audience.protocol !== 'https:' ||
    audience.username ||
    audience.password ||
    audience.hash ||
    jwks.protocol !== issuer.protocol ||
    jwks.origin !== issuer.origin ||
    jwks.href !== value.jwksUrl ||
    jwks.username ||
    jwks.password ||
    /[?#]/.test(value.jwksUrl)
  )
    throw invalid();
  return { ...value };
}

function claims(payload: JWTPayload, config: AuthenticationConfig, at: Date, scopeClaimLimit: number): void {
  const now = Math.floor(at.getTime() / 1000);
  if (
    payload.iss !== config.issuer ||
    payload.aud !== config.audience ||
    typeof payload.sub !== 'string' ||
    payload.sub.length !== 36 ||
    !uuidPattern.test(payload.sub) ||
    typeof payload.client_id !== 'string' ||
    !payload.client_id ||
    payload.client_id.length > 1024 ||
    typeof payload.scope !== 'string' ||
    payload.scope.length > scopeClaimLimit ||
    (payload.scope !== '' &&
      (payload.scope.split(' ').length > MAX_CONSENTED_SCOPES ||
        payload.scope.split(' ').some((scope) => !scope || scope.length > 128 || !scopePattern.test(scope)))) ||
    !Number.isSafeInteger(payload.authn_epoch) ||
    (payload.authn_epoch as number) <= 0 ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat! <= 0 ||
    payload.iat! > now ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp! <= now ||
    payload.exp! <= payload.iat! ||
    payload.exp! - payload.iat! > 300 ||
    !Number.isSafeInteger(payload.auth_time) ||
    (payload.auth_time as number) < 0 ||
    (payload.auth_time as number) > payload.iat! ||
    !Array.isArray(payload.amr) ||
    !payload.amr.length ||
    payload.amr.length > 100 ||
    payload.amr.some(
      (method) => typeof method !== 'string' || !method || method.length > 128 || !scopePattern.test(method),
    ) ||
    Object.hasOwn(payload, 'act')
  )
    throw invalid();
}

/** Each factory owns its key cache and its opaque, immutable request identities. */
export function createAuthenticator(configuration?: AuthenticationConfig, clock: KernelClock = systemClock) {
  const scopeClaimLimit = MAX_CONSENTED_SCOPE_OCTETS;
  const approvalScope = Object.freeze({});
  const durableScope = Object.freeze({});
  const identities = new WeakMap<AccountActor, Identity>();
  const calls = new AsyncLocalStorage<AuthenticationInvocation>();
  let verifier:
    | {
        config: AuthenticationConfig;
        keys: ReturnType<typeof createRemoteJWKSet>;
        resolveKey: ReturnType<typeof createRemoteJWKSet>;
      }
    | undefined;
  function resolveVerifier() {
    if (!verifier) {
      const config = settings(configuration);
      const transport = config.fetch ?? globalThis.fetch;
      const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
        cacheMaxAge: AUTHENTICATION_JWKS_LIMITS.cacheMilliseconds,
        cooldownDuration: AUTHENTICATION_JWKS_LIMITS.cooldownMilliseconds,
        timeoutDuration: AUTHENTICATION_JWKS_LIMITS.timeoutMilliseconds,
        [customFetch]: async (url, init) => {
          const invocation = calls.getStore();
          if (!invocation) throw invalid();
          const stats = { bytes: 0, keys: 0 };
          const dispatch = async () => {
            invocation.metrics.jwksFetches++;
            const response = await within(invocation.deadline, () =>
              transport(url, {
                ...init,
                signal: AbortSignal.any([init.signal, AbortSignal.timeout(remaining(invocation.deadline))]),
              }),
            );
            const bounded = await boundedJwksResponse(response, invocation.deadline);
            stats.bytes = bounded.bytes;
            stats.keys = bounded.keys;
            invocation.metrics.fetchedKeyCounts.push(bounded.keys);
            invocation.metrics.jwksUsage = addAccessWork(invocation.metrics.jwksUsage, {
              keys: 0,
              points: 1,
              witnesses: 0,
              rows: bounded.keys,
              bytes: bounded.bytes,
              emptySeeks: 0,
            });
            return bounded.response;
          };
          if (!invocation.work) return dispatch();
          return invocation.work.run(
            'access.authentication.jwks-fetch',
            {
              keys: 0,
              points: 1,
              witnesses: 0,
              rows: AUTHENTICATION_JWKS_LIMITS.keys,
              bytes: AUTHENTICATION_JWKS_LIMITS.responseBytes,
              emptySeeks: 0,
            },
            dispatch,
            () => ({
              keys: 0,
              points: 1,
              witnesses: 0,
              rows: stats.keys,
              bytes: stats.bytes,
              emptySeeks: 0,
            }),
            'owner',
            invocation.deadline,
          );
        },
      });
      let cachedKeyCount = 0;
      const resolveKey = Object.defineProperties(
        async (...args: Parameters<typeof keys>) => {
          const invocation = calls.getStore();
          if (!invocation) throw invalid();
          const wasFresh = keys.fresh;
          const before = keys.jwks();
          const previousKeyCount = before?.keys.length ?? cachedKeyCount;
          const headerKid = args[0]?.kid;
          const matchedCachedKey =
            typeof headerKid === 'string' && before?.keys.some((candidate) => candidate.kid === headerKid) === true;
          const fetchStart = invocation.metrics.jwksFetches;
          const setStart = invocation.metrics.fetchedKeyCounts.length;
          const receivedCounts = () => invocation.metrics.fetchedKeyCounts.slice(setStart);
          const fetchCount = () => invocation.metrics.jwksFetches - fetchStart;
          const currentKeyCount = () => keys.jwks()?.keys.length ?? cachedKeyCount;
          const setCachedCount = (fallback: number) => {
            cachedKeyCount = currentKeyCount() || fallback;
          };
          try {
            const key = await keys(...args);
            const after = receivedCounts();
            const fetched = fetchCount();
            const current = currentKeyCount();
            const scans = wasFresh
              ? previousKeyCount + (!matchedCachedKey ? current : 0)
              : fetched >= 2
                ? (after[0] ?? previousKeyCount) + (after[1] ?? after.at(-1) ?? current)
                : (after[0] ?? current);
            invocation.metrics.scannedKeys += scans;
            setCachedCount(after.at(-1) ?? current);
            return key;
          } catch (error) {
            const after = receivedCounts();
            const fetched = fetchCount();
            const current = currentKeyCount();
            let scans = 0;
            if (error instanceof errors.JWKSNoMatchingKey) {
              if (wasFresh) scans = previousKeyCount + (after.at(-1) ?? current);
              else if (fetched >= 2) scans = (after[0] ?? previousKeyCount) + (after[1] ?? after.at(-1) ?? current);
              else if (fetched === 1) scans = (after[0] ?? current) + current;
              else scans = current * 2;
              setCachedCount(after.at(-1) ?? current);
            } else if (error instanceof errors.JWKSMultipleMatchingKeys) {
              scans = wasFresh ? previousKeyCount : (after[0] ?? current);
              setCachedCount(after.at(-1) ?? current);
            } else if (wasFresh) {
              // A fresh local set is selected before any optional no-match reload.
              scans = previousKeyCount + (fetched >= 1 && keys.fresh && !matchedCachedKey ? current : 0);
              setCachedCount(after.at(-1) ?? current);
            } else if (keys.fresh) {
              scans = fetched >= 2 ? (after[0] ?? current) + (after[1] ?? current) : (after[0] ?? current);
              setCachedCount(after.at(-1) ?? current);
            }
            invocation.metrics.scannedKeys += scans;
            throw error;
          }
        },
        {
          coolingDown: { get: () => keys.coolingDown },
          fresh: { get: () => keys.fresh },
          reload: { value: keys.reload },
          reloading: { get: () => keys.reloading },
          jwks: { value: keys.jwks },
        },
      ) as typeof keys;
      verifier = { config, keys, resolveKey };
    }
    return verifier;
  }

  const authenticateCurrent = async (token: string, context: AccessContext): Promise<AccountActor> => {
    try {
      remaining(context.deadline);
      const { config, resolveKey } = resolveVerifier();
      const at = new Date();
      const verify = () =>
        jwtVerify(token, resolveKey, {
          currentDate: at,
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ['ES256'],
          typ: 'at+jwt',
          requiredClaims: ['iss', 'aud', 'sub', 'client_id', 'scope', 'authn_epoch', 'iat', 'exp', 'auth_time', 'amr'],
        });
      let verified: Awaited<ReturnType<typeof jwtVerify>>;
      if (!context.work) verified = await within(context.deadline, verify);
      else {
        const invocation = calls.getStore();
        if (!invocation) return context.work.unavailable('Auth ES256 verification invocation binding');
        if (
          invocation.token !== token ||
          invocation.pool !== context.pool ||
          invocation.deadline !== context.deadline ||
          invocation.work !== context.work
        )
          return context.work.unavailable('Auth ES256 verification invocation binding');
        const metrics = invocation.metrics;
        const outcome = await context.work.run(
          'access.authentication.jose-verify',
          authenticationVerificationWorkBound(token),
          async () => {
            try {
              return { state: 'verified' as const, value: await within(context.deadline, verify) };
            } catch (error) {
              if (error instanceof AccessUnavailableError) throw error;
              return { state: 'invalid' as const, error };
            }
          },
          (result) =>
            result.state === 'verified' || result.state === 'invalid'
              ? addAccessWork(
                  {
                    keys: metrics.scannedKeys,
                    points: 1,
                    witnesses: 0,
                    rows: 0,
                    bytes: Buffer.byteLength(token, 'utf8'),
                    emptySeeks: 0,
                  },
                  metrics.jwksUsage,
                )
              : undefined,
          'owner',
          context.deadline,
        );
        if (outcome.state === 'invalid') throw outcome.error;
        verified = outcome.value;
      }
      const { payload, protectedHeader } = verified;
      if (protectedHeader.typ !== 'at+jwt' || typeof protectedHeader.kid !== 'string' || !protectedHeader.kid)
        throw invalid();
      claims(payload, config, at, scopeClaimLimit);
      const accountId = payload.sub!;
      const client = deadlineClient(context.pool, context.deadline);
      // Authentication keeps its single actor point read on the account anchor.
      const observedAt = Date.now();
      const account = await accessCheckout(context.work, () =>
        readAccount(client, routeOf(accountId), accountId, context.work),
      );
      if (
        !account ||
        account.accountId !== accountId ||
        account.route !== routeOf(accountId) ||
        account.kind !== 'actor' ||
        (account.state !== 'active' && account.state !== 'suspended') ||
        account.fenced !== false ||
        BigInt(payload.authn_epoch as number) < account.minimumAuthnEpoch
      )
        throw invalid();
      let requestedBy: string | null = null;
      if (Object.hasOwn(payload, 'requested_by')) {
        const request = typeof payload.requested_by === 'string' ? requestedByPattern.exec(payload.requested_by) : null;
        if (!request || request[0] !== payload.requested_by) throw invalid();
        const assignment = await accessCheckout(context.work, () =>
          readAssignment(client, payload.requested_by as string, accountId, clock, context.work),
        );
        if (assignment.kind !== 'resolved') throw invalid();
        requestedBy = payload.requested_by as string;
      }
      const expires = payload.exp! * 1000;
      remaining(context.deadline);
      if (new Date().getTime() >= expires) throw invalid();
      if (account.state === 'suspended') throw new ProblemError('account_suspended');
      const actor: AccountActor = Object.freeze({
        kind: 'account',
        accountId,
        clientId: payload.client_id as string,
        scopes: Object.freeze(payload.scope ? (payload.scope as string).split(' ') : []),
        requestedBy,
        authnEpoch: payload.authn_epoch as number,
      });
      identities.set(actor, {
        account: Object.freeze(account),
        pool: context.pool,
        deadline: context.deadline,
        expires,
        expiryClock: 'wall',
        observedAt,
        requestContext: context,
        ...(context.work ? { requestWork: context.work } : {}),
        ...(context.time ? { requestTime: context.time } : {}),
      });
      bindAccountRateIdentity(actor, { ...context, actor }, account, expires, clock, 'wall');
      return actor;
    } catch (error) {
      throwAccessUnavailable(error, context.deadline);
      if (error instanceof ProblemError && error.code === 'account_suspended') throw error;
      throw invalid();
    }
  };
  const authenticate: Access['authenticate'] = async (token, context: AccessContext) => {
    if (!context.work) {
      const invocation: AuthenticationInvocation = {
        token,
        pool: context.pool,
        deadline: context.deadline,
        metrics: authenticationMetrics(),
      };
      return calls.run(invocation, () => authenticateCurrent(token, context));
    }
    const invocation: OriginalAuthenticationInvocation & { metrics: AuthenticationMetrics } = {
      token,
      pool: context.pool,
      deadline: context.deadline,
      work: context.work,
      metrics: authenticationMetrics(),
    };
    try {
      const result = await runOriginalAuthentication(authenticate, invocation, () =>
        calls.run(invocation, async () => {
          try {
            return { state: 'actor' as const, actor: await authenticateCurrent(token, context) };
          } catch (error) {
            if (
              error instanceof AuthenticationError ||
              (error instanceof ProblemError && error.code === 'account_suspended')
            )
              return { state: 'denied' as const, error };
            throw error;
          }
        }),
      );
      if (result.value.state === 'denied') throw result.value.error;
      return result.value.actor;
    } catch (error) {
      throwAccessUnavailable(error, context.deadline);
      if (error instanceof ProblemError && error.code === 'account_suspended') throw error;
      throw invalid();
    }
  };
  installOriginalAuthenticator(authenticate);
  return {
    authenticate,
    /** Refresh only an identity already verified by THIS authenticator/pool.
     * No cryptography or key-fetch callback is treated as zero work. */
    async refresh(actor: AccountActor, context: AccessContext): Promise<boolean> {
      const proof = identities.get(actor);
      if (!proof || proof.pool !== context.pool || !context.work) return false;
      const deadline = Math.min(context.deadline, proof.deadline);
      try {
        remaining(deadline);
        const time = context.time;
        if (!time) return context.work.unavailable('Auth native account refresh requires a live AuthoritativeTime');
        authoritativeTimeValue(time);
        if (identityExpired(proof, clock)) return false;
        const current = await within(deadline, () =>
          readNativePermissionAccount(deadlineClient(context.pool, deadline), actor.accountId, context.work!),
        );
        remaining(deadline);
        authoritativeTimeValue(time);
        return (
          !identityExpired(proof, clock) &&
          !!current &&
          current.kind === 'actor' &&
          current.state === 'active' &&
          !current.fenced &&
          Number.isSafeInteger(actor.authnEpoch) &&
          actor.authnEpoch > 0 &&
          BigInt(actor.authnEpoch) >= current.minimumAuthnEpoch &&
          current.operatorAccountId === proof.account.operatorAccountId
        );
      } catch (error) {
        context.work.fail(error);
        throw error;
      }
    },
    approvalScope,
    durableScope,
    /** Private operation proof, not a row/Actor registration API. */
    async restoreDurable(
      proof: DurableIdentity,
      context: AccessContext,
      time: AuthoritativeTime,
    ): Promise<AccountActor> {
      const facts = consumeDurableIdentity(proof, durableScope, context, time);
      if (!facts) throw invalid();
      const { actor, account, deadline } = facts;
      remaining(deadline);
      identities.set(actor, {
        account,
        pool: context.pool,
        deadline,
        expires: Infinity,
        expiryClock: 'kernel',
        observedAt: Date.now(),
        durableTime: time,
        durableAction: facts.action,
      });
      stageDurableRateIdentity(actor, { pool: context.pool, actor, deadline }, account, time);
      return actor;
    },
    discardDurable(actor: AccountActor): void {
      if (identities.get(actor)?.durableTime) identities.delete(actor);
    },
    /** Internal native approval proof only. Reconstructed actors have no proof. */
    async restoreApproval(proof: ApprovedIdentity, context: AccessContext): Promise<AccountActor> {
      try {
        context.work?.unavailable('Auth approval restoration full account/assignment native work producer');
        const facts = approvedIdentityClaims(proof, approvalScope, context.pool);
        if (!facts) throw invalid();
        const { actor, expires } = facts;
        remaining(context.deadline);
        if (clock().getTime() >= expires) throw invalid();
        const client = deadlineClient(context.pool, context.deadline);
        const observedAt = Date.now();
        const account = await readAccount(client, routeOf(actor.accountId), actor.accountId);
        if (
          !account ||
          account.kind !== 'actor' ||
          account.state !== 'active' ||
          account.fenced ||
          !Number.isSafeInteger(actor.authnEpoch) ||
          actor.authnEpoch <= 0 ||
          BigInt(actor.authnEpoch) < account.minimumAuthnEpoch
        )
          throw invalid();
        if (
          actor.requestedBy !== null &&
          (await readAssignment(client, actor.requestedBy, actor.accountId, clock)).kind !== 'resolved'
        )
          throw invalid();
        remaining(context.deadline);
        if (clock().getTime() >= expires) throw invalid();
        identities.set(actor, {
          account: Object.freeze(account),
          pool: context.pool,
          deadline: context.deadline,
          expires,
          expiryClock: 'kernel',
          observedAt,
        });
        bindAccountRateIdentity(actor, { ...context, actor }, account, expires, clock, 'kernel');
        return actor;
      } catch (error) {
        throwAccessUnavailable(error, context.deadline);
        throw invalid();
      }
    },
    identity(actor: AccountActor): Identity | undefined {
      return identities.get(actor);
    },
  };
}

/** Native read time minted from this exact admitted SQL observation. Caller releases it. */
export async function readNativeAccessTime(
  context: AccessContext,
  clock?: KernelClock,
  instant?: string,
): Promise<AuthoritativeTime> {
  const input = { at: instant ?? clock?.().toISOString() ?? '' };
  const row = await within(context.deadline, () =>
    accessCheckout(context.work, () =>
      withConnection(context.pool, (client) =>
        accessNativeWork(context.work, 'time', input, {}, () =>
          timeRead.run(deadlineClient(client, context.deadline), input),
        ),
      ),
    ),
  ).catch((error: unknown) => {
    context.work?.fail(error);
    throw error;
  });
  if (!row) throw new AccessUnavailableError('overloaded');
  return mintReadTime({
    query: (async () => ({
      rows: [{ at: row.at }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    })) as AccessClient['query'],
  });
}
