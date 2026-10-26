import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { COMMITTED_CONTINUATION_ACTIONS } from '../../src/access/committed-continuations.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { ContentForbiddenError, ContentNotFoundError, createThread } from '../../src/content/commands.ts';
import { AuthenticationError, accessCheck, type Access, type AccountActor } from '../../src/request/access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { productionActions } from '../support/production-actions.ts';
import type {
  Authentication,
  Evidence,
  Facts,
  Grant,
  Login,
  Operation,
  Outcome,
  PermissionDriver,
  Session,
} from '../../../../specs/permission-driver.ts';

const password = 'permission-outcome-test-password';
const loginClient = 'permission-fixture-login';
const delegateAction = 'access:delegate';
const audience = 'https://permission.api.test';
/** The suite's abstract actions and the registered product actions that carry them. */
const productAction: Record<string, string> = {
  read: 'board:read',
  write: 'thread:create',
  'grant:manage': 'access:grant',
};
const registeredScopes = [...new Set([...Object.values(productAction), delegateAction])].sort();
const SLOTS = 3;
/** Where each evidence source is read: the kernel's tables, or Auth's. */
const evidenceTables: Record<Evidence, { database: 'kernel' | 'auth'; tables: RegExp }> = {
  accounts: { database: 'kernel', tables: /\baccess\.account\b/ },
  resources: { database: 'kernel', tables: /\bcontent\.board\b/ },
  clients: { database: 'auth', tables: /\bauth_client\b/ },
  grants: { database: 'kernel', tables: /\baccess\.resource_(?:role_)?grant\b|\baccess\.resource_denial\b/ },
  consents: { database: 'auth', tables: /\bauth_consent\b/ },
  delegatedRequests: { database: 'kernel', tables: /\baccess\.(?:principal_)?assignment\b/ },
  memberships: { database: 'kernel', tables: /\baccess\.(?:organization_member|membership_inverse)\b/ },
};

type Resources = { read: { route: number; id: string }; write: { route: number; id: string } };
type Person = { id: string; email: string; handle: string };
type Handle = { bearer: string };
type Assignment = { principal: string; assignee: string; id: string; urn: string };
type Fixture = { kernel: string; auth: string; people: Person[] };

const trace = process.env.PERMISSION_DRIVER_TRACE
  ? (message: string) => console.log(`[permission ${Date.now() % 1_000_000}] ${message}`)
  : () => {};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const required = <T>(value: T | null | undefined, message: string): T => {
  if (value == null) throw new Error(message);
  return value;
};
const range = (valid: { start: string; end: string }) => `[${valid.start},${valid.end})`;
const routeOf = (id: string) => Number.parseInt(id.slice(24, 28), 16);
const refusal = (status: number) => status === 400 || status === 401 || status === 403;

// ---- process-wide fixture ---------------------------------------------------------------------
// Registering people costs seconds, so one prepared pair of databases is built per process and
// cloned for each factory call. A clone shares nothing with its siblings and is dropped on close.

const baseUrl = new URL(required(process.env.DATABASE_URL, 'DATABASE_URL must name the migrated kernel database'));
const sourceName = decodeURIComponent(baseUrl.pathname.slice(1));
const processSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const issuer = `https://permission-${processSuffix}.auth.test`;
const routeKey = randomBytes(32);
const referenceKeys: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const stagingKey = randomBytes(32);
const hostSecret = randomBytes(48).toString('base64url');
const signingPair = await generateKeyPair('ES256', { extractable: true });
const signingKey: JWK & { kid: string } = {
  ...(await exportJWK(signingPair.privateKey)),
  kid: `permission-${processSuffix}`,
};
const databaseUrl = (database: string) => {
  const url = new URL(baseUrl.href);
  url.pathname = `/${database}`;
  return url.href;
};
const admin = new Pool({ connectionString: databaseUrl('postgres'), max: 2, idleTimeoutMillis: 1000 });
admin.on('error', () => {});
const databases = new Set<string>();
let fixture: Promise<Fixture> | undefined;
let live = 0;

type World = {
  kernel: Pool;
  facts: Pool;
  auth: Pool;
  proofs: Pool;
  host: Awaited<ReturnType<typeof createAuthHost>>;
  service: AuthService;
  access: Access;
  stop(): Promise<void>;
};

