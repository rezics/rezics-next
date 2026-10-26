import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { resolve } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli, type ImportCliObserver } from '../src/cli.ts';
import { IMPORTER_SCOPES } from '../src/credentials.ts';
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_RESPONSE_BYTES } from '../src/import-fetch.ts';
import type {
  ApiRequestObservation,
  AuthRequestObservation,
  CreateImportCliCredentialsDriver,
  HttpPolicy,
  ImportCliCredentialsDriver,
  ImportCliCredentialsExecution,
} from '../../../specs/imports-cli-credentials-driver.ts';

const policy: HttpPolicy = {
  timeoutMs: MAX_IMPORT_DEADLINE_MS,
  requestLimitBytes: MAX_IMPORT_BODY_BYTES,
  responseLimitBytes: MAX_IMPORT_RESPONSE_BYTES,
};

function bytes(value: string): number {
  return Buffer.byteLength(value);
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cookie(response: Response): string | null {
  return response.headers.get('set-cookie')?.split(';', 1)[0]?.trim() ?? null;
}

function validAssertion(
  compact: unknown,
  publicJwk: JsonWebKey,
  account: string,
  authOrigin: string,
  atMs: number,
): boolean {
  if (typeof compact !== 'string') return false;
  try {
    const parts = compact.split('.');
    if (parts.length !== 3) return false;
    const [protectedValue, payloadValue, signature] = parts as [string, string, string];
    const header = json(Buffer.from(protectedValue, 'base64url').toString());
    const claims = json(Buffer.from(payloadValue, 'base64url').toString());
    if (
      typeof header !== 'object' ||
      header === null ||
      Reflect.get(header, 'alg') !== 'ES256' ||
      Reflect.get(header, 'kid') !== Reflect.get(publicJwk, 'kid') ||
      typeof claims !== 'object' ||
      claims === null ||
      Reflect.get(claims, 'iss') !== account ||
      Reflect.get(claims, 'sub') !== account ||
      Reflect.get(claims, 'aud') !== `${authOrigin}/token` ||
      Reflect.get(claims, 'iat') !== Math.floor(atMs / 1000) ||
      typeof Reflect.get(claims, 'exp') !== 'number' ||
      (Reflect.get(claims, 'exp') as number) <= Math.floor(atMs / 1000)
    )
      return false;
    return verify(
      'sha256',
      Buffer.from(`${protectedValue}.${payloadValue}`),
      { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export const createImportCliCredentialsDriver: CreateImportCliCredentialsDriver = async (options) => {
  let closed = false;
  let revoked = false;
  let sequence = 0;
  const active = new Set<Promise<unknown>>();
  const subjects = new Map<string, string>();
  const api: ImportCliCredentialsDriver['api'] = {};

  return {
    auth: {
      revokeAccountKey() {
        revoked = true;
      },
    },
    api,
    async invoke(argv, boundaries = {}) {
      if (closed) throw new Error('CLI credentials driver is closed');
      const startedAtMs = options.clock.now();
      const authRequests: AuthRequestObservation[] = [];
      const apiRequests: ApiRequestObservation[] = [];
      const accessTokens: string[] = [];
      const sessionCookies: string[] = [];
      const sessions = new Set<string>();
      const issued = new Map<string, number>();
      let key = {
        fileReadCount: 0,
        regularFile: false,
        mode: 0,
        importedKeyIsExtractable: null as boolean | null,
      };

      const authFetch = async (request: Request): Promise<Response> => {
        const atMs = options.clock.now();
        const body = await request.clone().text();
        const parsed = json(body);
        const path = new URL(request.url).pathname;
        let response: Response;
        if (path === '/signin/key') {
          const validBody =
            typeof parsed === 'object' &&
            parsed !== null &&
            Reflect.get(parsed, 'account_id') === options.accountId &&
            Reflect.get(parsed, 'client_id') === options.clientId &&
            Array.isArray(Reflect.get(parsed, 'scope')) &&
            JSON.stringify(Reflect.get(parsed, 'scope')) === JSON.stringify(IMPORTER_SCOPES) &&
            validAssertion(
              Reflect.get(parsed, 'assertion'),
              options.registeredPublicJwk,
              options.accountId,
              options.authOrigin,
              atMs,
            );
          if (revoked || !validBody) response = new Response('', { status: 401 });
          else {
            const session = `credential-session-${randomUUID()}`;
            sessions.add(session);
            sessionCookies.push(`session=${session}`);
            response = Response.json({}, { headers: { 'set-cookie': `session=${session}; HttpOnly; Secure` } });
          }
        } else if (path === '/token') {
          const supplied = request.headers.get('cookie')?.match(/^session=(.+)$/)?.[1];
          if (!supplied || !sessions.delete(supplied)) response = new Response('', { status: 401 });
          else {
            const token = `credential-access-${++sequence}-${randomUUID()}`;
            accessTokens.push(token);
            issued.set(token, options.clock.now() + 300_000);
            response = Response.json({ access_token: token, token_type: 'Bearer', expires_in: 300 });
          }
        } else response = new Response('', { status: 404 });
        const responseText = await response.clone().text();
        authRequests.push({
          url: request.url,
          method: request.method,
          origin: new URL(request.url).origin,
          contentType: request.headers.get('content-type'),
          cookie: request.headers.get('cookie'),
          body: parsed,
          requestBytes: bytes(body),
          responseStatus: response.status,
          responseBody: json(responseText),
          responseCookie: cookie(response),
          responseBytes: bytes(responseText),
          policy: { ...policy },
          atMs,
        });
        return response;
      };

      const apiFetch = async (request: Request): Promise<Response> => {
        const atMs = options.clock.now();
        let response = await api.beforeRequest?.(request, options.clock);
        const body = request.body ? await request.text() : null;
        let responseText: string | undefined;
        let effectApplied = false;
        if (!response) {
          const authorization = request.headers.get('authorization');
          const token = authorization?.match(/^Bearer (.+)$/)?.[1];
          if (!token || (issued.get(token) ?? 0) <= options.clock.now()) {
            response = new Response('denied', { status: 401 });
          } else {
            const path = new URL(request.url).pathname;
            if (path === '/v1/sourceFences:check') {
              const url = new URL(request.url);
              const owner = JSON.stringify([url.searchParams.get('source'), url.searchParams.get('externalId')]);
              const fenced = subjects.has(owner);
              responseText = JSON.stringify({ fenced, securityRevision: fenced ? '1' : null });
              response = new Response(responseText, { headers: { 'content-type': 'application/json' } });
              effectApplied = true;
            } else if (path === '/v1/subjects:batchWrite' && body !== null) {
              const payload = JSON.parse(body) as BatchWriteRequest;
              const result: BatchWriteResult = {
                results: payload.commands.map((command) => {
                  const owner = JSON.stringify([command.source.source, command.source.external_id]);
                  if (command.op === 'create' && !subjects.has(owner)) subjects.set(owner, randomUUID());
                  const value =
                    command.op === 'create'
                      ? { id: subjects.get(owner)!, revision: 1 }
                      : command.op === 'propose'
                        ? { candidate: randomUUID(), revision: 1 }
                        : { revision: 1 };
                  return { key: command.key, status: 200 as const, value };
                }),
              };
              responseText = JSON.stringify(result);
              response = new Response(responseText, { headers: { 'content-type': 'application/json' } });
              effectApplied = true;
            } else response = new Response('', { status: 404 });
          }
        }
        responseText ??= await response.clone().text();
        apiRequests.push({
          url: request.url,
          method: request.method,
          body,
          authorization: request.headers.get('authorization'),
          idempotencyHeader: request.headers.get('idempotency-key'),
          requestBytes: body === null ? 0 : bytes(body),
          responseStatus: response.status,
          responseBytes: bytes(responseText),
          effectApplied,
          policy: { ...policy },
          atMs,
        });
        await api.afterResponse?.(
          request,
          new Response(responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
          options.clock,
        );
        return response;
      };

      const observer: ImportCliObserver = {
        onAccountKey(_path, observation) {
          key = {
            fileReadCount: key.fileReadCount + 1,
            regularFile: observation.regularFile,
            mode: observation.mode,
            importedKeyIsExtractable: observation.importedKey.extractable,
          };
        },
      };
      const fetch = ((request: Request) => {
        const origin = new URL(request.url).origin;
        if (origin === options.authOrigin) return authFetch(request);
        if (origin === options.apiOrigin) return apiFetch(request);
        return Promise.resolve(new Response('', { status: 404 }));
      }) as typeof globalThis.fetch;
      const pending = runImportCli(argv, {
        ...(boundaries.stdin ? { stdin: boundaries.stdin } : {}),
        ...(boundaries.signal ? { signal: boundaries.signal } : {}),
        fetch,
        clock: options.clock,
        observer,
      });
      active.add(pending);
      let result;
      try {
        result = await pending;
      } finally {
        active.delete(pending);
      }
      const databaseFiles = [options.directory, resolve(options.directory, 'state.sqlite')].filter(
        (value, index, all) => all.indexOf(value) === index,
      );
      const execution: ImportCliCredentialsExecution = {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        openHandles: result.openHandles,
        startedAtMs,
        finishedAtMs: options.clock.now(),
        auth: {
          registeredScopes: IMPORTER_SCOPES,
          requests: authRequests,
          accessTokens,
          sessionCookies,
        },
        api: { requests: apiRequests },
        key,
        databaseFiles,
      };
      return execution;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...active]);
    },
  };
};
