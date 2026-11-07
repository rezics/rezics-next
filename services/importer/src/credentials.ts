import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_DEADLINE_MS,
  MAX_IMPORT_RESPONSE_BYTES,
  importCorrelationId,
  importNetworkCode,
  type ImportRequestDiagnostics,
} from './import-fetch.ts';

const KEY_LIMIT = 16 * 1024;
const REFRESH_EARLY_MS = 60_000;
const ASSERTION_LIFETIME_SECONDS = 60;

export const IMPORTER_SCOPES = [
  'subject:create',
  'subject:batch_write',
  'statement:propose',
  'source_fence:read',
  'media:import_from_url',
  'media:read_reservation',
] as const;

export const VNDB_IMPORTER_SCOPES = [...IMPORTER_SCOPES, 'source_statistic:write'] as const;

export type CredentialsObserver = {
  onAccountKey?(
    path: string,
    observation: { bytes: number; regularFile: boolean; mode: number; importedKey: CryptoKey },
  ): void;
};

export class CredentialInputError extends Error {
  constructor() {
    super('Invalid account-key credentials');
    this.name = 'CredentialInputError';
  }
}

export class CredentialDeniedError extends Error {
  constructor(
    readonly diagnostics?: Partial<ImportRequestDiagnostics>,
    cause?: unknown,
  ) {
    super('Account-key sign-in was denied', { cause });
    this.name = 'CredentialDeniedError';
  }
}

export class CredentialServiceError extends Error {
  constructor(
    readonly diagnostics?: Partial<ImportRequestDiagnostics>,
    cause?: unknown,
  ) {
    super('Credential service request failed', { cause });
    this.name = 'CredentialServiceError';
  }
}

type AccountKey = { key: CryptoKey; kid: string };

function inputFailure(): never {
  throw new CredentialInputError();
}

function base64url(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64url');
}

async function readAccountKey(path: string, observer?: CredentialsObserver): Promise<AccountKey> {
  let handle;
  try {
    // Do not wait for a FIFO writer before checking the opened descriptor's file type.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    inputFailure();
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o400) === 0 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= 0 ||
      stat.size > KEY_LIMIT
    )
      inputFailure();
    const bytes = new Uint8Array(KEY_LIMIT + 1);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (result.bytesRead > KEY_LIMIT || (await handle.stat()).size !== stat.size) inputFailure();
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead)));
    } catch {
      inputFailure();
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Reflect.get(value, 'kty') !== 'EC' ||
      Reflect.get(value, 'crv') !== 'P-256' ||
      Reflect.get(value, 'alg') !== 'ES256' ||
      typeof Reflect.get(value, 'kid') !== 'string' ||
      !Reflect.get(value, 'kid') ||
      typeof Reflect.get(value, 'd') !== 'string'
    )
      inputFailure();
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('jwk', value as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
      ]);
    } catch {
      inputFailure();
    }
    observer?.onAccountKey?.(path, {
      bytes: result.bytesRead,
      regularFile: stat.isFile(),
      mode: stat.mode & 0o777,
      importedKey: key,
    });
    return { key, kid: Reflect.get(value, 'kid') as string };
  } catch (error) {
    if (error instanceof CredentialInputError) throw error;
    inputFailure();
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Native Auth is transport only; CSRF Origin and assertion audience stay on the issuer. */
export function accountKeyIssuerOrigin(
  authOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const native = env.REZICS_LOCAL_STACK_NATIVE_ORIGIN;
  const issuer = env.REZICS_LOCAL_STACK_ISSUER_ORIGIN;
  if (!native || !issuer) return authOrigin;
  try {
    if (new URL(authOrigin).origin !== new URL(native).origin) return authOrigin;
    return new URL(issuer).origin;
  } catch {
    return authOrigin;
  }
}

function assertion(account: string, issuerOrigin: string, accountKey: AccountKey, now: number): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const protectedValue = base64url(JSON.stringify({ alg: 'ES256', kid: accountKey.kid }));
  const payload = base64url(
    JSON.stringify({
      iss: account,
      sub: account,
      aud: `${issuerOrigin}/token`,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      jti: randomUUID(),
    }),
  );
  const signingInput = `${protectedValue}.${payload}`;
  return crypto.subtle
    .sign({ name: 'ECDSA', hash: 'SHA-256' }, accountKey.key, Buffer.from(signingInput))
    .then((signature) => `${signingInput}.${base64url(new Uint8Array(signature))}`);
}

