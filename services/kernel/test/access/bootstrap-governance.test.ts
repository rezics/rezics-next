import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService, createProvisioningEvidenceVerifier } from '@rezics/auth';
import { createPool } from '../../src/database/pool.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import {
  bootstrapGovernance,
  PLATFORM_RESOURCE,
  PLATFORM_GOVERNANCE_ROLE,
} from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { readBatch, EVENT_TYPES } from '../../src/events/log.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const root = new URL('../../../../', import.meta.url).pathname;
const script = 'services/kernel/scripts/bootstrap-governance.ts';
const url = process.env.DATABASE_URL!;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const reader = new Pool({ connectionString: url });
const actions = [
  'access:grant',
  'subject:create',
  'subject:batch_write',
  'source_statistic:write',
  'source_fence:read',
  'source_fence:takedown',
  'media:import_from_url',
  'definitions:publish',
  'definitions:activate',
  'context:create',
  'offer:create',
  'payout_statement:mark_paid',
];
const imports = [
  'subject:batch_write',
  'source_statistic:write',
  'source_fence:read',
  'source_fence:takedown',
  'media:import_from_url',
];
const catalogue = new Map(actions.map((action) => [action, { anonymous: false }]));
const audit = 'com.rezics.access.governance.bootstrapped.v1';
let auth: Awaited<ReturnType<typeof createAuthService>>;
let authPool: Pool;
let person: string;
let other: string;
let automated: string;
let authDatabase: string;
let access: ReturnType<typeof createAccess>;
const password = 'correct horse battery staple';

