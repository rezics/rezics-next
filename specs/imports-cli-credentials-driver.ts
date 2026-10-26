import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * TEST ONLY: IMPORT_CLI_CREDENTIALS_DRIVER exports
 * createImportCliCredentialsDriver(options). It must run the real
 * services/importer/src/cli.ts entry with the real importer, stores and HTTP
 * client. Its only network peers are a fake Auth issuer and fake API. The
 * binding records the requests and returned effects at those boundaries; it
 * does not parse CLI arguments, sign assertions, issue credentials, retry
 * writes, or simulate importer outcomes.
 *
 * Auth registers the same importer account-key credential and first-party
 * client used by the identity fixture. registeredScopes is the exact scope
 * list registered for that client and is a six-item tuple. Auth validates each
 * compact assertion with the registered public key and serves only the
 * documented POST /signin/key and POST /token routes. Its successful token
 * response is the documented access_token, token_type, expires_in shape with
 * expires_in=300. A rejected or revoked account key is denied by this fake Auth
 * boundary, never by a parallel CLI-specific credential shortcut.
 *
 * Fake API supports the importer's ordinary source-fence and batch-write
 * routes. A beforeRequest hook may inject an HTTP response before any effect;
 * afterResponse runs after the response is consumed and before the next CLI
 * operation. The virtual clock drives CLI time, Auth assertion times and
 * requests. advance is test-only control for representing elapsed run time or
 * an access token expiring during an in-flight request.
 *
 * HttpPolicy records the effective timeout and request/response byte limits
 * enforced by the production transport at dispatch. They must be observations
 * of that transport, not constants copied into the driver. key.importedKeyIs
 * records the actual CryptoKey imported by the CLI. databaseFiles contains the
 * real SQLite database and any live sidecars, so tests can inspect persisted
 * bytes. Closing also cleans partial setup and open handles.
 */
export const MISSING_CLI_CREDENTIALS_DRIVER =
  'IMPORT_CLI_CREDENTIALS_DRIVER is required: bind production importer CLI with fake Auth and API';

export const exit = { success: 0, input: 2, denied: 4 } as const;

export type ImporterScopes = readonly [string, string, string, string, string, string];

export interface VirtualClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Advance deterministic test time without sleeping in wall-clock time. */
  advance(ms: number): void;
}

export interface HttpPolicy {
  timeoutMs: number;
  requestLimitBytes: number;
  responseLimitBytes: number;
}

export interface AuthRequestObservation {
  url: string;
  method: string;
  origin: string | null;
  contentType: string | null;
  cookie: string | null;
  body: unknown;
  requestBytes: number;
  responseStatus: number;
  responseBody: unknown;
  responseCookie: string | null;
  responseBytes: number;
  policy: HttpPolicy;
  atMs: number;
}

export interface ApiRequestObservation {
  url: string;
  method: string;
  body: string | null;
  authorization: string | null;
  idempotencyHeader: string | null;
  requestBytes: number;
  responseStatus: number;
  responseBytes: number;
  /** False for a denied request; true only when the fake API applied its effect. */
  effectApplied: boolean;
  policy: HttpPolicy;
  atMs: number;
}

export interface ImportCliCredentialsExecution {
  code: number;
  stdout: string;
  stderr: string;
  openHandles: number;
  startedAtMs: number;
  finishedAtMs: number;
  auth: {
    registeredScopes: ImporterScopes;
    requests: AuthRequestObservation[];
    /** Fake Auth credentials, retained only for secret-leak assertions. */
    accessTokens: string[];
    sessionCookies: string[];
  };
  api: { requests: ApiRequestObservation[] };
  key: {
    fileReadCount: number;
    regularFile: boolean;
    mode: number;
    importedKeyIsExtractable: boolean | null;
  };
  /** Actual SQLite database and sidecar paths observed for this invocation. */
  databaseFiles: string[];
}

export interface Invocation {
  stdin?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface Options {
  directory: string;
  accountId: string;
  clientId: string;
  accountKeyPath: string;
  registeredPublicJwk: JsonWebKey;
  apiOrigin: string;
  authOrigin: string;
  clock: VirtualClock;
}

export interface ImportCliCredentialsDriver {
  /** Mutate the fake Auth account-key registry to model durable key revocation. */
  auth: { revokeAccountKey(): void };
  api: {
    beforeRequest?: (request: Request, clock: VirtualClock) => Promise<Response | undefined>;
    afterResponse?: (request: Request, response: Response, clock: VirtualClock) => Promise<void>;
  };
  invoke(argv: string[], boundaries?: Invocation): Promise<ImportCliCredentialsExecution>;
  close(): Promise<void>;
}

export type CreateImportCliCredentialsDriver = (options: Options) => Promise<ImportCliCredentialsDriver>;

export async function loadCliCredentialsDriver(): Promise<CreateImportCliCredentialsDriver> {
  const location = process.env.IMPORT_CLI_CREDENTIALS_DRIVER;
  if (!location) throw new Error(MISSING_CLI_CREDENTIALS_DRIVER);
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_CLI_CREDENTIALS_DRIVER must be an absolute path or file URL');
  const binding = await import(url.href);
  if (typeof binding.createImportCliCredentialsDriver !== 'function')
    throw new Error('IMPORT_CLI_CREDENTIALS_DRIVER must export createImportCliCredentialsDriver');
  return binding.createImportCliCredentialsDriver;
}
