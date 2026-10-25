import type { GrowthDatabase } from '../services/kernel/test/support/growth.ts';

/** The route-0 resource that carries platform-wide authority. */
export const GLOBAL_CONTEXT_ID = '00000000-0000-8000-8000-000000000000';

export type Exposure = 'public' | `gate:${string}`;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type GrantEffect = 'allow' | 'revoke';

export interface Account {
  readonly id: string;
  /** A signed bearer issued by the product's native Auth registration flow. */
  readonly bearer: string;
  /** Present for the gated tester, authenticated with this principal. */
  readonly principalId?: string;
}

export type Viewer =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'account'; readonly account: Account }
  | { readonly kind: 'invalid-bearer'; readonly bearer: string };

export interface Operation {
  /** Stable route identity mapped from the actual mounted router metadata. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Concrete path used for a real kernel HTTP request. */
  readonly path: string;
  /** Corresponding path key in the served OpenAPI document. */
  readonly openApiPath: string;
  readonly action: string;
  readonly exposure: Exposure;
}

export interface MountedRoute {
  readonly id: string;
  readonly hidden: boolean;
  readonly exposure?: string;
}

export interface StoredGrant {
  readonly id: string;
  readonly subjectAccountId: string;
  readonly resourceId: string;
  readonly actions: readonly string[];
  readonly effect: 'allow' | 'deny';
  /** Whether this persisted row is valid at the fixture's authoritative time. */
  readonly active: boolean;
}

export interface PlatformGatesFixture {
  readonly accounts: {
    readonly ordinary: Account;
    readonly tester: Account;
    readonly testerPrincipal: Account;
    readonly staff: Account;
    readonly recipient: Account;
  };
  readonly publicOperation: Operation;
  readonly gatedOperation: Operation;
  /** One requestable fixture operation for each closed group, including spec_fixture. */
  readonly closedOperations: readonly Operation[];
  /** All public and gated fixture operations, with OpenAPI path/method mappings. */
  readonly operations: readonly Operation[];
}

export type GrowthAxis = 'unrelated-grants' | 'unrelated-openings';

export interface PlatformGateGrowthFixture {
  /** The actual database observed by the shared checkGrowth harness. */
  readonly database: GrowthDatabase;
  /** Add only unrelated persisted rows for this axis, from previous to scale. */
  grow(scale: number, previous: number): Promise<void>;
  /** Send one fresh request through createKernel.handle for the fixed closed target. */
  request(repetition: number): Promise<Response>;
  /** Close only resources created for this growth fixture. */
  close(): Promise<void>;
}

/**
 * PLATFORM_GATES_DRIVER_MODULE is an absolute file path or file URL exporting
 * createPlatformGatesDriver(): Promise<PlatformGatesDriver>.
 *
 * Every fixture request must pass through the real createKernel.handle route
 * table, real native Auth bearer validation and real Access storage. The seed
 * flow registers its accounts through native Auth, performs the real governance
 * bootstrap for platform staff, and grants each native Auth client the operation's
 * own x-action scope and permission so the gate is the boundary under test. The
 * tester authenticates with testerPrincipal present. Only staff begins with
 * gate:any and access:grant.
 * No product gate policy may be represented by a map, set, mock evaluator or
 * adapter-side decision. Reads below are independent observations of persisted
 * rows at the fixture's authoritative time.
 *
 * Fixture routes are ordinary non-hidden operations mounted by createKernel.
 * closedOperations contains exactly one harmless route for every production
 * group that is closed at the fixture time, plus gate:spec_fixture. Each route
 * has its own x-action and can complete after the gate permits it. The public
 * route is the positive control. Never replace HTTP calls with direct evaluator
 * calls or use fixture setup writes to perform an operation's business effect.
 */
export interface PlatformGatesDriver {
  /** Destroy only the database/kernel/Auth resources created by this driver. */
  close(): Promise<void>;

  /** Native Auth registration, real staff bootstrap, route mounting and account permissions. */
  seed(): Promise<PlatformGatesFixture>;

  /**
   * Build a fresh kernel with one mounted, non-hidden route whose x-action is
   * valid. Omit exposure to test a missing detail['x-exposure']; pass arbitrary
   * values to test the kernel's own exposure validation. Resolve only if the
   * actual createKernel build succeeds, and reject with its native build error.
   */
  buildWithRoute(route: { readonly exposure?: unknown }): Promise<void>;

  /** Actual mounted production routes; do not synthesize this list from a policy table. */
  productionRoutes(): Promise<readonly MountedRoute[]>;

  /** Fresh request through createKernel.handle. Do not route around Auth or Access. */
  request(viewer: Viewer, method: HttpMethod, path: string, body?: unknown): Promise<Response>;

  /**
   * Grant/revoke one direct action using the ordinary grant HTTP routes, with
   * resourceId GLOBAL_CONTEXT_ID. This must not write fixture SQL directly.
   */
  grant(grantor: Account, recipient: Account, action: string, effect: GrantEffect): Promise<Response>;

  /** Independent read of persisted grant rows for this account at authoritative T. */
  grantsFor(accountId: string): Promise<readonly StoredGrant[]>;

  /**
   * Count the real fixture domain SELECTs observed for this operation. This is
   * query instrumentation, not an adapter-maintained counter or a product row.
   */
  fixtureDomainReadCount(operationId: string): Promise<number>;

  /** Read the persisted access.exposure_opening state for this group at authoritative T. */
  exposureOpenAt(group: string): Promise<boolean>;

  /**
   * The product's actual visibleOperations(viewer) result, normalized only to
   * the mounted operation descriptors; never apply visibility in this adapter.
   */
  visibleOperations(viewer: Viewer): Promise<readonly Operation[]>;

  /**
   * Create an isolated real kernel/database with the fixed spec_fixture target
   * closed and request it as an ordinary authenticated account lacking that
   * gate. For unrelated-grants, grow only other accounts' gate grants on Global;
   * for unrelated-openings, grow only other catalogue groups. The fixed target
   * stays closed. The request must reach the real operation over HTTP; close()
   * must release its measured database.
   */
  growthFixture(axis: GrowthAxis): Promise<PlatformGateGrowthFixture>;
}
