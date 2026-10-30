import { createHash, randomUUID } from 'node:crypto';
import { nativeFixture, issuer as nativeIssuer } from '../access/native-account-bindings-fixture.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { anchorRoute, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey } from '../support/test-kernel.ts';

const AUDIENCE = 'https://ordinary.api.test';
const CLIENT_ID = 'space-address-recovery-client';
const OWNER_ROLE = 'community.space.owner';

export type RecoveryActor = Readonly<{ accountId: string; bearer: string; key: string }>;
export type RecoverySpace = Readonly<{
  spaceId: string;
  etag: string;
  headRevisionId: string;
  address: string | null;
  raw: Record<string, unknown>;
}>;
export type RecoveryCallOptions = Readonly<{
  bearer?: string;
  body?: unknown;
  key?: string;
  ifMatch?: string;
  headers?: Record<string, string>;
}>;
export type RecoveryResponse = Readonly<{
  response: Response;
  value: Record<string, unknown>;
}>;

function hashRoute(value: string): number {
  return createHash('sha256').update(value).digest().readUInt16BE(0);
}

export function addressRoute(address: string): number {
  return hashRoute(address.toLowerCase());
}

export function addressInPartition(prefix: string, partition: number): string {
  for (let suffix = 0; ; suffix++) {
    const address = `${prefix}-${suffix.toString(36)}`;
    if (partitionOf(addressRoute(address)) === partition) return address;
  }
}

export function addressAtIndependentAnchor(prefix: string, spaceIds: readonly string[]): string {
  const spaceRoutes = spaceIds.map((id) => routeOf(id)!);
  const spacePartitions = new Set(spaceRoutes.map(partitionOf));
  for (let suffix = 0; ; suffix++) {
    const address = `${prefix}-${suffix.toString(36)}`;
    const route = addressRoute(address);
    if (!spaceRoutes.includes(route) && !spacePartitions.has(partitionOf(route))) return address;
  }
}

export function spaceCreateKeyInPartition(owner: RecoveryActor, partition: number): string {
  for (let attempt = 0; ; attempt++) {
    const key = `space-address-growth-${attempt}-${randomUUID()}`;
    const route = anchorRoute(testRouteKey(), `${owner.accountId}\ncommunity.space.create\n${key}`);
    if (partitionOf(route) === partition) return key;
  }
}

export type SpaceAddressRecoveryFixture = Readonly<{
  database: GrowthDatabase;
  kernel: ReturnType<typeof testKernel>;
  auth: Awaited<ReturnType<typeof nativeFixture>>;
  readonly now: Date;
  setTime(value: Date | string): void;
  person(name: string): Promise<RecoveryActor>;
  request(method: string, path: string, options?: RecoveryCallOptions): Promise<RecoveryResponse>;
  grantGlobal(grantor: RecoveryActor, subject: RecoveryActor, actions: readonly string[]): Promise<RecoveryResponse>;
  createSpace(owner: RecoveryActor, title?: string, key?: string): Promise<RecoverySpace>;
  addressClaim(address: string): Promise<null | Record<string, unknown>>;
  spaceState(spaceId: string): Promise<{
    head: Record<string, unknown> | null;
    revisions: Record<string, unknown>[];
  }>;
  receipt(partition: number, actor: RecoveryActor, key: string, kind: string): Promise<Record<string, unknown> | null>;
  ownerGrant(spaceId: string, owner: RecoveryActor): Promise<Record<string, unknown>>;
  revokeOwner(grantor: RecoveryActor, spaceId: string, owner: RecoveryActor): Promise<RecoveryResponse>;
  close(): Promise<void>;
}>;

/**
 * Native HTTP fixture for the independent address/Space recovery slice.
 * It composes the mounted production kernel Access with Auth's real registration and token routes;
 * only account/bootstrap grants are setup, and every asserted Space/address outcome uses HTTP commands.
 */
