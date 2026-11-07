import type { Pool } from 'pg';
import { createNativeSearchDisclosure } from '../search/index.ts';
import { composeLibraryDomain } from './library.ts';
import { composeZones } from './zones.ts';
import { createWriteRateLimiter, type WriteRateLimiter } from '../access/write-rate.ts';
import { createAccess, type AccessConfig } from '../access/index.ts';
import type { AuthenticationConfig } from '../access/authenticate.ts';
import { localJwksTransport } from '../access/membership-work-config.ts';
import { composeAccessApplication } from './access.ts';
import { composeCommunityApplication } from './community.ts';
import { composeContentApplication } from './content.ts';
import { composeWorkApplication } from './work.ts';
import { installSemanticCopyWork } from './semantic-copy-work.ts';
import { installNativeHistory } from './history.ts';
import { composeSemanticAdapters } from './semantic.ts';
import { composeSearchSemanticSource } from './search-semantic.ts';
import { composePresentationApplication } from './presentation.ts';
import { ConfigError } from '../commerce/config.ts';
import { assertReceiptKeyRing, readReceiptKeyRing } from '../command/receipt-key.ts';
import { systemClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { AccessFactory } from '../request/access.ts';
import type { WriteRateStageOptions } from '../access/write-rate-stage.ts';
import type { CreditSearchSource } from '../search/credit-search.ts';
import { createCreditSearchSource } from '../semantic/credit-search.ts';
import { createNativeLibraryScopeWork, createSearchLibraryScopePort } from './search-library.ts';
import type { SearchLibraryScopePort } from '../search/index.ts';
import { composeSearchAccess } from './search-access.ts';
import type { FacetAccessObservationPort } from '../search/facet-access-port.ts';

export type KernelRuntimeDefaults = {
  /** Bind the complete native application for each Search transport. */
  searchDisclosure: typeof createNativeSearchDisclosure;
  tokens: KeyRing;
  receiptKeys: KeyRing;
  writeRate: WriteRateLimiter;
  rateAttribution: WriteRateStageOptions;
  clock: () => Date;
  /** Real wall time for request deadlines. Composition supplies it; modules never read a global clock. */
  deadlineNow: () => number;
  access: AccessFactory;
  auth?: AuthenticationConfig;
  /** Search-owned Access observation used by live scoped facet execution. */
  facetAccess: FacetAccessObservationPort;
  /** Constructed Library capability retained by each scoped Search application. */
  libraryScope: SearchLibraryScopePort;
};

export type KernelRuntimeOverrides = {
  env?: NodeJS.ProcessEnv;
  tokens?: KeyRing;
  receiptKeys?: KeyRing;
  writeRate?: WriteRateLimiter;
  rateAttribution?: WriteRateStageOptions;
  clock?: () => Date;
  deadlineNow?: () => number;
  auth?: AuthenticationConfig;
};

function readTokenKeys(env: NodeJS.ProcessEnv): KeyRing {
  const entries = required(env, 'KERNEL_SESSION_KEYS').split(',');
  const keys = new Map<number, Uint8Array>();
  for (const entry of entries) {
    const match = /^(\d+):([A-Za-z0-9_-]+)$/.exec(entry);
    const id = match?.[1] === undefined ? NaN : Number(match[1]);
    const encoded = match?.[2];
    if (!Number.isInteger(id) || id < 0 || id > 255 || encoded === undefined || keys.has(id)) {
      throw new ConfigError('KERNEL_SESSION_KEYS');
    }
    keys.set(id, decodeKey(encoded, 'KERNEL_SESSION_KEYS'));
  }
  const current = keys.keys().next().value as number | undefined;
  if (current === undefined) throw new ConfigError('KERNEL_SESSION_KEYS');
  return { current, keys };
}

function readAuthConfig(env: NodeJS.ProcessEnv): AuthenticationConfig | undefined {
  const issuer = env.AUTH_ISSUER;
  const audience = env.AUTH_AUDIENCE;
  const jwksUrl = env.AUTH_JWKS_URL;
  if (issuer === undefined && audience === undefined && jwksUrl === undefined) return undefined;
  return localJwksTransport(env, { issuer: issuer ?? '', audience: audience ?? '', jwksUrl: jwksUrl ?? '' });
}

/** Production CreditSearchSource for the installed Search consumer. */
export function createKernelCreditSearchSource(pool: Pool, routeKey: Uint8Array): CreditSearchSource {
  if (!(routeKey instanceof Uint8Array) || routeKey.byteLength !== 32) throw new ConfigError('KERNEL_ROUTE_KEY');
  return createCreditSearchSource(pool, routeKey);
}

const systemDeadlineNow = (): number => Date.now();

/** Shared runtime defaults for the HTTP server and Search work factory. */
export function createKernelRuntimeDefaults(overrides: KernelRuntimeOverrides = {}): KernelRuntimeDefaults {
  const libraryScope = createSearchLibraryScopePort();
  composeAccessApplication();
  composeWorkApplication();
  composeContentApplication();
  composeCommunityApplication();
  installNativeHistory();
  composeSemanticAdapters();
  composeSearchSemanticSource();
  composePresentationApplication();
  composeLibraryDomain({ scopeWork: createNativeLibraryScopeWork(libraryScope) });
  composeZones();
  installSemanticCopyWork();
  const env = overrides.env ?? process.env;
  const tokens = overrides.tokens ?? readTokenKeys(env);
  const receiptKeys = readReceiptKeyRing(env, overrides.receiptKeys);
  assertReceiptKeyRing(receiptKeys, tokens);
  const writeRate =
    overrides.writeRate ??
    createWriteRateLimiter({
      ...(env.KERNEL_WRITE_RATE_SECRET === undefined ? {} : { secret: env.KERNEL_WRITE_RATE_SECRET }),
      ...(env.KERNEL_WRITE_RATE_OVERRIDES === undefined ? {} : { overrides: env.KERNEL_WRITE_RATE_OVERRIDES }),
    });
  const rateAttribution = overrides.rateAttribution ?? {
    trustedProxyPeers: env.KERNEL_RATE_TRUSTED_PROXY_PEERS?.split(',') ?? [],
    clientIpHeader: env.KERNEL_RATE_CLIENT_IP_HEADER ?? 'cf-connecting-ip',
  };
  const auth = overrides.auth ?? readAuthConfig(env);
  const access: AccessFactory = auth ? (config: AccessConfig) => createAccess({ ...config, auth }) : createAccess;
  return {
    searchDisclosure: createNativeSearchDisclosure,
    tokens,
    receiptKeys,
    writeRate,
    rateAttribution,
    clock: overrides.clock ?? systemClock,
    deadlineNow: overrides.deadlineNow ?? systemDeadlineNow,
    access,
    facetAccess: composeSearchAccess(),
    libraryScope,
    ...(auth === undefined ? {} : { auth }),
  };
}

export function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable];
  if (!value) throw new ConfigError(variable);
  return value;
}

export function decodeKey(value: string, variable: string, exactLength?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ConfigError(variable);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || decoded.byteLength < (exactLength ?? 32)) {
    throw new ConfigError(variable);
  }
  if (exactLength !== undefined && decoded.byteLength !== exactLength) throw new ConfigError(variable);
  return new Uint8Array(decoded);
}