// Register before starting work, including fetch implementations that ignore abort.
function abortable<T>(signal: AbortSignal, work: () => Promise<T>, dispose?: (value: T) => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          if (signal.aborted) {
            dispose?.(value);
            reject(signal.reason);
          } else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
  });
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let result = new Uint8Array(0);
  let size = 0;
  try {
    for (;;) {
      const item = await abortable(signal, () => reader.read());
      if (item.done) break;
      const value = item.value;
      if (!(value instanceof Uint8Array) || value.buffer.byteLength > MAX_IMPORT_RESPONSE_BYTES)
        throw new CredentialServiceError();
      if (value.byteLength > MAX_IMPORT_RESPONSE_BYTES - size) throw new CredentialServiceError();
      if (size + value.byteLength > result.byteLength) {
        const next = new Uint8Array(
          Math.min(MAX_IMPORT_RESPONSE_BYTES, Math.max(size + value.byteLength, result.byteLength * 2, 64)),
        );
        next.set(result);
        result = next;
      }
      result.set(value, size);
      size += value.byteLength;
    }
    return result.subarray(0, size);
  } catch (error) {
    // Initiate disposal without waiting for an untrusted underlying cancel hook.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function cookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  const first = header?.split(';', 1)[0]?.trim();
  if (!first || first.length > 4096 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3a\x3c-\x7e]+$/.test(first))
    throw new CredentialServiceError();
  return first;
}

type AuthRequest = {
  fetch: typeof fetch;
  url: string;
  origin: string;
  body: string;
  cookie?: string;
  signal: AbortSignal | undefined;
};

