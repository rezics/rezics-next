import { randomBytes, randomUUID } from 'node:crypto';
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
import { createPool, withConnection } from '../../src/database/pool.ts';
import { createAccess, INTERNAL_ACTIONS } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { COMMITTED_CONTINUATION_ACTIONS } from '../../src/access/committed-continuations.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { AuthenticationError, accessCheck, type Access, type AccountActor } from '../../src/request/access.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
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
const operatorClient = 'permission-fixture-operator';
const managementAction = 'account:manage';
const delegateAction = 'access:delegate';
const audience = 'https://permission.api.test';
/** The suite's abstract actions and the registered product actions that carry them. */
const productAction: Record<string, string> = {
  read: 'board:read',
  write: 'thread:create',
  'grant:manage': 'access:grant',
};
const registeredScopes = [...new Set([...Object.values(productAction), delegateAction])].sort();
/**
 * Auth stamps tokens with the wall clock and Access checks them against the kernel clock, so the suite's instants
 * are translated onto the wall clock: the first instant it sets becomes this far ahead of now, and every later
 * instant, and every validity bound in the facts, keeps its distance from that first one.
 */
const LEAD_MS = 60_000;
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
/** What the suite holds as a session: the product's cookie session and how it was established. */
type Handle = {
  email: string;
  clientId: string;
  scopes: string[];
  requestedBy?: string;
  cookie: string;
  replaced: boolean;
};
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

type Bindings = ReturnType<typeof createNativeAccountBindings>;
type World = {
  kernel: Pool;
  facts: Pool;
  auth: Pool;
  proofs: Pool;
  host: Awaited<ReturnType<typeof createAuthHost>>;
  service: AuthService;
  access: Access;
  bindings: Bindings;
  stop(): Promise<void>;
};

