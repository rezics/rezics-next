import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import type { IdentityExpiry } from './identity-expiry.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { AccessUnavailableError, throwAccessUnavailable } from './unavailable.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation, type JWTPayload } from 'jose';
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
  durableTime?: AuthoritativeTime;
  durableAction?: string;
};
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuid}$`);
const requestedByPattern = new RegExp(`^urn:rezics:request:(${uuid}):(${uuid})$`);
const routeOf = (id: string) => Number.parseInt(id.slice(24, 28), 16);
const invalid = () => new AuthenticationError(401, 'Bearer error="invalid_token"');

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

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
  const deadlines = new AsyncLocalStorage<number>();
  let verifier: { config: AuthenticationConfig; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;
  function resolveVerifier() {
    if (!verifier) {
      const config = settings(configuration);
      const transport = config.fetch ?? globalThis.fetch;
      const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
        cacheMaxAge: 300_000,
        cooldownDuration: 0,
        timeoutDuration: 2000,
        [customFetch]: async (url, init) => {
          const deadline = deadlines.getStore();
          if (deadline === undefined) throw invalid();
          return within(deadline, () =>
            transport(url, {
              ...init,
              signal: AbortSignal.any([init.signal, AbortSignal.timeout(remaining(deadline))]),
            }),
          );
        },
      });
      verifier = { config, keys };
    }
    return verifier;
  }

  const authenticate: Access['authenticate'] = async (token, context) => {
    try {
      remaining(context.deadline);
      const { config, keys } = resolveVerifier();
      const at = new Date();
      const { payload, protectedHeader } = await within(context.deadline, () =>
        deadlines.run(context.deadline, () =>
          jwtVerify(token, keys, {
            currentDate: at,
            issuer: config.issuer,
            audience: config.audience,
            algorithms: ['ES256'],
            typ: 'at+jwt',
            requiredClaims: [
              'iss',
              'aud',
              'sub',
              'client_id',
              'scope',
              'authn_epoch',
              'iat',
              'exp',
              'auth_time',
              'amr',
            ],
          }),
        ),
      );
      if (protectedHeader.typ !== 'at+jwt' || typeof protectedHeader.kid !== 'string' || !protectedHeader.kid)
        throw invalid();
      claims(payload, config, at, scopeClaimLimit);
      const accountId = payload.sub!;
      const client = deadlineClient(context.pool, context.deadline);
      // Authentication keeps its single actor point read on the account anchor.
      const observedAt = Date.now();
      const account = await readAccount(client, routeOf(accountId), accountId);
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
        const assignment = await readAssignment(client, payload.requested_by as string, accountId, clock);
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
      });
      bindAccountRateIdentity(actor, { ...context, actor }, account, expires, clock, 'wall');
      return actor;
    } catch (error) {
      throwAccessUnavailable(error, context.deadline);
      if (error instanceof ProblemError && error.code === 'account_suspended') throw error;
      throw invalid();
    }
  };
  return {
    authenticate,
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