function credentialDiagnostics(
  options: AuthRequest,
  phase: ImportRequestDiagnostics['phase'],
  response?: Response,
  code?: string,
): ImportRequestDiagnostics {
  const url = new URL(options.url);
  const correlationId = response ? importCorrelationId(response) : undefined;
  return {
    method: 'POST',
    origin: url.origin.slice(0, 256),
    path: url.pathname.slice(0, 512),
    phase,
    ...(response === undefined ? {} : { status: response.status }),
    ...(code === undefined ? {} : { code }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function credentialResponseDiagnostics(
  origin: string,
  path: '/signin/key' | '/token',
  response: Response,
): ImportRequestDiagnostics {
  const correlationId = importCorrelationId(response);
  return {
    method: 'POST',
    origin: new URL(origin).origin.slice(0, 256),
    path,
    phase: 'response',
    status: response.status,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

function publicProblemCode(bytes: Uint8Array): string | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof Reflect.get(value, 'code') === 'string' &&
      /^[a-z0-9_-]{1,80}$/.test(Reflect.get(value, 'code') as string)
    )
      return Reflect.get(value, 'code') as string;
  } catch {
    // Error bodies are diagnostic input only; malformed text is never retained or printed.
  }
  return undefined;
}

async function authRequest(options: AuthRequest): Promise<{ response: Response; bytes: Uint8Array }> {
  if (Buffer.byteLength(options.body) > MAX_IMPORT_BODY_BYTES) throw new CredentialServiceError();
  const controller = new AbortController();
  const aborted = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Credential request deadline exceeded', 'TimeoutError')),
    MAX_IMPORT_DEADLINE_MS,
  );
  let phase: ImportRequestDiagnostics['phase'] = 'network';
  let response: Response | undefined;
  try {
    const headers = new Headers({ 'content-type': 'application/json', origin: options.origin });
    if (options.cookie) headers.set('cookie', options.cookie);
    response = await abortable(
      controller.signal,
      () =>
        options.fetch(
          new Request(options.url, {
            method: 'POST',
            headers,
            body: options.body,
            redirect: 'manual',
            signal: controller.signal,
          }),
        ),
      // A late result from an abort-ignoring fetch still belongs to this request.
      (response) => {
        void response.body?.cancel().catch(() => {});
      },
    );
    phase = 'response';
    const bytes = await responseBytes(response, controller.signal);
    controller.signal.throwIfAborted();
    const code = publicProblemCode(bytes);
    if (response.status === 401 || response.status === 403)
      throw new CredentialDeniedError(credentialDiagnostics(options, 'http', response, code));
    if (!response.ok) throw new CredentialServiceError(credentialDiagnostics(options, 'http', response, code));
    return { response, bytes };
  } catch (error) {
    controller.abort();
    if (error instanceof CredentialDeniedError || error instanceof CredentialInputError) throw error;
    if (error instanceof CredentialServiceError) {
      if (error.diagnostics) throw error;
      throw new CredentialServiceError(credentialDiagnostics(options, response ? 'response' : phase, response), error);
    }
    const failurePhase = controller.signal.aborted && !options.signal?.aborted ? 'deadline' : phase;
    const diagnostics = credentialDiagnostics(options, failurePhase, response);
    const networkCode = failurePhase === 'network' ? importNetworkCode(error) : undefined;
    throw new CredentialServiceError({ ...diagnostics, ...(networkCode === undefined ? {} : { networkCode }) }, error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', aborted);
  }
}

export type AccountCredentialsOptions = {
  accountKeyPath: string;
  account: string;
  client: string;
  authOrigin: string;
  /** CSRF Origin and assertion audience; walk stacks keep this on the issuer while posting to native Auth. */
  issuerOrigin?: string;
  scopes?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  observer?: CredentialsObserver;
  signal?: AbortSignal;
};

export type AccountTokenProvider = (fresh?: boolean) => Promise<string>;

export async function createAccountTokenProvider(options: AccountCredentialsOptions): Promise<AccountTokenProvider> {
  const accountKey = await readAccountKey(options.accountKeyPath, options.observer);
  const upstream = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const issuerOrigin = accountKeyIssuerOrigin(options.authOrigin, process.env, options.issuerOrigin);
  let accessToken: string | undefined;
  let expiresAt = 0;
  let renewing: Promise<string> | undefined;

  const ensureActive = () => {
    if (options.signal?.aborted) {
      accessToken = undefined;
      expiresAt = 0;
      throw new CredentialServiceError();
    }
  };

  const renew = async (): Promise<string> => {
    ensureActive();
    const signed = await assertion(options.account, issuerOrigin, accountKey, now());
    const signin = await authRequest({
      fetch: upstream,
      url: `${options.authOrigin}/signin/key`,
      origin: issuerOrigin,
      signal: options.signal,
      body: JSON.stringify({
        account_id: options.account,
        client_id: options.client,
        scope: [...(options.scopes ?? IMPORTER_SCOPES)],
        assertion: signed,
      }),
    });
    let session: string;
    try {
      session = cookie(signin.response);
    } catch (error) {
      throw new CredentialServiceError(
        credentialResponseDiagnostics(options.authOrigin, '/signin/key', signin.response),
        error,
      );
    }
    const token = await authRequest({
      fetch: upstream,
      url: `${options.authOrigin}/token`,
      origin: issuerOrigin,
      signal: options.signal,
      body: '{}',
      cookie: session,
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(token.bytes));
    } catch (error) {
      throw new CredentialServiceError(
        credentialResponseDiagnostics(options.authOrigin, '/token', token.response),
        error,
      );
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      typeof Reflect.get(value, 'access_token') !== 'string' ||
      !Reflect.get(value, 'access_token') ||
      Reflect.get(value, 'token_type') !== 'Bearer' ||
      !Number.isSafeInteger(Reflect.get(value, 'expires_in')) ||
      (Reflect.get(value, 'expires_in') as number) <= 0
    )
      throw new CredentialServiceError(credentialResponseDiagnostics(options.authOrigin, '/token', token.response));
    expiresAt = now() + (Reflect.get(value, 'expires_in') as number) * 1000;
    ensureActive();
    accessToken = Reflect.get(value, 'access_token') as string;
    return accessToken;
  };

  return async (fresh?: boolean) => {
    ensureActive();
    if (!fresh && accessToken !== undefined && now() < expiresAt - REFRESH_EARLY_MS) {
      ensureActive();
      return accessToken;
    }
    if (!renewing) renewing = renew().finally(() => (renewing = undefined));
    const token = await renewing;
    ensureActive();
    return token;
  };
}