async function openWorld(
  kernelName: string,
  authName: string,
  clock: () => Date,
  instrument: (database: 'kernel' | 'auth') => (client: PoolClient) => void = () => () => {},
): Promise<World> {
  const kernel = createPool(databaseUrl(kernelName));
  kernel.options.max = 6;
  const facts = new Pool({ connectionString: databaseUrl(kernelName), max: 2 });
  const auth = new Pool({ connectionString: databaseUrl(authName) });
  const proofs = new Pool({ connectionString: databaseUrl(authName), max: 2 });
  // Hooked before the first connection, so no connection escapes the injected failures.
  kernel.on('connect', instrument('kernel'));
  auth.on('connect', instrument('auth'));
  for (const pool of [facts, auth, proofs]) pool.on('error', () => {});
  let service: AuthService | undefined;
  // Native bindings and restored operator management must resolve the same roles as Access.
  // Keep internal metadata authoritative, including actions without mounted routes.
  const actions = new Map([
    ...LIFECYCLE_ACTIONS,
    ...COMMITTED_CONTINUATION_ACTIONS,
    ...productionActions(),
    ...INTERNAL_ACTIONS,
  ]);
  for (const scope of [...registeredScopes, managementAction])
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
    bindings,
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

async function ensureClient(
  world: World,
  id: string,
  party: 'first' | 'third',
  scopes: readonly string[] = registeredScopes,
): Promise<void> {
  const known = await world.auth.query('SELECT 1 FROM auth_client WHERE client_id=$1', [id]);
  if (known.rowCount) return;
  await world.service.internal.registerClient({ clientId: id, firstParty: party === 'first', scopes: [...scopes] });
}

async function prepareFixture(): Promise<Fixture> {
  const names = { kernel: `permission_kernel_${processSuffix}`, auth: `permission_auth_${processSuffix}` };
  trace('prepare fixture');
  await admin.query(`CREATE DATABASE ${quote(names.kernel)} TEMPLATE ${quote(sourceName)}`);
  databases.add(names.kernel);
  await createAuthDatabase(baseUrl.href, names.auth);
  databases.add(names.auth);
  const world = await openWorld(names.kernel, names.auth, () => new Date());
  try {
    await ensureClient(world, loginClient, 'first');
    await ensureClient(world, operatorClient, 'first', [managementAction]);
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

  // Trusted domain time: the suite's instants shifted onto the wall clock (see LEAD_MS). Until the suite sets
  // one, time is the wall clock itself.
  let offset: number | undefined;
  let controlled: Date | undefined;
  const clock = () => new Date(controlled ?? Date.now());
  const shifted = (instant: string): string => {
    const at = Date.parse(instant);
    if (offset === undefined) throw new Error('The suite must set the authoritative time before it states facts');
    return new Date(at + offset).toISOString();
  };

  // Authoritative read failures are injected beneath the product, at the connection.
  const failures = new Map<Evidence, 'missing' | 'unavailable'>();
  const instrument = (database: 'kernel' | 'auth') => (client: PoolClient) => {
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
        // An unreachable store, as the database driver reports it: connection failure.
        const error =
          failure === 'unavailable'
            ? Object.assign(new Error(`${source} evidence unavailable`), { code: '08006' })
            : null;
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
  /** Sessions this namespace issued, by account: a consent reduction ends the product's sessions of its account. */
  const sessions = new Map<string, Set<Handle>>();
  let nextBoard = 0;
  let nextOrganization = 0;
  let app: ReturnType<typeof createKernel> | undefined;

  const current = () => required(world, 'Permission driver is closed');
  const context = () => ({ pool: current().kernel, deadline: Date.now() + 20_000 });

  async function request(path: string, body: unknown, cookie = ''): Promise<Response> {
    return current().host.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  }
  async function unexpected(step: string, response: Response): Promise<never> {
    throw new Error(`Auth ${step} failed unexpectedly: ${response.status} ${await response.text()}`);
  }
  /** A product refusal is a null result; anything else throws. Auth answers 503 when a reader it needs fails. */
  async function classify(step: string, response: Response): Promise<null> {
    if (refusal(response.status) || (response.status === 503 && failures.size > 0)) return null;
    return unexpected(step, response);
  }

  async function signIn(email: string, clientId: string, scopes: readonly string[]): Promise<string | null> {
    const signed = await request('/signin', { email, password, client_id: clientId, scope: scopes });
    if (!signed.ok) {
      trace(`signin refused ${signed.status} ${email}`);
      return classify('signin', signed);
    }
    return signed.headers
      .getSetCookie()
      .map((item) => item.split(';')[0])
      .join('; ');
  }
  async function mint(cookie: string, requestedBy?: string): Promise<string | null> {
    const token = await request('/token', requestedBy === undefined ? {} : { requested_by: requestedBy }, cookie);
    if (!token.ok) {
      trace(`token refused ${token.status}`);
      return classify('token', token);
    }
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
    world = await openWorld(kernelName, authName, clock, instrument);
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
  const range = (valid: { start: string; end: string }) => `[${shifted(valid.start)},${shifted(valid.end)})`;
  const personOf = (id: string): Person =>
    required(
      [...people.values()].find((candidate) => candidate.id === id),
      `No credentials for ${id}`,
    );

  // Consent is Auth's authoritative storage. Narrowing it is a reduction through Auth and Access; widening
  // is a fact the account holder or operator's manager states, seeded where Auth stores it.

  async function consentOf(id: string, client: string): Promise<string[]> {
    const rows = await current().auth.query<{ scopes: string[] }>(
      'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
      [id, client],
    );
    return rows.rows[0]?.scopes ?? [];
  }

  /** The operator of an account, when it is automated. */
  async function operatorOf(id: string): Promise<string | null> {
    const rows = await current().facts.query<{ operator: string | null; state: string }>(
      'SELECT operator_account_id AS operator, state FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(id), id],
    );
    return rows.rows[0]?.operator ?? null;
  }

  /** Reduce an account's consent for a client to `keep`, through the session class Auth accepts for it. */
  async function reduceConsent(label: string, client: string, keep: string[]): Promise<void> {
    const person = personOf(accountId(label));
    trace(`reduce consent of ${label} on ${client} to ${keep.join(',') || 'nothing'}`);
    const state = (
      await current().facts.query<{ state: string }>(
        'SELECT state FROM access.account WHERE route=$1 AND account_id=$2',
        [routeOf(person.id), person.id],
      )
    ).rows[0]!.state;
    // A reduction needs an active account; a fact that suspends it is applied afterwards.
    const setState = (value: string) =>
      current().facts.query('UPDATE access.account SET state=$3 WHERE route=$1 AND account_id=$2', [
        routeOf(person.id),
        person.id,
        value,
      ]);
    if (state !== 'active') await setState('active');
    try {
      const operator = await operatorOf(person.id);
      let managing = '';
      if (operator === null) {
        managing = required(await signIn(person.email, loginClient, []), `Auth refused ${label}`);
      } else {
        // An automated account is reduced from a session its operator's manager opened for it.
        const manager = personOf(operator);
        const cookie = required(
          await signIn(manager.email, operatorClient, [managementAction]),
          'Auth refused the operator',
        );
        const bearer = required(await mint(cookie), 'Auth issued no operator token');
        const actor = await current().access.authenticate(bearer, context());
        const account = required(
          await readAccount(current().kernel, routeOf(actor.accountId), actor.accountId),
          'No operator row',
        );
        const opening = await current().bindings.workflowPorts.authorizeOpening!(
          { actor, account, deadline: Date.now() + 20_000 },
          { operatorAccountId: operator, subjectAccountId: person.id, purpose: 'session', key: randomUUID() },
        );
        const opened = await current().service.internal.openAutomatedSession({
          authorization: opening.value.receiptId,
          subjectAccountId: person.id,
          headers: new Headers({ cookie }),
        });
        if (opened.status !== 200) return unexpected('operator opening', opened);
        managing = opened.headers
          .getSetCookie()
          .map((item) => item.split(';')[0])
          .join('; ');
      }
      const reduced = await request('/consent', { client_id: client, scope: keep }, managing);
      if (!reduced.ok) await unexpected('consent reduction', reduced);
    } finally {
      if (state !== 'active') await setState(state);
    }
    // The product ended every session of the account; the suite's sessions are re-established on next use.
    for (const handle of sessions.get(person.id) ?? []) handle.replaced = true;
  }

  async function applyConsents(desired: Facts['consents'], thirdParty: readonly string[]): Promise<void> {
    for (const [label, person] of people) {
      for (const client of thirdParty) {
        const wanted = [
          ...new Set(
            desired.filter((c) => c.actorId === label && c.clientId === client).flatMap((c) => c.scopes.map(productOf)),
          ),
        ].sort();
        const held = await consentOf(person.id, client);
        const kept = held.filter((scope) => wanted.includes(scope));
        if (kept.length < held.length) await reduceConsent(label, client, kept);
        if (wanted.length > kept.length)
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
      await linkOperator(id, operator);
      // The authentication floor never decreases; a fact below the stored floor cannot be restated.
      await current().facts.query(
        `UPDATE access.account
         SET state = $3, minimum_authn_epoch = GREATEST(minimum_authn_epoch, $4::bigint)
         WHERE route = $1 AND account_id = $2`,
        [routeOf(id), id, account.state, account.minimumAuthnEpoch],
      );
    }
  }

  /** An account is automated when an operator holds a live reservation for it, as the operator commands record. */
  async function linkOperator(id: string, operator: string | null): Promise<void> {
    const held = (
      await current().facts.query<{ operator: string | null; reservation: string | null }>(
        'SELECT operator_account_id AS operator, operator_reservation_id AS reservation FROM access.account WHERE route=$1 AND account_id=$2',
        [routeOf(id), id],
      )
    ).rows[0]!;
    if (held.operator === operator) return;
    const facts = current().facts;
    if (held.operator !== null) {
      await facts.query(
        'UPDATE access.account SET operator_account_id=NULL, operator_reservation_id=NULL WHERE route=$1 AND account_id=$2',
        [routeOf(id), id],
      );
      await facts.query(
        'DELETE FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
        [routeOf(held.operator), held.operator, held.reservation],
      );
      await facts.query(
        'UPDATE access.operator_relation_slot SET terminal=true WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3',
        [routeOf(id), id, held.reservation],
      );
    }
    if (operator === null) return;
    const reservation = Bun.randomUUIDv7();
    const transaction = randomUUID();
    await facts.query(
      `INSERT INTO access.lifecycle_coordination (route, account_id, reservation_id, related_account_id, purpose, transaction_id)
       VALUES ($1, $2, $3, $4, 'operator', $5)`,
      [routeOf(operator), operator, reservation, id, transaction],
    );
    await facts.query(
      `INSERT INTO access.operator_relation_slot (route, subject_account_id, reservation_id, operator_account_id, terminal, transaction_id)
       VALUES ($1, $2, $3, $4, false, $5)`,
      [routeOf(id), id, reservation, operator, transaction],
    );
    await facts.query(
      'UPDATE access.account SET operator_account_id=$3, operator_reservation_id=$4 WHERE route=$1 AND account_id=$2',
      [routeOf(id), id, operator, reservation],
    );
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
      const person = personOf(id);
      await current().facts.query(
        `INSERT INTO access.resource_grant (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
         VALUES ($1, $2, 'identity', $2, '', $3, '(,)', $4) ON CONFLICT DO NOTHING`,
        [routeOf(person.id), person.id, delegateAction, randomUUID()],
      );
      const cookie = required(await signIn(person.email, loginClient, [delegateAction]), `Auth refused ${id}`);
      const bearer = required(await mint(cookie), `Auth refused ${id}`);
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

  /** Mint an access token from the session, re-establishing it first when a reduction ended it. */
  async function token(handle: Handle): Promise<string | null> {
    if (handle.replaced) {
      const cookie = await signIn(handle.email, handle.clientId, handle.scopes);
      if (cookie === null) return null;
      handle.cookie = cookie;
      handle.replaced = false;
    }
    return mint(handle.cookie, handle.requestedBy);
  }

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
      const at = Date.parse(instant);
      offset ??= Date.now() + LEAD_MS - at;
      controlled = new Date(at + offset);
    },

    async authenticate(input: Login): Promise<Authentication> {
      const person = people.get(input.actorId);
      // An organization holds no credentials: the attempt uses an address Auth has never registered.
      const email = person?.email ?? `${input.actorId}@permission.test`;
      const reference =
        input.requestedBy === undefined ? undefined : (assignments.get(input.requestedBy)?.urn ?? input.requestedBy);
      const requestedBy = reference !== undefined && people.has(reference) ? accountId(reference) : reference;
      const scopes = input.scopes.map(productOf);
      const cookie = await signIn(email, input.clientId, scopes);
      if (cookie === null) return { outcome: 'denied' };
      const bearer = await mint(cookie, requestedBy);
      if (bearer === null) return { outcome: 'denied' };
      try {
        const actor = await current().access.authenticate(bearer, context());
        const handle: Handle = {
          email,
          clientId: input.clientId,
          scopes,
          cookie,
          replaced: false,
          ...(requestedBy === undefined ? {} : { requestedBy }),
        };
        const held = sessions.get(actor.accountId) ?? new Set();
        held.add(handle);
        sessions.set(actor.accountId, held);
        return { outcome: 'authenticated', session: { handle } };
      } catch (error) {
        if (error instanceof AuthenticationError) return { outcome: 'denied' };
        throw error;
      }
    },

    async execute(session: Session, operation: Operation, untrustedClaims: Partial<Login> = {}): Promise<Outcome> {
      const bearer = await token(session.handle as Handle);
      if (bearer === null) return 'denied';
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
          requestDeadlineMs: 30_000,
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
      // Only the product's own answers are decisions: a refusal, a concealed resource, or retryable
      // unavailability that applied nothing.
      const answer = (status: number, success: number): Outcome => {
        trace(`kernel ${status} ${lastBody.slice(0, 200)}`);
        if (status === success) return 'permitted';
        if (status === 401 || status === 403 || status === 404) return 'denied';
        if (status === 503) {
          const effect = (JSON.parse(lastBody) as { effect_status?: unknown }).effect_status;
          if (effect === 'not_applied' || effect === 'not_applicable') return 'denied';
        }
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
      if (operation.action === 'write')
        return answer(
          await send('POST', '/v1/threads', {
            title: 'Permission outcome thread',
            body: fromPlainText('Permission outcome body'),
            licence: 'MIT',
            subjectIds: [newId(resource.route)],
            boardId: resource.id,
            visibility: 'published',
          }),
          201,
        );
      // No registered operation carries this action: only the Access boundary can answer.
      let actor: AccountActor;
      try {
        actor = await access.authenticate(bearer, context());
      } catch (error) {
        if (error instanceof AuthenticationError) return 'denied';
        throw error;
      }
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
