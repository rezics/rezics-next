import type { AuthService } from '@rezics/auth';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AccessConfig } from '../../src/access/index.ts';
import type { AuthenticationConfig } from '../../src/access/authenticate.ts';
import type { ResourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import type { WriteRateLimiter } from '../../src/access/write-rate.ts';
import type { WriteRateStageOptions } from '../../src/access/write-rate-stage.ts';
import type { CommerceDependencies } from '../../src/commerce/routes.ts';
import type { ContentRuntime } from '../../src/content/runtime.ts';
import type { ContentBoardDependencies } from '../../src/content/boards.ts';
import type { Access, AccessRealmRoleReader, ActionCatalogue } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { createKernelRuntimeDefaults, type KernelRuntimeOverrides } from '../../src/server.ts';
import { createApp } from '../../src/http/app.ts';
import { createKernel, createKernelAccessResolver, type Kernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { SearchService } from '../../src/search/http/routes.ts';

const TEST_KEY = 0x6b;
const testIssuer = 'https://test-auth.example.test';
const testAudience = 'https://test-api.example.test';

export const testAuth: AuthenticationConfig = {
  issuer: testIssuer,
  audience: testAudience,
  jwksUrl: `${testIssuer}/.well-known/jwks.json`,
  fetch: async () =>
    new Response(JSON.stringify({ keys: [] }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
    }),
};

export function testTokens(): KeyRing {
  return { current: 1, keys: new Map([[1, new Uint8Array(32).fill(TEST_KEY)]]) };
}

export function testRouteKey(): Uint8Array {
  return new Uint8Array(32).fill(TEST_KEY);
}

export type TestAccessOptions = Pick<AccessConfig, 'actions' | 'resourceRoles' | 'realmRoleReader' | 'clock'> & {
  pool: Pool;
  auth?: AuthenticationConfig;
};

function authConfig(options: TestAccessOptions): AuthenticationConfig {
  return options.auth ?? testAuth;
}

function runtimeDefaults(options: KernelRuntimeOverrides & { auth: AuthenticationConfig }) {
  return createKernelRuntimeDefaults({
    ...options,
    tokens: options.tokens ?? testTokens(),
  });
}

export function testAccess(options: TestAccessOptions): Access {
  const defaults = runtimeDefaults({ auth: authConfig(options), ...(options.clock ? { clock: options.clock } : {}) });
  const accessFactory = (config: AccessConfig) =>
    defaults.access!({
      ...config,
      ...(options.resourceRoles === undefined ? {} : { resourceRoles: options.resourceRoles }),
    }) as Access;
  const composition = createKernelAccessResolver({
    pool: options.pool,
    tokens: defaults.tokens,
    clock: defaults.clock,
    access: accessFactory,
    ...(options.realmRoleReader === undefined ? {} : { realmRoleReader: options.realmRoleReader }),
  });
  return composition.resolveAccess({ actions: options.actions });
}

type TestRuntimeOptions = {
  clock?: () => Date;
  auth?: AuthenticationConfig;
  tokens?: KeyRing;
  writeRate?: WriteRateLimiter;
  rateAttribution?: WriteRateStageOptions;
  actions?: ActionCatalogue;
  resourceRoles?: ResourceRoleCatalogue;
  realmRoleReader?: AccessRealmRoleReader;
  ratePeer?: (request: Request) => string | undefined;
};

export type TestAppOptions = TestRuntimeOptions & { pool: Pool };

export function testApp(options: TestAppOptions): ReturnType<typeof createApp> {
  const defaults = runtimeDefaults({
    auth: options.auth ?? testAuth,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    ...(options.writeRate === undefined ? {} : { writeRate: options.writeRate }),
    ...(options.rateAttribution === undefined ? {} : { rateAttribution: options.rateAttribution }),
  });
  const accessFactory = (config: AccessConfig) =>
    defaults.access!({
      ...config,
      ...(options.actions === undefined ? {} : { actions: options.actions }),
      ...(options.resourceRoles === undefined ? {} : { resourceRoles: options.resourceRoles }),
      clock: options.clock ?? config.clock ?? defaults.clock,
    }) as Access;
  const accessComposition = createKernelAccessResolver({
    pool: options.pool,
    tokens: defaults.tokens,
    clock: defaults.clock,
    access: accessFactory,
    ...(options.realmRoleReader === undefined ? {} : { realmRoleReader: options.realmRoleReader }),
  });
  return createApp({
    requestDeadlineMs: 30_000,
    pool: options.pool,
    tokens: defaults.tokens,
    writeRate: defaults.writeRate,
    rateAttribution: defaults.rateAttribution,
    clock: defaults.clock,
    ...(options.ratePeer === undefined ? {} : { ratePeer: options.ratePeer }),
    access: accessComposition.resolveAccess,
  });
}

export type TestKernelOptions = TestRuntimeOptions & {
  pool: Pool;
  workClient?: WorkClient;
  content?: ContentRuntime & Pick<ContentBoardDependencies, 'cursorNow'>;
  commerce?: CommerceDependencies;
  search?: SearchService;
  reports?: { anonymousVerifier?: NonNullable<ContentRuntime['anonymousVerifier']> };
};

export type TestKernel = Kernel & { readonly testAccess: Access };

export function testKernel(options: TestKernelOptions): TestKernel {
  const defaults = runtimeDefaults({
    auth: options.auth ?? testAuth,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    ...(options.writeRate === undefined ? {} : { writeRate: options.writeRate }),
    ...(options.rateAttribution === undefined ? {} : { rateAttribution: options.rateAttribution }),
  });
  const accessFactory = (config: AccessConfig) =>
    defaults.access!({
      ...config,
      ...(options.actions === undefined ? {} : { actions: options.actions }),
      ...(options.resourceRoles === undefined ? {} : { resourceRoles: options.resourceRoles }),
      ...(options.realmRoleReader === undefined ? {} : { realmRoleReader: options.realmRoleReader }),
      clock: options.clock ?? config.clock ?? defaults.clock,
    });
  const accessComposition = createKernelAccessResolver({
    pool: options.pool,
    tokens: defaults.tokens,
    clock: defaults.clock,
    access: accessFactory,
    ...(options.realmRoleReader === undefined ? {} : { realmRoleReader: options.realmRoleReader }),
  });
  const kernel = createKernel({
    requestDeadlineMs: 30_000,
    pool: options.pool,
    routeKey: testRouteKey(),
    tokens: defaults.tokens,
    clock: defaults.clock,
    writeRate: defaults.writeRate,
    rateAttribution: defaults.rateAttribution,
    ...(options.ratePeer === undefined ? {} : { ratePeer: options.ratePeer }),
    ...(options.workClient === undefined ? {} : { workClient: options.workClient }),
    ...(options.content === undefined ? {} : { content: options.content }),
    ...(options.commerce === undefined ? {} : { commerce: options.commerce }),
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.reports === undefined ? {} : { reports: options.reports }),
    access: accessComposition.resolveAccess,
  });
  const composed = kernel as TestKernel;
  let composedAccess: Access | undefined;
  Object.defineProperty(composed, 'testAccess', {
    enumerable: false,
    get: () => (composedAccess ??= accessComposition.resolveAccess({ actions: actionCatalogue(kernel) })),
  });
  return composed;
}

let mountedActions: ActionCatalogue | undefined;

function productionActions(): ActionCatalogue {
  mountedActions ??= actionCatalogue(
    testKernel({
      pool: { options: { connectionString: 'postgres://kernel.invalid/test-catalogue' } } as Pool,
    }),
  );
  return mountedActions;
}

export async function registerTestClient(
  service: AuthService,
  options: {
    clientId: string;
    firstParty: boolean;
    actions?: ActionCatalogue;
    scopes?: readonly string[];
    displayName?: string;
  },
): Promise<void> {
  const scopes = options.scopes ?? [...(options.actions ?? productionActions()).keys()].sort();
  await service.internal.registerClient({
    clientId: options.clientId,
    firstParty: options.firstParty,
    scopes: [...scopes],
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
  });
}

type TestReceiptPrincipal =
  | { kind: 'account'; id: string; clientId: string; requestedBy?: string | null }
  | { kind: 'anonymous' };

export type TestReceiptOptions = {
  pool: Pick<Pool, 'query'>;
  partitionNo: number;
  principal: TestReceiptPrincipal;
  commandKind?: string;
  idempotencyKey?: string;
  requestDigest?: Uint8Array;
  epoch?: number;
  position?: number;
  transactionId?: string;
  response?: unknown;
  writeBasis?: boolean;
};

/** Inserts a production-shaped receipt and, when requested, its write basis. */
export async function writeTestReceipt(options: TestReceiptOptions) {
  const transactionId = options.transactionId ?? randomUUID();
  const principalId =
    options.principal.kind === 'account' ? options.principal.id : '00000000-0000-0000-0000-000000000000';
  const commandKind = options.commandKind ?? 'test.fixture';
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const requestDigest = options.requestDigest ?? new Uint8Array(32);
  const epoch = options.epoch ?? 1;
  const position = options.position ?? 1;
  const response = options.response ?? {};
  const clientId = options.principal.kind === 'account' ? options.principal.clientId : null;
  const requestedBy = options.principal.kind === 'account' ? (options.principal.requestedBy ?? null) : null;
  await options.pool.query(
    `WITH inserted_receipt AS (
      INSERT INTO core.receipt
        (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING partition_no,principal_kind,principal_id,epoch,position,transaction_id
    ), inserted_basis AS (
      INSERT INTO editorial.write_basis
        (partition_no,transaction_id,epoch,position,principal_kind,principal_id,client_id,requested_by)
      SELECT partition_no,transaction_id,epoch,position,principal_kind,principal_id,$11,$12
      FROM inserted_receipt
      WHERE $13::boolean
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM inserted_receipt), (SELECT count(*) FROM inserted_basis)`,
    [
      options.partitionNo,
      options.principal.kind,
      principalId,
      commandKind,
      idempotencyKey,
      requestDigest,
      epoch,
      position,
      transactionId,
      response,
      clientId,
      requestedBy,
      options.writeBasis ?? false,
    ],
  );
  return {
    partitionNo: options.partitionNo,
    principalKind: options.principal.kind,
    principalId,
    commandKind,
    idempotencyKey,
    requestDigest,
    epoch,
    position,
    transactionId,
    response,
  };
}
