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
  bootstrapLocalShowcaseBoardCreation,
  BootstrapGovernanceUnavailableError,
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
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const root = new URL('../../../../', import.meta.url).pathname;
const script = 'services/kernel/scripts/bootstrap-governance.ts';
const url = process.env.DATABASE_URL!;
const receiptKeys = workerTestEnv().KERNEL_RECEIPT_KEYS;
process.env.KERNEL_RECEIPT_KEYS = receiptKeys;
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
    env: { ...process.env, DATABASE_URL: url, KERNEL_RECEIPT_KEYS: receiptKeys },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
function mountedKernel() {
  return createKernel({ pool, routeKey: new Uint8Array(32), receiptKeys: testReceiptKeys() });
}
async function withoutGlobalRow(kind: 'missing' | 'community') {
  const client = await reader.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role='replica'");
    if (kind === 'missing') {
      await client.query('DELETE FROM semantic.context WHERE route=0 AND context_id=$1', [PLATFORM_RESOURCE.id]);
    } else {
      await client.query("UPDATE semantic.context SET kind='community' WHERE route=0 AND context_id=$1", [
        PLATFORM_RESOURCE.id,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  const boundary = { pool, deadline: Date.now() + 30_000 };
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

function fixtureAccess(entries: ReturnType<typeof actionCatalogue> = catalogue) {
  return createAccess({
    actions: entries,
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/.well-known/jwks.json',
      fetch: async () => auth.handler(new Request('https://auth.example.test/.well-known/jwks.json')),
    },
  });
}

beforeAll(async () => {
  configureTestReceiptKeys(pool);
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
    scopes: [
      ...new Set([
        ...actions,
        ...[...actionCatalogue(mountedKernel()).keys()].filter((scope) => scope !== 'media:complete'),
        'gate:any',
      ]),
    ],
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
  access = fixtureAccess();
}, 60_000);
afterAll(async () => {
  await authPool?.end();
  if (authDatabase) await dropTestDatabase(reader, authDatabase);
  await pool.end();
  await reader.end();
});

test.serial('exact root CLI installs one durable normal Global role and one registered audit atomically', async () => {
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
  expect(first.events[0].type in EVENT_TYPES()).toBe(true);
  expect(await bootstrapGovernance(pool, person)).toMatchObject({ replayed: true });
  await invoke(person);
  await invoke(other, false);
  expect(await snapshot()).toEqual(first);
  // Read through ordinary Access after both CLI processes have exited; the
  // deployment bootstrap is not the authority for later requests.
  expect(await allowed(person, 'subject:create')).toBe(true);
  expect(await allowed(other, 'subject:create')).toBe(false);
  const result = await readBatch(pool, {
    consumer: 'bootstrap_audit',
    partition: 0,
    apply: async (envelopes) => {
      expect(envelopes.flatMap((e) => e.events).filter((e) => e.type === audit)).toHaveLength(1);
    },
  });
  expect(result.status).toBe('read');
});

test.serial(
  'Auth-issued scopes and installed formula govern delegation, revocation and unrelated resources',
  async () => {
    await invoke(person);
    const semanticActions = actionCatalogue(mountedKernel());
    const semantic = fixtureAccess(semanticActions);
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
  },
);

test.serial(
  'reserved governance expansion intersects mounted actions while arbitrary roles retain strict validation',
  () => {
    const resolved = resolveResourceRoles(new Map([['subject:create', { anonymous: false }]]), {
      roles: { 'custom.invalid': ['subject:create', 'absent:action'] },
      types: {},
    });
    expect(resolved.roles.get(PLATFORM_GOVERNANCE_ROLE)).toEqual(['subject:create']);
    expect(resolved.roles.has('custom.invalid')).toBe(false);
    const semantic = actionCatalogue(mountedKernel());
    const governance = resolveResourceRoles(semantic).roles.get(PLATFORM_GOVERNANCE_ROLE);
    expect(semantic.has('media:import_from_url')).toBe(true);
    expect(semantic.has('gate:any')).toBe(false);
    expect(governance).toContain('subject:create');
    expect(governance).toContain('media:import_from_url');
    expect(governance).not.toContain('gate:any');
    expect(() =>
      resolveResourceRoles(catalogue, { roles: { [PLATFORM_GOVERNANCE_ROLE]: ['access:grant'] }, types: {} }),
    ).toThrow();
  },
);

test.serial('missing or nonhuman, inactive or fenced accounts refuse without marker, grant or audit', async () => {
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

test.serial(
  'only the seeded real Global row admits installation and native failure rolls everything back',
  async () => {
    for (const failure of ['missing-global', 'wrong-kind', 'audit']) {
      if (failure === 'missing-global') await withoutGlobalRow('missing');
      if (failure === 'wrong-kind') await withoutGlobalRow('community');
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
  },
);

test.serial('organization standing setup has its own marker and resumes an interrupted deployment', async () => {
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

test.serial('concurrent same and different named CLI calls linearize to one durable winner', async () => {
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

const showcaseKind = 'access.local-showcase.board-create';
const grantEvent = 'com.rezics.access.grant.create.v1';
async function showcaseSnapshot() {
  const grants = await reader.query(
    "SELECT * FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND action='board:create'",
    [PLATFORM_RESOURCE.id],
  );
  const receipts = await reader.query('SELECT * FROM core.receipt WHERE command_kind=$1', [showcaseKind]);
  const events = await reader.query(
    `SELECT * FROM core.outbox WHERE partition_no=0 AND type=$1 AND subject=$2
       AND data->'actions'='["board:create"]'::jsonb ORDER BY position`,
    [grantEvent, PLATFORM_RESOURCE.id],
  );
  return { grants: grants.rows, receipts: receipts.rows, events: events.rows };
}

async function resetShowcase() {
  await reader.query("DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND action='board:create'", [
    PLATFORM_RESOURCE.id,
  ]);
  await reader.query('DELETE FROM core.receipt WHERE command_kind=$1', [showcaseKind]);
  await reader.query(
    `DELETE FROM core.outbox WHERE partition_no=0 AND type=$1 AND subject=$2
    AND data->'actions'='["board:create"]'::jsonb`,
    [grantEvent, PLATFORM_RESOURCE.id],
  );
}

test.serial(
  'local showcase uses one native identity grant, authoritative validity and durable non-restoring replay',
  async () => {
    await reset();
    await resetShowcase();
    await invoke(person);
    const governance = await snapshot();
    expect(await showcaseSnapshot()).toEqual({ grants: [], receipts: [], events: [] });
    const position = (await reader.query('SELECT position FROM core.partition WHERE partition_no=0')).rows[0].position;
    expect(await bootstrapLocalShowcaseBoardCreation(pool, person)).toEqual({
      resource: PLATFORM_RESOURCE,
      subjectId: person,
      actions: ['board:create'],
    });
    const installed = await showcaseSnapshot();
    expect(installed.grants).toHaveLength(1);
    expect(installed.receipts).toHaveLength(1);
    expect(installed.events).toHaveLength(1);
    const grant = installed.grants[0];
    const receipt = installed.receipts[0];
    const event = installed.events[0];
    expect(BigInt(receipt.position)).toBe(BigInt(position) + 1n);
    expect(grant).toMatchObject({
      subject_kind: 'identity',
      subject_id: person,
      subject_role: '',
      route: 0,
      resource_id: PLATFORM_RESOURCE.id,
      action: 'board:create',
      transaction_id: receipt.transaction_id,
    });
    expect(receipt).toMatchObject({ principal_kind: 'account', principal_id: person, partition_no: 0 });
    expect(receipt.response).toEqual({
      resource: PLATFORM_RESOURCE,
      subjectId: person,
      subjectRole: '',
      actions: ['board:create'],
      valid: event.data.valid,
    });
    expect(event).toMatchObject({ epoch: receipt.epoch, position: receipt.position, event_count: 1, event_seq: 0 });
    expect(event.data).toEqual(receipt.response);
    expect(
      (
        await reader.query(
          `SELECT lower(g.valid)=o.recorded_at AND lower_inc(g.valid) AND upper_inf(g.valid)
       AND g.valid=(r.response->>'valid')::tstzrange AS authoritative
     FROM access.resource_grant g JOIN core.receipt r ON r.transaction_id=g.transaction_id
     JOIN core.outbox o ON o.partition_no=r.partition_no AND o.epoch=r.epoch AND o.position=r.position
     WHERE r.command_kind=$1`,
          [showcaseKind],
        )
      ).rows,
    ).toEqual([{ authoritative: true }]);
    await bootstrapLocalShowcaseBoardCreation(pool, person);
    expect(await showcaseSnapshot()).toEqual(installed);
    const mounted = actionCatalogue(mountedKernel());
    const using = fixtureAccess(mounted);
    // Self-renunciation uses the existing native grant command and a genuine Auth-issued actor.
    const ctx = await context(
      person,
      [...mounted.keys()].filter((scope) => scope !== 'media:complete'),
      using,
    );
    expect(await (await accessCheck(using, ctx.actor, 'board:create', PLATFORM_RESOURCE, ctx))(pool)).toBe(true);
    expect(await (await accessCheck(using, ctx.actor, 'thread:create', PLATFORM_RESOURCE, ctx))(pool)).toBe(false);
    expect(
      await (
        await accessCheck(using, ctx.actor, 'board:create', { route: routeOf(person)!, id: person }, ctx)
      )(pool),
    ).toBe(false);
    const unrelated = await context(other, [...ctx.actor.scopes], using);
    expect(await (await accessCheck(using, unrelated.actor, 'board:create', PLATFORM_RESOURCE, unrelated))(pool)).toBe(
      false,
    );
    await createGrantCommands({ pool, access: using, managementAction: 'access:grant' }).revoke(ctx, {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: person },
      actions: ['board:create'],
      valid: grant.valid,
      key: 'showcase-renounce',
    });
    await bootstrapLocalShowcaseBoardCreation(pool, person);
    expect(await showcaseSnapshot()).toEqual({ ...installed, grants: [] });
    expect(await snapshot()).toEqual(governance);
  },
);

test.serial(
  'local showcase refuses current Global/operator-marker mismatches before replay and rolls back native failure',
  async () => {
    await reset();
    await invoke(person);
    for (const installed of [false, true]) {
      await resetShowcase();
      if (installed) await bootstrapLocalShowcaseBoardCreation(pool, person);
      for (const failure of ['missing-global', 'wrong-kind', 'missing-marker', 'wrong-operator', 'other-account']) {
        const marker = (await snapshot()).marker[0];
        if (failure === 'missing-global') await withoutGlobalRow('missing');
        if (failure === 'wrong-kind') await withoutGlobalRow('community');
        if (failure === 'missing-marker') await reader.query('DELETE FROM access.governance_bootstrap');
        if (failure === 'wrong-operator')
          await reader.query('UPDATE access.governance_bootstrap SET account_id=$1', [other]);
        const before = await showcaseSnapshot();
        try {
          await expect(
            bootstrapLocalShowcaseBoardCreation(pool, failure === 'other-account' ? other : person),
          ).rejects.toBeInstanceOf(BootstrapGovernanceUnavailableError);
          expect(await showcaseSnapshot()).toEqual(before);
        } finally {
          await reader.query(
            `INSERT INTO semantic.context(route,context_id,kind,labels)
          VALUES(0,$1,'global','{"en":"Global"}') ON CONFLICT(route,context_id) DO UPDATE SET kind='global'`,
            [PLATFORM_RESOURCE.id],
          );
          await reader.query(
            `INSERT INTO access.governance_bootstrap(route,resource_id,account_id,transaction_id)
          VALUES(0,$1,$2,$3) ON CONFLICT(route,resource_id) DO UPDATE SET account_id=EXCLUDED.account_id`,
            [PLATFORM_RESOURCE.id, marker.account_id, marker.transaction_id],
          );
        }
      }
    }
    await resetShowcase();
    const before = await showcaseSnapshot();
    await reader.query(
      `ALTER TABLE core.outbox ADD CONSTRAINT showcase_failure CHECK (type <> '${grantEvent}') NOT VALID`,
    );
    try {
      await expect(bootstrapLocalShowcaseBoardCreation(pool, person)).rejects.toThrow();
      expect(await showcaseSnapshot()).toEqual(before);
    } finally {
      await reader.query('ALTER TABLE core.outbox DROP CONSTRAINT showcase_failure');
    }
    await bootstrapLocalShowcaseBoardCreation(pool, person);
    const recovered = await showcaseSnapshot();
    expect(recovered.grants).toHaveLength(1);
    expect(recovered.receipts).toHaveLength(1);
    expect(recovered.events).toHaveLength(before.events.length + 1);
  },
);
