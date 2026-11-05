import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_RESPONSE_BYTES } from './import-fetch.ts';

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
  constructor() {
    super('Account-key sign-in was denied');
    this.name = 'CredentialDeniedError';
  }
}

export class CredentialServiceError extends Error {
  constructor() {
    super('Credential service request failed');
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

function assertion(account: string, authOrigin: string, accountKey: AccountKey, now: number): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const protectedValue = base64url(JSON.stringify({ alg: 'ES256', kid: accountKey.kid }));
  const payload = base64url(
    JSON.stringify({
      iss: account,
      sub: account,
      aud: `${authOrigin}/token`,
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
  try {
    const headers = new Headers({ 'content-type': 'application/json', origin: options.origin });
    if (options.cookie) headers.set('cookie', options.cookie);
    const response = await abortable(
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
    const bytes = await responseBytes(response, controller.signal);
    controller.signal.throwIfAborted();
    if (response.status === 401 || response.status === 403) throw new CredentialDeniedError();
    if (!response.ok) throw new CredentialServiceError();
    return { response, bytes };
  } catch (error) {
    controller.abort();
    if (
      error instanceof CredentialDeniedError ||
      error instanceof CredentialServiceError ||
      error instanceof CredentialInputError
    )
      throw error;
    throw new CredentialServiceError();
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
    const signed = await assertion(options.account, options.authOrigin, accountKey, now());
    const signin = await authRequest({
      fetch: upstream,
      url: `${options.authOrigin}/signin/key`,
      origin: options.authOrigin,
      signal: options.signal,
      body: JSON.stringify({
        account_id: options.account,
        client_id: options.client,
        scope: [...(options.scopes ?? IMPORTER_SCOPES)],
        assertion: signed,
      }),
    });
    const session = cookie(signin.response);
    const token = await authRequest({
      fetch: upstream,
      url: `${options.authOrigin}/token`,
      origin: options.authOrigin,
      signal: options.signal,
      body: '{}',
      cookie: session,
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(token.bytes));
    } catch {
      throw new CredentialServiceError();
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
      throw new CredentialServiceError();
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