async function openWorld(kernelName: string, authName: string, clock: () => Date): Promise<World> {
  const kernel = createPool(databaseUrl(kernelName));
  kernel.options.max = 6;
  const facts = new Pool({ connectionString: databaseUrl(kernelName), max: 2 });
  const auth = new Pool({ connectionString: databaseUrl(authName) });
  const proofs = new Pool({ connectionString: databaseUrl(authName), max: 2 });
  for (const pool of [facts, auth, proofs]) pool.on('error', () => {});
  let service: AuthService | undefined;
  // The mounted routes declare their own actions; later entries only add what no route declares.
  const actions = new Map([...LIFECYCLE_ACTIONS, ...COMMITTED_CONTINUATION_ACTIONS, ...productionActions()]);
  for (const scope of [...registeredScopes, 'account:manage'])
    if (!actions.has(scope)) actions.set(scope, { anonymous: false });
  const access = createAccess({
    actions,
    clock,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () =>
        required(service, 'Auth service is stopped').handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const workflowProofs = createNativeWorkflowProofPorts({ database: proofs });
  const bindings = createNativeAccountBindings({
    pool: kernel,
    access,
    actions,
    routeKey,
    clock,
    referenceKeys,
    auth: () => required(service, 'Auth service is stopped'),
    proofs: {
      workflow: workflowProofs,
      provisioning: createProvisioningEvidenceVerifier({ database: proofs }),
      barriers: createBarrierProofVerifier({ database: proofs }),
    },
  });
  const host = await createAuthHost({
    database: auth,
    systemDatabasePool: auth,
    issuer,
    audience,
    secret: hostSecret,
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    siteActions: actions,
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    stagingKey,
    maintenanceSchedule: '0 0 1 1 *',
    executorId: `permission-${authName}`,
  });
  service = host.service;
  await host.start();
  return {
    kernel,
    facts,
    auth,
    proofs,
    host,
    service,
    access,
    async stop() {
      try {
        await host.stop();
      } finally {
        await Promise.allSettled([kernel.end(), facts.end(), auth.end(), proofs.end()]);
      }
    },
  };
}

async function register(world: World, label: string): Promise<Person> {
  const handle = `${label.replaceAll(/[^a-z0-9_-]/gi, '_').toLowerCase()}_${randomUUID().slice(0, 8)}`;
  const email = `${randomUUID().replaceAll('-', '')}@permission.test`;
  const account = await world.host.workflows.register({ key: `registration-${randomUUID()}`, handle, email, password });
  return { id: account.accountId, email, handle };
}

async function ensureClient(world: World, id: string, party: 'first' | 'third'): Promise<void> {
  const known = await world.auth.query('SELECT 1 FROM auth_client WHERE client_id=$1', [id]);
  if (known.rowCount) return;
  await world.service.internal.registerClient({
    clientId: id,
    firstParty: party === 'first',
    scopes: registeredScopes,
  });
}

async function prepareFixture(): Promise<Fixture> {
  const names = { kernel: `permission_kernel_${processSuffix}`, auth: `permission_auth_${processSuffix}` };
  trace('prepare fixture');
  await admin.query(`CREATE DATABASE ${quote(names.kernel)} TEMPLATE ${quote(sourceName)}`);
  databases.add(names.kernel);
  await admin.query(`CREATE DATABASE ${quote(names.auth)}`);
  databases.add(names.auth);
  migrateAuth(databaseUrl(names.auth), fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
  const world = await openWorld(names.kernel, names.auth, () => new Date());
  try {
    await ensureClient(world, loginClient, 'first');
    const people = await Promise.all(Array.from({ length: SLOTS }, (_, index) => register(world, `slot${index}`)));
    return { ...names, people };
  } finally {
    await world.stop();
  }
}

/** Drop the prepared databases. Call once every driver of this process is closed. */
export async function releasePermissionFixtures(): Promise<void> {
  if (live > 0) return;
  fixture = undefined;
  for (const name of [...databases]) {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    databases.delete(name);
  }
}

/** Build the prepared databases ahead of the first case, outside any case's time budget. */
export function preparePermissionFixtures(): Promise<unknown> {
  return (fixture ??= prepareFixture().catch((error) => {
    fixture = undefined;
    throw error;
  }));
}

/** Drivers a timed-out case abandoned: the suite runs one case at a time, so none can still be in use. */
const open = new Set<PermissionDriver>();

export async function createPermissionDriver(): Promise<PermissionDriver> {
  for (const abandoned of [...open]) await abandoned.close();
  const prepared = (await preparePermissionFixtures()) as Fixture;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const kernelName = `permission_kernel_${suffix}`;
  const authName = `permission_auth_${suffix}`;
  let world: World | undefined;
  let closed = false;
  live += 1;

  // Trusted domain time. Auth issuance reads the wall clock; every authorization and command
  // attempt reads the controllable instant.
  let controlled = new Date();
  const clock = () => new Date(controlled);

  // Authoritative read failures are injected beneath the product, at the connection.
  const failures = new Map<Evidence, 'missing' | 'unavailable'>();
  const injector = (database: 'kernel' | 'auth') => (client: PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === 'string'
          ? first
          : typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
            ? first.text
            : '';
      for (const [source, failure] of failures) {
        const evidence = evidenceTables[source];
        if (
          evidence.database !== database ||
          !evidence.tables.test(text) ||
          /^\s*(?:BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(text)
        )
          continue;
        const error = failure === 'unavailable' ? new Error(`${source} evidence unavailable`) : null;
        const result = { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
        // pg answers either a callback or a promise, whichever the caller used.
        const callback = args.find((argument) => typeof argument === 'function') as
          | ((error: Error | null, result?: unknown) => void)
          | undefined;
        if (callback) {
          queueMicrotask(() => (error ? callback(error) : callback(null, result)));
          return undefined;
        }
        return error ? Promise.reject(error) : Promise.resolve(result);
      }
      return query(...args);
    }) as PoolClient['query'];
  };

  const people = new Map<string, Person>();
  const organizations = new Map<string, string>();
  const boards = new Map<string, Resources>();
  const assignments = new Map<string, Assignment>();
  let nextBoard = 0;
  let nextOrganization = 0;
  let app: ReturnType<typeof createKernel> | undefined;

  const current = () => required(world, 'Permission driver is closed');
  const context = () => ({ pool: current().kernel, deadline: Date.now() + 20_000 });

  async function request(path: string, body: unknown, session?: Headers): Promise<Response> {
    return current().host.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: session?.get('cookie') ?? '' },
        body: JSON.stringify(body),
      }),
    );
  }
  async function unexpected(step: string, response: Response): Promise<never> {
    throw new Error(`Auth ${step} failed unexpectedly: ${response.status} ${await response.text()}`);
  }

  /** Issue through Auth. A product refusal is a null result; anything else throws. */
  async function issue(
    email: string,
    clientId: string,
    scopes: readonly string[],
    requestedBy?: string,
  ): Promise<string | null> {
    const signed = await request('/signin', { email, password, client_id: clientId, scope: scopes });
    if (!signed.ok) return refusal(signed.status) ? null : unexpected('signin', signed);
    const session = new Headers({
      cookie: signed.headers
        .getSetCookie()
        .map((item) => item.split(';')[0])
        .join('; '),
    });
    const token = await request('/token', requestedBy === undefined ? {} : { requested_by: requestedBy }, session);
    if (!token.ok) return refusal(token.status) ? null : unexpected('token', token);
    const body = (await token.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('Auth did not issue an access token');
    return body.access_token;
  }

  async function build(): Promise<void> {
    trace('clone');
    await admin.query(`CREATE DATABASE ${quote(kernelName)} TEMPLATE ${quote(prepared.kernel)}`);
    databases.add(kernelName);
    await admin.query(`CREATE DATABASE ${quote(authName)} TEMPLATE ${quote(prepared.auth)}`);
    databases.add(authName);
    trace('open');
    world = await openWorld(kernelName, authName, clock);
    world.kernel.on('connect', injector('kernel'));
    world.auth.on('connect', injector('auth'));
    trace('opened');
  }

  // ---- fixture seeding: facts only, never policy ----------------------------------------------

  async function ensurePerson(label: string): Promise<Person> {
    const known = people.get(label);
    if (known) return known;
    const person = prepared.people[people.size] ?? (await register(current(), label));
    people.set(label, person);
    return person;
  }

  async function ensureOrganization(label: string): Promise<string> {
    const known = organizations.get(label);
    if (known) return known;
    const id = newId(0x3000 + nextOrganization * 16);
    nextOrganization += 1;
    await current().facts.query(
      `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'organization', 'active', $3)`,
      [routeOf(id), id, randomUUID()],
    );
    organizations.set(label, id);
    return id;
  }

  async function ensureBoards(label: string): Promise<Resources> {
    const known = boards.get(label);
    if (known) return known;
    // Each resource lives on its own partition: sixteen routes per partition.
    const base = 0x4000 + nextBoard * 0x20;
    nextBoard += 1;
    const resources: Resources = {
      read: { route: base, id: newId(base) },
      write: { route: base + 0x10, id: newId(base + 0x10) },
    };
    for (const [kind, visibility] of [
      ['read', 'protected'],
      ['write', 'published'],
    ] as const) {
      const resource = resources[kind];
      await current().facts.query(
        `INSERT INTO content.board (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [resource.route, resource.id, newId(resource.route), `Permission ${label} ${kind}`, visibility, randomUUID()],
      );
    }
    boards.set(label, resources);
    return resources;
  }

  const accountId = (label: string): string =>
    people.get(label)?.id ?? required(organizations.get(label), `Unknown account label ${label}`);
  const resourceFor = (label: string, action: string) => {
    const resources = required(boards.get(label), `Unknown resource label ${label}`);
    return action === 'read' ? resources.read : resources.write;
  };
  const productOf = (action: string) => productAction[action] ?? action;

  /** Consent is Auth's authoritative storage; issuance reads it from there. */
  async function applyConsents(desired: Facts['consents'], thirdParty: readonly string[]): Promise<void> {
    for (const [label, person] of people) {
      for (const client of thirdParty) {
        const wanted = [
          ...new Set(
            desired.filter((c) => c.actorId === label && c.clientId === client).flatMap((c) => c.scopes.map(productOf)),
          ),
        ].sort();
        if (wanted.length === 0)
          await current().auth.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
            person.id,
            client,
          ]);
        else
          await current().auth.query(
            `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)
             ON CONFLICT (account_id,client_id) DO UPDATE SET scopes=EXCLUDED.scopes,pending_scopes=NULL,pending_reference=NULL`,
            [person.id, client, wanted],
          );
      }
    }
  }

  async function applyAccounts(desired: Facts['accounts']): Promise<void> {
    for (const account of desired) {
      if (account.kind === 'actor') await ensurePerson(account.id);
      else await ensureOrganization(account.id);
    }
    for (const account of desired) {
      const id = accountId(account.id);
      const operator = account.operatorId === undefined ? null : accountId(account.operatorId);
      // The authentication floor never decreases; a fact below the stored floor cannot be restated.
      await current().facts.query(
        `UPDATE access.account
         SET state = $3, minimum_authn_epoch = GREATEST(minimum_authn_epoch, $4::bigint), operator_account_id = $5
         WHERE route = $1 AND account_id = $2`,
        [routeOf(id), id, account.state, account.minimumAuthnEpoch, operator],
      );
    }
  }

  async function applyGrants(desired: Grant[]): Promise<void> {
    const known = [...boards.values()].flatMap((resources) => [resources.read, resources.write]);
    for (const table of ['resource_grant', 'resource_denial'])
      await current().facts.query(
        `DELETE FROM access.${table} WHERE (route, resource_id) IN (SELECT * FROM unnest($1::int[], $2::uuid[]))`,
        [known.map((resource) => resource.route), known.map((resource) => resource.id)],
      );
    for (const grant of desired) {
      const subject = accountId('accountId' in grant.subject ? grant.subject.accountId : grant.subject.organizationId);
      const role = 'accountId' in grant.subject ? '' : grant.subject.role;
      for (const action of grant.actions) {
        const resource = resourceFor(grant.resourceId, action);
        const parameters = [
          resource.route,
          resource.id,
          subject,
          role,
          productOf(action),
          range(grant.valid),
          randomUUID(),
        ];
        if (grant.effect === 'allow')
          await current().facts.query(
            `INSERT INTO access.resource_grant (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
             VALUES ($1, $2, 'identity', $3, $4, $5, $6::tstzrange, $7)`,
            parameters,
          );
        else
          await current().facts.query(
            `INSERT INTO access.resource_denial (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
             VALUES ($1, $2, $3, $4, $5, 'resource', $6::tstzrange, $7)`,
            parameters,
          );
      }
    }
  }

  async function applyMemberships(desired: Facts['memberships']): Promise<void> {
    await current().facts.query('DELETE FROM access.organization_member WHERE organization_id = ANY($1::uuid[])', [
      [...organizations.values()],
    ]);
    for (const member of desired) {
      const organization = accountId(member.organizationId);
      const actor = accountId(member.actorId);
      await current().facts.query(
        `INSERT INTO access.membership_inverse (route, account_id, kind, group_id, reservation_id, transaction_id)
         VALUES ($1, $2, 'organization', $3, $4, $4) ON CONFLICT DO NOTHING`,
        [routeOf(actor), actor, organization, randomUUID()],
      );
      await current().facts.query(
        `INSERT INTO access.organization_member (route, organization_id, member_account_id, role, valid, transaction_id)
         VALUES ($1, $2, $3, $4, $5::tstzrange, $6)`,
        [routeOf(organization), organization, actor, member.role, range(member.valid), randomUUID()],
      );
    }
  }

  /** The principal's own authenticated command creates, or revokes, each assignment. */
  async function applyAssignments(desired: Facts['delegatedRequests']): Promise<void> {
    const commands = createDelegationCommands({
      pool: current().kernel,
      access: current().access,
      action: delegateAction,
    });
    const principalActor = async (id: string): Promise<AccountActor> => {
      const person = required(
        [...people.values()].find((candidate) => candidate.id === id),
        `No credentials for ${id}`,
      );
      await current().facts.query(
        `INSERT INTO access.resource_grant (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
         VALUES ($1, $2, 'identity', $2, '', $3, '(,)', $4) ON CONFLICT DO NOTHING`,
        [routeOf(person.id), person.id, delegateAction, randomUUID()],
      );
      const bearer = required(await issue(person.email, loginClient, [delegateAction]), `Auth refused ${id}`);
      return current().access.authenticate(bearer, context());
    };
    for (const [label, existing] of [...assignments]) {
      const wanted = desired.find((r) => r.id === label);
      if (
        wanted &&
        accountId(wanted.createdBy) === existing.principal &&
        accountId(wanted.assignedTo) === existing.assignee
      )
        continue;
      const actor = await principalActor(existing.principal);
      await commands.revoke(
        { pool: current().kernel, actor, deadline: Date.now() + 20_000 },
        { principalId: existing.principal, requestId: existing.id, key: `revoke-${randomUUID()}` },
      );
      assignments.delete(label);
    }
    for (const wanted of desired) {
      if (assignments.has(wanted.id)) continue;
      const principal = accountId(wanted.createdBy);
      const actor = await principalActor(principal);
      const id = newId(routeOf(principal));
      const assignee = accountId(wanted.assignedTo);
      const created = await commands.create(
        { pool: current().kernel, actor, deadline: Date.now() + 20_000 },
        {
          principalId: principal,
          assignedActorId: assignee,
          requestId: id,
          valid: '(,)',
          key: `assign-${randomUUID()}`,
        },
      );
      assignments.set(wanted.id, { principal, assignee, id, urn: created.value.requestedBy });
    }
  }

  // ---- the port ------------------------------------------------------------------------------

  const driver: PermissionDriver = {
    async replaceFacts(next) {
      trace('replace facts');
      for (const client of next.clients) await ensureClient(current(), client.id, client.party);
      for (const label of next.resources) await ensureBoards(label);
      await applyAccounts(next.accounts);
      await applyConsents(
        next.consents,
        next.clients.filter((client) => client.party === 'third').map((client) => client.id),
      );
      await applyGrants(structuredClone(next.grants));
      await applyMemberships(next.memberships);
      await applyAssignments(next.delegatedRequests);
      trace('replaced');
    },

    async setAuthoritativeTime(instant) {
      controlled = new Date(instant);
    },

    async authenticate(input: Login): Promise<Authentication> {
      const person = people.get(input.actorId);
      // An organization holds no credentials: the attempt uses an address Auth has never registered.
      const email = person?.email ?? `${input.actorId}@permission.test`;
      const reference =
        input.requestedBy === undefined ? undefined : (assignments.get(input.requestedBy)?.urn ?? input.requestedBy);
      const requestedBy = reference !== undefined && people.has(reference) ? accountId(reference) : reference;
      const bearer = await issue(email, input.clientId, input.scopes.map(productOf), requestedBy);
      if (bearer === null) return { outcome: 'denied' };
      try {
        await current().access.authenticate(bearer, context());
      } catch (error) {
        if (error instanceof AuthenticationError) return { outcome: 'denied' };
        throw error;
      }
      const handle: Handle = { bearer };
      return { outcome: 'authenticated', session: { handle } };
    },

    async execute(session: Session, operation: Operation, untrustedClaims: Partial<Login> = {}): Promise<Outcome> {
      const { bearer } = session.handle as Handle;
      const access = current().access;
      const pool = current().kernel;
      // Hostile request fields travel with the real request, in every place a client could put them.
      const hostile = Object.entries({
        'actor-id': untrustedClaims.actorId,
        'client-id': untrustedClaims.clientId,
        scope: untrustedClaims.scopes?.map(productOf).join(' '),
        'requested-by': untrustedClaims.requestedBy,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined);
      let lastBody = '';
      const send = async (method: string, path: string, body?: unknown): Promise<number> => {
        const url = new URL(`http://kernel.test${path}`);
        for (const [name, value] of hostile) url.searchParams.set(name.replace('-', '_'), value);
        const response = await (app ??= createKernel({
          pool,
          routeKey,
          clock,
          access: () => access,
          writeRate: createWriteRateLimiter({ secret: hostSecret }),
          rateAttribution: { trustedProxyPeers: [], clientIpHeader: 'cf-connecting-ip' },
        })).handle(
          new Request(url, {
            method,
            headers: {
              authorization: `Bearer ${bearer}`,
              ...Object.fromEntries(hostile.map(([name, value]) => [`x-${name}`, value])),
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    [IDEMPOTENCY_HEADER]: JSON.stringify(`request-${randomUUID()}`),
                  }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        lastBody = await response.text();
        return response.status;
      };
      // Only the product's own refusals are denials: unauthenticated, forbidden, or not disclosed.
      const answer = (status: number, success: number): Outcome => {
        if (status === success) return 'permitted';
        if (status === 401 || status === 403 || status === 404) return 'denied';
        throw new Error(`Kernel answered ${status} where a decision was expected: ${lastBody}`);
      };
      if (operation.kind === 'grant') {
        const grant = operation.grant;
        const resources = new Set(grant.actions.map((action) => resourceFor(grant.resourceId, action).id));
        if (resources.size !== 1 || grant.effect !== 'allow') throw new Error('Unsupported grant operation shape');
        const subject =
          'accountId' in grant.subject
            ? { kind: 'account', id: accountId(grant.subject.accountId) }
            : { kind: 'organization', id: accountId(grant.subject.organizationId), role: grant.subject.role };
        return answer(
          await send('POST', '/v1/grants', {
            resource: resourceFor(grant.resourceId, grant.actions[0]!),
            subject,
            actions: grant.actions.map(productOf),
            valid: range(grant.valid),
          }),
          201,
        );
      }
      const resource = resourceFor(operation.resourceId, operation.action);
      if (operation.action === 'read') return answer(await send('GET', `/v1/boards/${resource.id}`), 200);
      let actor: AccountActor;
      try {
        actor = await access.authenticate(bearer, context());
      } catch (error) {
        if (error instanceof AuthenticationError) return 'denied';
        throw error;
      }
      try {
        if (operation.action === 'write') {
          await createThread(
            { pool, access, routeKey, clock },
            actor,
            {
              title: 'Permission outcome thread',
              body: fromPlainText('Permission outcome body'),
              licence: 'MIT',
              subjectIds: [newId(resource.route)],
              boardId: resource.id,
              visibility: 'published',
            },
            {
              deadline: Date.now() + 20_000,
              idempotencyKey: `${resource.route}:${randomUUID()}`,
              requestId: randomUUID(),
            },
          );
          return 'permitted';
        }
        // No registered operation carries this action: only the Access boundary can answer.
        const check = await accessCheck(access, actor, productOf(operation.action), resource, context());
        const allowed = await withConnection(pool, async (client) => {
          await client.query('BEGIN READ ONLY');
          try {
            return await check(client);
          } finally {
            await client.query('ROLLBACK');
          }
        });
        return allowed ? 'permitted' : 'denied';
      } catch (error) {
        if (
          error instanceof GrantDeniedError ||
          error instanceof ContentNotFoundError ||
          error instanceof ContentForbiddenError
        )
          return 'denied';
        throw error;
      }
    },

    async failEvidence(source, failure) {
      failures.set(source, failure);
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        await world?.stop();
      } finally {
        world = undefined;
        for (const name of [kernelName, authName]) {
          if (!databases.has(name)) continue;
          await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
          databases.delete(name);
        }
        live -= 1;
        open.delete(driver);
      }
    },
  };

  open.add(driver);
  try {
    await build();
  } catch (error) {
    await driver.close().catch(() => {});
    throw error;
  }
  return driver;
}