function cli(id: string) {
  return Bun.spawn(['bun', script, '--account', id], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
async function invoke(id: string, success = true) {
  const child = cli(id);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: success ? 0 : 1, stderr: success ? '' : expect.any(String) });
  expect(stdout).toBe('');
  return stderr;
}
async function snapshot() {
  const marker = await reader.query('SELECT * FROM access.governance_bootstrap WHERE route=0 AND resource_id=$1', [
    PLATFORM_RESOURCE.id,
  ]);
  const grants = await reader.query(
    'SELECT * FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND grant_role=$2',
    [PLATFORM_RESOURCE.id, PLATFORM_GOVERNANCE_ROLE],
  );
  const events = await reader.query('SELECT * FROM core.outbox WHERE partition_no=0 AND type=$1 ORDER BY position', [
    audit,
  ]);
  const standing = await reader.query(
    "SELECT * FROM access.standing_parent_installation WHERE route=0 AND resource_id=$1 AND actions=ARRAY['organization:create']::text[]",
    [PLATFORM_RESOURCE.id],
  );
  const standingGrants = await reader.query(
    "SELECT * FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND action='organization:create'",
    [PLATFORM_RESOURCE.id],
  );
  return {
    marker: marker.rows,
    grants: grants.rows,
    events: events.rows,
    standing: standing.rows,
    standingGrants: standingGrants.rows,
  };
}
async function reset() {
  // Starting facts for independent one-time installation scenarios; no fixture installs the outcome.
  await reader.query(
    "DELETE FROM access.standing_parent_installation WHERE actions=ARRAY['organization:create']::text[]",
  );
  await reader.query("DELETE FROM access.resource_grant WHERE route=0 AND action='organization:create'");
  await reader.query("DELETE FROM core.receipt WHERE command_kind='access.standing-parent.install'");
  await reader.query('DELETE FROM access.governance_bootstrap');
  await reader.query('DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1', [PLATFORM_RESOURCE.id]);
  await reader.query('DELETE FROM core.outbox WHERE partition_no=0 AND type=$1', [audit]);
}
async function context(id: string, scopes = actions, using = access) {
  const response = await auth.handler(
    new Request('https://auth.example.test/signin', {
      method: 'POST',
      headers: { origin: 'https://auth.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'operator-test', scope: scopes }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await auth.handler(
    new Request('https://auth.example.test/token', {
      method: 'POST',
      headers: { origin: 'https://auth.example.test', cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(issued.status).toBe(200);
  const body = (await issued.json()) as { access_token: string };
  const boundary = { pool, deadline: Date.now() + 10_000 };
  const actor = await using.authenticate(body.access_token, boundary);
  expect(actor.kind).toBe('account');
  return { ...boundary, actor: actor as AccountActor };
}
async function allowed(
  id: string,
  action: string,
  resource = PLATFORM_RESOURCE as { route: number; id: string },
  scopes = actions,
) {
  const ctx = await context(id, scopes);
  return (await accessCheck(access, ctx.actor, action, resource, ctx))(pool);
}

beforeAll(async () => {
  authDatabase = `bootstrap_auth_${process.pid}`;
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabase}`;
  await reader.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  const evidence = createProvisioningEvidenceVerifier({ database: authPool });
  const lifecycle = createLifecycleInternals({
    pool,
    routeKey: new Uint8Array(32).fill(57),
    provisioningEvidence: evidence.resolve,
    recoveryEvidence: async () => null,
  });
  const proofs = createRegistrationProofBindings({
    pool,
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(93)]]) },
  });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'bootstrap-test',
    alg: 'ES256',
  };
  const bindings = createAuthBindings({ pool, ...proofs });
  auth = await createAuthService({
    database: authPool,
    issuer: 'https://auth.example.test',
    audience: 'https://api.rezics.test',
    secret: 'test-secret-with-at-least-thirty-two-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: {
      ...bindings,
      async authorizeProvisioning(reference) {
        // The host composes the real native registration receipt with Auth's exact
        // provisioning metadata; the generic binding currently returns identity only.
        const approval = await bindings.authorizeProvisioning(reference);
        const receipt = await proofs.verifyProvisioningReceipt(reference);
        const account = await readAccount(pool, routeOf(approval.accountId)!, approval.accountId);
        if (!receipt || !account) throw new Error('Missing committed registration');
        return {
          ...approval,
          receipt: {
            registrationId: receipt.registrationId,
            reservationId: receipt.registrationId,
            expiresAt: receipt.expiresAt,
            authnEpoch: Number(account.minimumAuthnEpoch),
          },
        };
      },
    },
  });
  // gate:any is an internal governance action, absent from the route catalogue but required to administer the role.
  await auth.internal.registerClient({
    clientId: 'operator-test',
    firstParty: true,
    scopes: [...actions, 'gate:any'],
  });
  async function human(handle: string) {
    const key = `bootstrap-${handle}`;
    const accountId = lifecycle.registrationTarget(key);
    const reservation = await lifecycle.reserveHandle({ accountId, handle, key });
    const input = { accountId, handle, key, reservationId: reservation.value.reservationId };
    const outcome = await lifecycle.createPending(input);
    const authorization = await proofs.createProvisioningReference({ input, outcome });
    expect(authorization).toBeString();
    const result = await auth.internal.provisionPassword({
      authorization: authorization!,
      email: `${accountId}@example.test`,
      password,
    });
    expect(result.provisioningEvidence).toBeDefined();
    await lifecycle.claimHandle({ ...input, key: `${key}-claim`, evidence: result.provisioningEvidence });
    await lifecycle.activate({ accountId, key: `${key}-activate`, evidence: result.provisioningEvidence });
    return accountId;
  }
  person = await human('governance_one');
  other = await human('governance_two');
  automated = await human('governance_automation');
  // Establish only the recipient's starting operator relationship. Its credential
  // was provisioned by Auth; delegated Global permissions come only from commands.
  await reader.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(automated),
    automated,
    person,
  ]);
  access = createAccess({
    actions: catalogue,
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
      fetch: async () => auth.handler(new Request('https://auth.example.test/.well-known/jwks.json')),
    },
  });
}, 60_000);
afterAll(async () => {
  await authPool?.end();
  if (authDatabase) await dropTestDatabase(reader, authDatabase);
  await pool.end();
  await reader.end();
});

test('exact root CLI installs one durable normal Global role and one registered audit atomically', async () => {
  await invoke(person);
  const first = await snapshot();
  expect(first.marker).toHaveLength(1);
  expect(first.marker[0]).toMatchObject({ route: 0, resource_id: PLATFORM_RESOURCE.id, account_id: person });
  expect(first.standing).toHaveLength(1);
  expect(first.standingGrants).toHaveLength(1);
  expect(first.standingGrants[0]).toMatchObject({
    subject_kind: 'active_accounts',
    action: 'organization:create',
    resource_id: PLATFORM_RESOURCE.id,
  });
  expect(first.standing[0].transaction_id).toBe(first.standingGrants[0].transaction_id);
  expect(first.grants).toHaveLength(1);
  expect(first.grants[0]).toMatchObject({
    subject_kind: 'identity',
    subject_id: person,
    subject_role: '',
    grant_role: PLATFORM_GOVERNANCE_ROLE,
  });
  expect(first.events).toHaveLength(1);
  expect(first.events[0].data).toEqual({
    accountId: person,
    resource: PLATFORM_RESOURCE,
    role: PLATFORM_GOVERNANCE_ROLE,
  });
  expect(first.marker[0].transaction_id).toBe(first.grants[0].transaction_id);
  expect(first.events[0].type in EVENT_TYPES).toBe(true);
  expect(await bootstrapGovernance(pool, person)).toMatchObject({ replayed: true });
  await invoke(person);
  await invoke(other, false);
  expect(await snapshot()).toEqual(first);
  const result = await readBatch(pool, {
    consumer: 'bootstrap_audit',
    partition: 0,
    apply: async (envelopes) => {
      expect(envelopes.flatMap((e) => e.events).filter((e) => e.type === audit)).toHaveLength(1);
    },
  });
  expect(result.status).toBe('read');
});

test('Auth-issued scopes and installed formula govern delegation, revocation and unrelated resources', async () => {
  const semanticActions = actionCatalogue(createKernel({ pool, routeKey: new Uint8Array(32) }));
  const semantic = createAccess({
    actions: semanticActions,
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
      fetch: async () => auth.handler(new Request('https://auth.example.test/.well-known/jwks.json')),
    },
  });
  const semanticContext = await context(person, actions, semantic);
  expect(
    await (
      await accessCheck(semantic, semanticContext.actor, 'subject:create', PLATFORM_RESOURCE, semanticContext)
    )(pool),
  ).toBe(true);
  // Mounted governance actions are conferred; gate:any stays off the route catalogue.
  expect(semanticActions.has('media:import_from_url')).toBe(true);
  expect(semanticActions.has('gate:any')).toBe(false);
  expect(
    await (
      await accessCheck(semantic, semanticContext.actor, 'media:import_from_url', PLATFORM_RESOURCE, semanticContext)
    )(pool),
  ).toBe(true);
  expect(
    await (
      await accessCheck(semantic, semanticContext.actor, 'gate:any', PLATFORM_RESOURCE, semanticContext)
    )(pool),
  ).toBe(false);
  expect(await allowed(person, 'subject:create')).toBe(true);
  expect(await allowed(person, 'absent:action')).toBe(false);
  expect(await allowed(person, 'subject:create', PLATFORM_RESOURCE, ['access:grant'])).toBe(false);
  expect(await allowed(person, 'subject:create', { route: routeOf(person)!, id: person })).toBe(false);
  expect(await allowed(person, 'subject:create', { route: 0, id: newId(0) })).toBe(false);
  const grants = createGrantCommands({ pool, access, managementAction: 'access:grant' });
  const input = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: automated },
    actions: imports,
    valid: '(,)',
    key: 'delegate-imports',
  };
  await expect(
    grants.create(await context(person, imports), { ...input, key: 'missing-management-scope' }),
  ).rejects.toThrow();
  await grants.create(await context(person), input);
  const rows = await reader.query(
    'SELECT action FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 ORDER BY action',
    [PLATFORM_RESOURCE.id, automated],
  );
  expect(rows.rows.map((r) => r.action)).toEqual([...imports].sort());
  for (const action of imports) expect(await allowed(automated, action)).toBe(true);
  expect(await allowed(automated, imports[0]!, PLATFORM_RESOURCE, ['access:grant'])).toBe(false);
  expect(await allowed(automated, 'subject:create')).toBe(false);
  // The human can revoke delegated rights through the same formula.
  await grants.revoke(await context(person), { ...input, key: 'revoke-imports' });
  expect(
    (
      await reader.query('SELECT 1 FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2', [
        PLATFORM_RESOURCE.id,
        automated,
      ])
    ).rows,
  ).toHaveLength(0);
  for (const action of imports) expect(await allowed(automated, action)).toBe(false);
  await grants.revokeRole(await context(person, [...actions, 'gate:any']), {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: person },
    role: PLATFORM_GOVERNANCE_ROLE,
    valid: '(,)',
    key: 'revoke-governance',
  });
  expect(await allowed(person, 'subject:create')).toBe(false);
  await expect(grants.create(await context(person), { ...input, key: 'denied' })).rejects.toThrow();
  await invoke(person);
  await invoke(other, false);
  const state = await snapshot();
  expect(state.marker).toHaveLength(1);
  expect(state.grants).toHaveLength(0);
  expect(state.events).toHaveLength(1);
});

test('reserved governance expansion intersects mounted actions while arbitrary roles retain strict validation', () => {
  const resolved = resolveResourceRoles(new Map([['subject:create', { anonymous: false }]]), {
    roles: { 'custom.invalid': ['subject:create', 'absent:action'] },
    types: {},
  });
  expect(resolved.roles.get(PLATFORM_GOVERNANCE_ROLE)).toEqual(['subject:create']);
  expect(resolved.roles.has('custom.invalid')).toBe(false);
  const semantic = actionCatalogue(createKernel({ pool, routeKey: new Uint8Array(32) }));
  const governance = resolveResourceRoles(semantic).roles.get(PLATFORM_GOVERNANCE_ROLE);
  expect(semantic.has('media:import_from_url')).toBe(true);
  expect(semantic.has('gate:any')).toBe(false);
  expect(governance).toContain('subject:create');
  expect(governance).toContain('media:import_from_url');
  expect(governance).not.toContain('gate:any');
  expect(() =>
    resolveResourceRoles(catalogue, { roles: { [PLATFORM_GOVERNANCE_ROLE]: ['access:grant'] }, types: {} }),
  ).toThrow();
});

test('missing or nonhuman, inactive or fenced accounts refuse without marker, grant or audit', async () => {
  await reset();
  await invoke(newId(0x7777), false);
  await invoke(automated, false);
  for (const state of ['pending', 'suspended', 'deleted']) {
    await setFixtureAccountState(reader, other, state);
    await invoke(other, false);
  }
  await reader.query("UPDATE access.account SET state='active',authn_fenced=true WHERE route=$1 AND account_id=$2", [
    routeOf(other),
    other,
  ]);
  await invoke(other, false);
  await reader.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
    routeOf(other),
    other,
  ]);
  const organization = newId(0x7654);
  await reader.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'organization','active',$2)",
    [routeOf(organization), organization],
  );
  await invoke(organization, false);
  expect(await snapshot()).toEqual({ marker: [], grants: [], events: [], standing: [], standingGrants: [] });
});

test('only the seeded real Global row admits installation and native failure rolls everything back', async () => {
  for (const failure of ['missing-global', 'wrong-kind', 'audit']) {
    if (failure === 'missing-global')
      await reader.query('DELETE FROM semantic.context WHERE route=0 AND context_id=$1', [PLATFORM_RESOURCE.id]);
    if (failure === 'wrong-kind')
      await reader.query("UPDATE semantic.context SET kind='community' WHERE route=0 AND context_id=$1", [
        PLATFORM_RESOURCE.id,
      ]);
    if (failure === 'audit')
      await reader.query(`ALTER TABLE core.outbox ADD CONSTRAINT bootstrap_failure CHECK (type <> '${audit}')`);
    try {
      await invoke(person, false);
      expect(await snapshot()).toEqual({ marker: [], grants: [], events: [], standing: [], standingGrants: [] });
    } finally {
      if (failure === 'audit') await reader.query('ALTER TABLE core.outbox DROP CONSTRAINT bootstrap_failure');
      else
        await reader.query(
          "INSERT INTO semantic.context(route,context_id,kind,labels) VALUES(0,$1,'global','{\"en\":\"Global\"}') ON CONFLICT(route,context_id) DO UPDATE SET kind='global'",
          [PLATFORM_RESOURCE.id],
        );
    }
  }
});

test('organization standing setup has its own marker and resumes an interrupted deployment', async () => {
  await reset();
  // The existing Semantic standing setup already occupies the Global parent.
  await reader.query(
    `INSERT INTO access.standing_parent_installation(route,resource_id,actions,transaction_id)
    VALUES(0,$1,ARRAY['statement:propose','subject:create'],$1)`,
    [PLATFORM_RESOURCE.id],
  );
  await reader.query(`ALTER TABLE access.standing_parent_installation ADD CONSTRAINT interrupted_organization_setup
    CHECK (actions <> ARRAY['organization:create']::text[])`);
  try {
    await invoke(person, false);
    const partial = await snapshot();
    expect(partial.marker).toHaveLength(1);
    expect(partial.grants).toHaveLength(1);
    expect(partial.standing).toHaveLength(0);
    expect(partial.standingGrants).toHaveLength(0);
  } finally {
    await reader.query(
      'ALTER TABLE access.standing_parent_installation DROP CONSTRAINT interrupted_organization_setup',
    );
  }
  await invoke(person);
  const completed = await snapshot();
  expect(completed.standing).toHaveLength(1);
  expect(completed.standingGrants).toHaveLength(1);
  await invoke(person);
  expect(await snapshot()).toEqual(completed);
  expect(
    (
      await reader.query('SELECT 1 FROM access.standing_parent_installation WHERE route=0 AND resource_id=$1', [
        PLATFORM_RESOURCE.id,
      ])
    ).rows,
  ).toHaveLength(2);
});

test('concurrent same and different named CLI calls linearize to one durable winner', async () => {
  for (const ids of [
    [person, person],
    [person, other],
  ]) {
    await reset();
    const children = ids.map(cli);
    const exits = await Promise.all(
      children.map(async (child) => {
        const stderr = await new Response(child.stderr).text();
        const code = await child.exited;
        return { code, stderr };
      }),
    );
    expect(exits.filter((e) => e.code === 0)).toHaveLength(ids[0] === ids[1] ? 2 : 1);
    const state = await snapshot();
    expect(state.marker).toHaveLength(1);
    expect(state.grants).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.grants[0].subject_id).toBe(state.marker[0].account_id);
    expect(state.events[0].data.accountId).toBe(state.marker[0].account_id);
  }
});