export async function createSpaceAddressRecoveryFixture(options: { initialTime?: Date | string } = {}) {
  const database = await openGrowthDatabase();
  database.pool.options.max = 12;
  let domainTime = options.initialTime
    ? new Date(options.initialTime instanceof Date ? options.initialTime.getTime() : options.initialTime)
    : new Date();
  if (!Number.isFinite(domainTime.getTime())) throw new RangeError('initialTime must be a valid date');

  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  const kernel = testKernel({
    pool: database.pool,
    clock: () => new Date(domainTime),
    writeRate: createWriteRateLimiter({
      secret: 'space-address-recovery-write-rate-secret-32bytes',
      overrides: JSON.stringify({
        anonymous: { write: { maximum: 100000, seconds: 86400 } },
        'new-account': { write: { maximum: 100000, seconds: 86400 } },
      }),
    }),
    auth: {
      issuer: nativeIssuer,
      audience: AUDIENCE,
      jwksUrl: `${nativeIssuer}/.well-known/jwks.json`,
      fetch: async (url, init) => {
        if (!auth) throw new Error('Native Auth fixture has not started');
        return auth.host.service.handler(new Request(url, init));
      },
    },
  });

  try {
    auth = await nativeFixture(database.pool);
    const actions = actionCatalogue(kernel);
    const scopes = [...actions.keys()].filter((scope) => scope !== 'media:complete');
    await registerTestClient(auth.host.service, {
      clientId: CLIENT_ID,
      firstParty: true,
      actions,
      scopes,
    });

    const makePerson = async (name: string): Promise<RecoveryActor> => {
      const key = `space-address-recovery-${name}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const registered = await auth!.person(key);
      const signed = await auth!.request('/signin', {
        email: `${key}@ordinary.test`,
        password: 'ordinary native registration password',
        client_id: CLIENT_ID,
        scope: scopes,
      });
      if (signed.status !== 200) throw new Error(`Native sign-in failed: ${signed.status}`);
      const cookies = new Headers({
        cookie: signed.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; '),
      });
      const token = await auth!.request('/token', {}, cookies);
      if (token.status !== 200) throw new Error(`Native token issuance failed: ${token.status}`);
      const value = (await token.json()) as { access_token: string };
      return { accountId: registered.accountId, bearer: value.access_token, key };
    };

    const governance = await makePerson('governance');
    await bootstrapGovernance(database.pool, governance.accountId);

    const request = async (method: string, path: string, callOptions: RecoveryCallOptions = {}) => {
      const headers = new Headers(callOptions.headers);
      if (callOptions.bearer) headers.set('authorization', `Bearer ${callOptions.bearer}`);
      if (callOptions.body !== undefined) headers.set('content-type', 'application/json');
      if (callOptions.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(callOptions.key));
      if (callOptions.ifMatch !== undefined) headers.set('if-match', callOptions.ifMatch);
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers,
          ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
        }),
      );
      const text = await response.text();
      return { response, value: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    };

    const grantGlobal = async (grantor: RecoveryActor, subject: RecoveryActor, grantedActions: readonly string[]) => {
      const key = randomUUID();
      const body = {
        resource: { route: PLATFORM_RESOURCE.route, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: subject.accountId },
        actions: [...grantedActions],
        valid: '(,)',
      };
      const result = await request('POST', '/v1/grants', { bearer: grantor.bearer, key, body });
      if (result.response.status !== 201)
        throw new Error(
          `POST /v1/grants failed: ${JSON.stringify({ actor: grantor.accountId, key, body, status: result.response.status, response: result.value })}`,
        );
      return result;
    };

    const createSpace = async (owner: RecoveryActor, title = 'Recovery Space', key = randomUUID()) => {
      const created = await request('POST', '/v1/spaces', {
        bearer: owner.bearer,
        key,
        body: { title, summary: 'Independent address and Space anchors' },
      });
      if (created.response.status !== 201)
        throw new Error(`Space creation failed: ${created.response.status} ${JSON.stringify(created.value)}`);
      const raw = created.value.space as Record<string, unknown>;
      const etag = created.response.headers.get('etag');
      if (!etag || typeof raw.spaceId !== 'string' || typeof raw.headRevisionId !== 'string')
        throw new Error('Space creation omitted its identity, revision or ETag');
      return {
        spaceId: raw.spaceId,
        etag,
        headRevisionId: raw.headRevisionId,
        address: typeof raw.address === 'string' ? raw.address : null,
        raw,
      };
    };

    const addressClaim = async (address: string) => {
      const result = await database.admin.query(
        `SELECT route, normalized_address, space_id, state, expires_at::text, reserved_until::text,
                reservation_id, transaction_id
         FROM community.space_address_claim
         WHERE route=$1 AND normalized_address=$2`,
        [addressRoute(address), address.toLowerCase()],
      );
      return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    };

    const spaceState = async (spaceId: string) => {
      const route = routeOf(spaceId);
      if (route === null) throw new TypeError('Space id is not routed');
      const [head, revisions] = await Promise.all([
        database.admin.query(
          `SELECT route, space_id, state, head_revision_id, creator
           FROM community.space WHERE route=$1 AND space_id=$2`,
          [route, spaceId],
        ),
        database.admin.query(
          `SELECT route, space_id, revision_id, predecessor, address, title, summary, author
           FROM community.space_revision WHERE route=$1 AND space_id=$2 ORDER BY revision_id`,
          [route, spaceId],
        ),
      ]);
      return {
        head: (head.rows[0] as Record<string, unknown> | undefined) ?? null,
        revisions: revisions.rows as Record<string, unknown>[],
      };
    };

    const receipt = async (partition: number, actor: RecoveryActor, key: string, kind: string) => {
      const result = await database.admin.query(
        `SELECT partition_no, principal_kind, principal_id, command_kind, idempotency_key,
                request_digest, epoch, position, transaction_id, response
         FROM core.receipt
         WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
           AND command_kind=$3 AND idempotency_key=$4`,
        [partition, actor.accountId, kind, key],
      );
      return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    };

    const ownerGrant = async (spaceId: string, owner: RecoveryActor) => {
      const route = routeOf(spaceId);
      if (route === null) throw new TypeError('Space id is not routed');
      const result = await database.admin.query(
        `SELECT route, resource_id, subject_kind, subject_id, grant_role, valid::text, transaction_id
         FROM access.resource_role_grant
         WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
           AND grant_role=$4 AND upper_inf(valid)
         ORDER BY lower(valid) DESC LIMIT 1`,
        [route, spaceId, owner.accountId, OWNER_ROLE],
      );
      const grant = result.rows[0] as Record<string, unknown> | undefined;
      if (!grant) throw new Error('Space owner role was not initialized by the native create command');
      return grant;
    };

    const revokeOwner = async (grantor: RecoveryActor, spaceId: string, owner: RecoveryActor) => {
      const grant = await ownerGrant(spaceId, owner);
      return request('POST', '/v1/roleGrants:revoke', {
        bearer: grantor.bearer,
        key: randomUUID(),
        body: {
          resource: { route: routeOf(spaceId)!, id: spaceId },
          subject: { kind: 'account', id: owner.accountId },
          role: OWNER_ROLE,
          valid: grant.valid,
        },
      });
    };

    const fixture: SpaceAddressRecoveryFixture = {
      database,
      kernel,
      auth,
      get now() {
        return new Date(domainTime);
      },
      setTime(value) {
        const next = new Date(value instanceof Date ? value.getTime() : value);
        if (!Number.isFinite(next.getTime())) throw new RangeError('time must be a valid date');
        domainTime = next;
      },
      async person(name) {
        return makePerson(name);
      },
      request,
      grantGlobal,
      createSpace,
      addressClaim,
      spaceState,
      receipt,
      ownerGrant,
      revokeOwner,
      async close() {
        try {
          await auth!.close();
        } finally {
          await database.close();
        }
      },
    };
    return { fixture, governance };
  } catch (error) {
    try {
      await auth?.close();
    } finally {
      await database.close();
    }
    throw error;
  }
}
