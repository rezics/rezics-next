import '../support/fixture-event-types.ts';
import { Pool } from 'pg';
import { spyOn } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type {
  ViewerActionsDriver,
  ViewerActionsFixture,
  ViewerActionsTrace,
  Persona,
  ResourceReference,
} from '../../../../specs/viewer-actions-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createKernelRuntimeDefaults } from '../../src/server.ts';
import { createPersonas } from '../support/personas.ts';
import { registerTestClient, type TestKernel } from '../support/test-kernel.ts';
import { nativeFixture, cookies, password, issuer } from './native-account-bindings-fixture.ts';
import {
  openGrowthDatabase,
  capture,
  costOf,
  withoutCatalogStatements,
  seed as seedGrowth,
  type GrowthDatabase,
} from '../support/growth.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { initializeResourceGrants } from '../../src/access/resource-initialization.ts';
import { parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { principalCommandIdentity, runCommand, authoritativeTimeValue } from '../../src/command/command.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import type { Access } from '../../src/request/access.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { startConsentServer, type ConsentServer } from '../community/membership-fixture.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import permissionRead from '../../src/access/permission-check.sql';
import permissionTime from '../../src/access/permission-time.sql';
import principalRead from '../../src/access/permission-assignment.sql';
import openingsRead from '../../src/access/gates/open-groups.sql';

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const key = () => crypto.randomUUID();
const ref = (type: string, id: string): ResourceReference => ({ type, id });
const persona = (p: { accountId: string; bearer: string }): Persona => ({
  accountId: p.accountId,
  credential: p.bearer,
});
const roles = {
  roles: {
    'viewer_fixture.owner': ['viewer_fixture:inspect', 'viewer_fixture:update', 'viewer_fixture:read', 'access:grant'],
    'viewer_fixture.reader': ['viewer_fixture:read'],
  },
  types: { 'viewer_fixture.item': { owner: 'viewer_fixture.owner', standing: ['viewer_fixture.reader'] } },
};

export type NativeViewerActionsDriver = ViewerActionsDriver & { database: GrowthDatabase };
export async function createViewerActionsDriver(): Promise<NativeViewerActionsDriver> {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL must name the migrated test database');
  const maintenance = new URL(source);
  maintenance.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
  const name = `viewer_${key().replaceAll('-', '')}`;
  const url = new URL(source);
  url.pathname = `/${name}`;
  let created = false;
  let db: GrowthDatabase | undefined;
  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  let kernel: TestKernel;
  let access: Access;
  let fault: ResourceReference | null = null;
  let trace: ViewerActionsTrace | undefined;
  let active: ViewerActionsFixture | undefined;
  let staff: Persona;
  let requestedBy = '';
  let people: Awaited<ReturnType<typeof createPersonas>>;
  const grown = new Map<string, number>();
  let measuredSeed: { axis: string; scale: number } | undefined;
  const grantResources = new Map<string, ResourceReference[]>();
  const owners = new Map<string, Persona>();
  const liveValid = `[${new Date().toISOString()},)`;
  let consent: ConsentServer | undefined;
  let worker: Bun.Subprocess | undefined;
  let work: WorkClient | undefined;
  let realmTemplate: { spaceId: string; contextId: string };
  const fixtureSpies: { mockRestore(): void }[] = [];
  const context = () => ({ pool: db!.pool, deadline: Date.now() + 30000 });
  // The fixture owns this executor. Drain it before observations so background
  // effect delivery cannot hold the measurement's vacuum horizon. HTTP reads do
  // not depend on effects; membership/ban workflows finish before it is stopped.
  async function stopWorker() {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM');
      await worker.exited;
    }
    worker = undefined;
  }
  async function startWorker() {
    if (worker && worker.exitCode === null) return;
    worker = Bun.spawn(['bun', 'src/worker.ts'], {
      cwd: resolve(import.meta.dir, '../..'),
      env: workerTestEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        KERNEL_ROUTE_KEY: Buffer.alloc(32, 31).toString('base64url'),
        KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 29).toString('base64url')}`,
        STRIPE_SECRET_KEY: 'sk_test_viewer',
        STRIPE_MANAGED_PAYMENTS: 'false',
        CHECKOUT_SUCCESS_URL: 'https://web.test/success',
        CHECKOUT_CANCEL_URL: 'https://web.test/cancel',
        OPENSEARCH_URL: '',
        ...consent!.env,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    let workerOutput = '';
    for (const stream of [worker.stdout, worker.stderr]) {
      if (typeof stream === 'number' || !stream) throw new Error('Viewer worker pipes unavailable');
      void (async () => {
        for await (const chunk of stream) workerOutput += new TextDecoder().decode(chunk);
      })();
    }
    const readyDeadline = Date.now() + 30000;
    while (!workerOutput.includes('Worker ready')) {
      if (worker.exitCode !== null || Date.now() > readyDeadline)
        throw new Error(`Viewer worker failed: ${workerOutput}`);
      await Bun.sleep(20);
    }
  }
  async function close() {
    for (const spy of fixtureSpies) spy.mockRestore();
    await stopWorker();
    await work?.close();
    await consent?.close();
    try {
      await auth?.close();
    } finally {
      try {
        await db?.close();
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
    }
  }
  async function request(credential: string | null, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    // The suite supplies semantic UUID keys; native HTTP uses structured strings.
    const idempotency = headers.get('idempotency-key');
    if (idempotency && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotency))
      headers.set('idempotency-key', JSON.stringify(idempotency));
    if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
    return kernel.handle(new Request(`http://kernel.test${path}`, { ...init, headers }));
  }
  async function command(p: Persona, path: string, body?: unknown, method = 'POST') {
    const response = await request(p.credential, path, {
      method,
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key()) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }
  async function grant(p: Persona, resource: ResourceReference, action: string, revoke = false, valid = liveValid) {
    await command(owners.get(resource.id) ?? staff, revoke ? '/v1/grants:revoke' : '/v1/grants', {
      resource: { route: routeOf(resource.id)!, id: resource.id },
      subject: { kind: 'account', id: p.accountId },
      actions: [action],
      valid,
    });
  }
  async function growRange(start: number, end: number, create: (index: number) => Promise<void>) {
    let next = start;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < end) await create(next++);
      }),
    );
  }
  async function collection(curator: Persona) {
    const response = await command(curator, '/v1/collections', {
      title: 'Viewer actions Collection',
      visibility: 'public',
    });
    const resource = ref('library.collection', (await response.json()).collection.id);
    await command(staff, '/v1/grants', {
      resource: { route: routeOf(resource.id)!, id: resource.id },
      subject: { kind: 'account', id: curator.accountId },
      actions: ['access:grant'],
      valid: '(,)',
    });
    owners.set(resource.id, curator);
    return resource;
  }
  async function unrelatedRealm() {
    const space = (await (await command(staff, '/v1/spaces', { title: 'Unrelated viewer Space' })).json()).space;
    const response = await command(staff, '/v1/realms', {
      ...realmTemplate,
      spaceId: space.spaceId,
      title: 'Unrelated viewer Realm',
      visibility: 'public',
    });
    return ref('community.realm', (await response.json()).realm.realmId);
  }
  try {
    await admin.query(
      `CREATE DATABASE ${quote(name)} TEMPLATE ${quote(decodeURIComponent(new URL(source).pathname.slice(1)))}`,
    );
    created = true;
    db = await openGrowthDatabase(url.toString());
    await db.admin.query(
      'CREATE TABLE public.viewer_fixture_item(route integer, id uuid, creator uuid, PRIMARY KEY(route,id))',
    );
    await bootstrapRelease(db.pool, bundledRelease);
    auth = await nativeFixture(db.pool);
    const consentReader = createCurrentConsentReader({ database: auth.authPool });
    const temporary = resolve(import.meta.dir, '../../../../.temp');
    mkdirSync(temporary, { recursive: true });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
      consent = await startConsentServer(
        async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null,
      );
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    await startWorker();
    work = await createWorkClient(url.toString());
    const defaults = createKernelRuntimeDefaults({
      auth: {
        issuer,
        audience: 'https://ordinary.api.test',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async (url, init) => auth!.host.service.handler(new Request(url, init)),
      },
      env: {
        ...process.env,
        KERNEL_WRITE_RATE_SECRET: 'viewer-actions-native-test-secret-at-least-32-characters',
        KERNEL_WRITE_RATE_OVERRIDES: JSON.stringify(
          Object.fromEntries(
            ['new-account', 'member', 'trusted', 'service'].map((kind) => [
              kind,
              { write: { maximum: 1_000_000, seconds: 60 } },
            ]),
          ),
        ),
      },
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
    });
    kernel = createKernel({
      ...defaults,
      pool: db.pool,
      workClient: work,
      routeKey: new Uint8Array(32).fill(31),
      resourceRoles: roles,
      access(config) {
        access = defaults.access!({ ...config, resourceRoles: roles });
        const prepare = access.prepareReadDecisions!.bind(access);
        access.prepareReadDecisions = async (input) => {
          if (trace) {
            trace.permissionCalls++;
            trace.preparations.actor++;
            trace.candidateActions = [...(input.typeActions ?? [])].map(([type, actions]) => ({
              type,
              count: actions.size,
            }));
          }
          const handle = await prepare(input);
          return {
            async decide(client, batch, time) {
              if (trace) {
                trace.permissionCalls++;
                trace.formulaPages.push({
                  type: batch.resourceType,
                  action: batch.action,
                  ids: [...batch.ids],
                  at: new Date(authoritativeTimeValue(time!)).toISOString(),
                });
                trace.readTimes.push(new Date(authoritativeTimeValue(time!)).toISOString());
              }
              return handle.decide(client, batch, time);
            },
          };
        };
        return access;
      },
      viewerActionResources: new Map([
        [
          'viewer_fixture.item',
          {
            readAction: 'viewer_fixture:read',
            async read(client, ids) {
              const result = await client.query<{ id: string }>(
                'SELECT item.id FROM unnest($1::integer[], $2::uuid[]) wanted(route,id) CROSS JOIN LATERAL (SELECT id FROM public.viewer_fixture_item WHERE route=wanted.route AND id=wanted.id ORDER BY route,id LIMIT 1) item',
                [ids.map((id) => routeOf(id)!), ids],
              );
              return Object.fromEntries(result.rows.map(({ id }) => [id, false]));
            },
          },
        ],
      ]),
      modules: [
        (app) => {
          // The fixture is a native mounted module. Creation initializes ordinary
          // resource roles under the caller's subject:create authority on Global.
          app.post(
            '/fixture/items',
            {
              detail: {
                operationId: 'viewer_fixture.create',
                ...{
                  'x-action': 'subject:create',
                  'x-resource-types': ['viewer_fixture.item'],
                  'x-exposure': 'public',
                  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
                },
                security: [{ bearerAuth: [] }],
              },
            },
            async ({ actor, job }) => {
              if (actor.kind !== 'account') throw new ProblemError('authentication_required');
              const resource = { route: 0x540, id: newId(0x540) };
              const authorization = parentCreationAuthorization({
                access,
                actor,
                action: 'subject:create',
                parent: {
                  resource: PLATFORM_RESOURCE,
                  async validate(client) {
                    return (
                      (
                        await client.query('SELECT 1 FROM semantic.context WHERE route=$1 AND context_id=$2', [
                          PLATFORM_RESOURCE.route,
                          PLATFORM_RESOURCE.id,
                        ])
                      ).rowCount === 1
                    );
                  },
                },
                context: {
                  pool: db!.pool,
                  deadline: job.deadline,
                  resource,
                  creation: {
                    async validate(tx, target) {
                      return (
                        (
                          await tx.query(
                            'SELECT 1 FROM public.viewer_fixture_item WHERE route=$1 AND id=$2 AND creator=$3 AND xmin::text=pg_current_xact_id_if_assigned()::text',
                            [target.route, target.id, actor.accountId],
                          )
                        ).rowCount === 1
                      );
                    },
                  },
                },
              });
              const result = await runCommand(
                db!.pool,
                {
                  ...principalCommandIdentity(actor),
                  partition: partitionOf(resource.route),
                  deadline: job.deadline,
                  receipt: { kind: 'viewer_fixture.create', key: key(), digest: new Uint8Array(32) },
                  authorization,
                },
                async (tx) => {
                  await tx.query('INSERT INTO public.viewer_fixture_item VALUES($1,$2,$3)', [
                    resource.route,
                    resource.id,
                    actor.accountId,
                  ]);
                  await initializeResourceGrants(tx, {
                    resource,
                    creator: actor.accountId,
                    type: 'viewer_fixture.item',
                  });
                  return {
                    value: resource,
                    events: [{ type: 'com.rezics.fixture.resource-created.v1', subject: resource.id, data: resource }],
                  };
                },
              );
              return result.value;
            },
          );
          app.get(
            '/fixture/read',
            {
              detail: {
                operationId: 'viewer_fixture.read',
                ...{
                  'x-action': 'viewer_fixture:read',
                  'x-exposure': 'public',
                },
                security: [{ bearerAuth: [] }],
              },
            },
            () => ({}),
          );
          for (const [verb, exposure] of [
            ['inspect', 'public'],
            ['zulu', 'gate:viewer_zulu'],
            ['alpha', 'gate:viewer_alpha'],
          ] as const) {
            app.patch(
              `/fixture/items/:id/${verb}`,
              {
                detail: {
                  operationId: `viewer_fixture.${verb}`,
                  ...{
                    'x-action': verb === 'inspect' ? 'viewer_fixture:inspect' : 'viewer_fixture:update',
                    'x-resource-types': ['viewer_fixture.item'],
                    'x-exposure': exposure,
                    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
                  },
                  security: [{ bearerAuth: [] }],
                },
              },
              async ({ params, authorize }) => {
                const check = await authorize({ route: routeOf(params.id)!, id: params.id });
                if (!(await check(db!.pool))) throw new ProblemError('forbidden');
                return {};
              },
            );
          }
        },
      ],
    }) as TestKernel;
    Object.defineProperty(kernel, 'testAccess', { get: () => access });
    // Authentication resolves the kernel's one lazy Access before persona setup.
    await request(null, '/v1/viewerActions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resources: [ref('library.collection', newId(0x540))] }),
    });
    const originalTime = permissionTime.run;
    fixtureSpies.push(
      spyOn(permissionTime, 'run').mockImplementation(async (...args) => {
        const result = await originalTime(...args);
        if (trace && result?.at) trace.readTimes.push(new Date(result.at).toISOString());
        return result;
      }),
    );
    const originalPrincipal = principalRead.run;
    fixtureSpies.push(
      spyOn(principalRead, 'run').mockImplementation(async (...args) => {
        if (trace) trace.preparations.principal++;
        return originalPrincipal(...args);
      }),
    );
    const originalOpenings = openingsRead.run;
    fixtureSpies.push(
      spyOn(openingsRead, 'run').mockImplementation(async (...args) => {
        if (trace) {
          trace.preparations.gates++;
          trace.readTimes.push(new Date(args[1].at).toISOString());
        }
        return originalOpenings(...args);
      }),
    );
    const originalPermission = permissionRead.run;
    fixtureSpies.push(
      spyOn(permissionRead, 'run').mockImplementation(async (...args) => {
        if (trace && args[1].at) trace.readTimes.push(new Date(args[1].at).toISOString());
        if (fault && args[1].resource_ids?.includes(fault.id))
          throw new Error('Viewer fixture Access dependency unavailable');
        return originalPermission(...args);
      }),
    );

    const supportGrantResources: ResourceReference[] = [];
    // Populate unrelated catalogue rows with the shared seeder. Scenario authority
    // still comes from real Auth and commands; no selected reference is inserted
    // here, and eligibility continues to read the actual owning tables.
    async function seedSupport(f: ViewerActionsFixture) {
      const storedCollection = (
        await db!.pool.query('SELECT * FROM library.collection WHERE route=$1 AND collection_id=$2', [
          routeOf(f.collection.id),
          f.collection.id,
        ])
      ).rows[0]!;
      const collectionRoute = routeOf(staff.accountId)!;
      const realm = (
        await db!.pool.query('SELECT * FROM community.realm WHERE route=$1 AND realm_id=$2', [
          routeOf(f.realm.id),
          f.realm.id,
        ])
      ).rows[0]!;
      const revision = (
        await db!.pool.query('SELECT * FROM community.realm_revision WHERE route=$1 AND realm_id=$2', [
          routeOf(f.realm.id),
          f.realm.id,
        ])
      ).rows[0]!;
      const space = (
        await db!.pool.query('SELECT * FROM community.space WHERE route=$1 AND space_id=$2', [
          realm.route,
          realm.space_id,
        ])
      ).rows[0]!;
      const spaceRevision = (
        await db!.pool.query('SELECT * FROM community.space_revision WHERE route=$1 AND revision_id=$2', [
          space.route,
          space.head_revision_id,
        ])
      ).rows[0]!;
      await seedGrowth(
        db!,
        {
          name: 'viewer native backdrop',
          hotPartition: partitionOf(routeOf(f.collection.id)!),
          rows({ ordinal, route }) {
            const id = newId(route),
              subject = newId(route),
              organization = newId(route),
              transaction = newId(route);
            const realmId = newId(realm.route),
              revisionId = newId(realm.route),
              spaceId = newId(space.route),
              spaceRevisionId = newId(space.route);
            if (ordinal < 128 * 16) supportGrantResources[ordinal] = ref('viewer_fixture.item', id);
            const authority = {
              route,
              resource_id: id,
              subject_kind: 'identity',
              subject_id: staff.accountId,
              subject_role: '',
              transaction_id: transaction,
            };
            return {
              'public.viewer_fixture_item': [{ route, id, creator: staff.accountId }],
              'access.resource_initialization': [
                {
                  route,
                  resource_id: id,
                  resource_type: 'viewer_fixture.item',
                  creator_id: staff.accountId,
                  initialized_at: new Date(),
                },
              ],
              'access.resource_role_grant': [
                { ...authority, grant_role: 'viewer_fixture.owner', valid: '(,)' },
                {
                  ...authority,
                  subject_kind: 'active_accounts',
                  subject_id: '00000000-0000-0000-0000-000000000000',
                  grant_role: 'viewer_fixture.reader',
                  valid: '(,)',
                },
              ],
              'access.resource_grant': [
                { ...authority, action: 'viewer_fixture:update', valid: '[2000-01-01,2000-01-02)' },
                { ...authority, action: 'viewer_fixture:inspect', valid: '[2000-01-01,2000-01-02)' },
              ],
              'access.account':
                ordinal < 1024
                  ? [subject, organization].map((account_id, i) => ({
                      route,
                      account_id,
                      kind: i ? 'organization' : 'actor',
                      state: 'active',
                      transaction_id: transaction,
                      membership_inverse_complete: true,
                    }))
                  : [],
              'access.membership_inverse':
                ordinal < 512
                  ? [
                      {
                        route,
                        account_id: subject,
                        kind: 'organization',
                        group_id: organization,
                        reservation_id: transaction,
                        transaction_id: transaction,
                      },
                    ]
                  : [],
              'access.organization_member':
                ordinal < 512
                  ? [
                      {
                        route,
                        organization_id: organization,
                        member_account_id: subject,
                        role: 'owner',
                        valid: '(,)',
                        transaction_id: transaction,
                      },
                    ]
                  : [],
              'access.principal_assignment':
                ordinal < 512
                  ? [
                      {
                        route,
                        principal_id: subject,
                        request_id: transaction,
                        assigned_actor_id: staff.accountId,
                        valid: '(,)',
                        issued_valid: '(,)',
                        creator_principal_id: subject,
                        transaction_id: transaction,
                      },
                    ]
                  : [],
              'access.resource_denial':
                ordinal < 1024
                  ? [
                      {
                        route,
                        resource_id: id,
                        subject_id: subject,
                        subject_role: '',
                        action: 'viewer_fixture:update',
                        reason: 'resource',
                        valid: '(,)',
                        transaction_id: transaction,
                      },
                    ]
                  : [],
              'access.exposure_opening':
                ordinal < 1024
                  ? [
                      {
                        route: 0,
                        group: `viewer_support_${String(ordinal).replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)))}`,
                        valid: '[2000-01-01,)',
                        transaction_id: transaction,
                      },
                    ]
                  : [],
              'library.collection':
                ordinal < 2048
                  ? [
                      {
                        ...storedCollection,
                        route: collectionRoute,
                        collection_id: newId(collectionRoute),
                        curator_account_id: staff.accountId,
                        transaction_id: transaction,
                      },
                    ]
                  : [],
              'community.space':
                ordinal < 1024 ? [{ ...space, space_id: spaceId, head_revision_id: spaceRevisionId }] : [],
              'community.space_revision':
                ordinal < 1024
                  ? [{ ...spaceRevision, space_id: spaceId, revision_id: spaceRevisionId, predecessor: null }]
                  : [],
              'community.realm':
                ordinal < 1024
                  ? [{ ...realm, space_id: spaceId, realm_id: realmId, head_revision_id: revisionId }]
                  : [],
              'community.realm_revision':
                ordinal < 1024 ? [{ ...revision, realm_id: realmId, revision_id: revisionId, predecessor: null }] : [],
            };
          },
        },
        { from: 0, to: 16384 },
      );
    }

    const driver: NativeViewerActionsDriver = {
      database: db,
      request,
      async fixture() {
        await startWorker();
        people = await createPersonas(kernel, {
          version: 1,
          pool: db!.pool,
          auth: auth!,
          ...(staff ? { governance: { accountId: staff.accountId, bearer: staff.credential } } : {}),
        });
        staff = persona(people.staff);
        for (const group of ['collections', 'viewer_alpha', 'viewer_zulu']) await driver.gate(group, true);
        const curator = persona(people.bob),
          editor = persona(people.orgOwner),
          stranger = persona(people.operator),
          member = await driver.authenticate(persona(await auth!.person(`member_${key().replaceAll('-', '')}`)), [
            'realm:read',
            'realm:join',
            'realm:participate',
            'collection:read',
          ]),
          principal = persona(people.alice),
          assigned = persona(people.delegated);
        requestedBy = people.delegated.requestedBy;
        const first = await collection(curator),
          other = await collection(stranger);
        const hidden = await command(curator, '/v1/collections', { title: 'Private', visibility: 'private' });
        const space = (await (await command(staff, '/v1/spaces', { title: 'Viewer Space' })).json()).space;
        const classification = (
          await (await command(staff, '/v1/contexts', { labels: { en: 'Viewer classification' } })).json()
        ).context;
        realmTemplate = { spaceId: space.spaceId, contextId: classification.id };
        const realmResponse = await command(staff, '/v1/realms', {
          spaceId: space.spaceId,
          contextId: classification.id,
          title: 'Viewer Realm',
          visibility: 'public',
        });
        const realm = ref('community.realm', (await realmResponse.json()).realm.realmId);
        const itemResponse = await command(staff, '/fixture/items');
        const item = ref('viewer_fixture.item', (await itemResponse.json()).id);
        active = {
          curator,
          editor,
          stranger,
          member,
          principal,
          assigned,
          collection: first,
          otherCollection: other,
          concealed: ref('library.collection', (await hidden.json()).collection.id),
          unknown: ref('library.collection', newId(routeOf(first.id)!)),
          realm,
          item,
        };
        for (const p of [editor, principal, assigned]) await grant(p, first, 'collection:update');
        for (const action of ['viewer_fixture:inspect', 'viewer_fixture:update']) await grant(editor, item, action);
        for (const action of ['realm:join', 'realm:participate']) await grant(member, realm, action);
        const joined = await command(member, `/v1/realms/${realm.id}/membership`);
        await work!.retrieveWorkflow((await joined.json()).workflowId).getResult();
        await stopWorker();
        return active;
      },
      async authenticate(p, scopes) {
        const clientId = `viewer_${key()}`;
        await registerTestClient(auth!.host.service, { clientId, firstParty: true, scopes });
        const signed = await auth!.request('/signin', {
          account_id: p.accountId,
          password,
          client_id: clientId,
          scope: scopes,
        });
        if (!signed.ok) throw new Error(`Viewer sign-in: ${signed.status} ${await signed.text()}`);
        const issued = await auth!.request('/token', {}, cookies(signed));
        if (!issued.ok) throw new Error(`Viewer token: ${issued.status} ${await issued.text()}`);
        return { accountId: p.accountId, credential: (await issued.json()).access_token };
      },
      grant,
      revoke: (p, r, a) => grant(p, r, a, true),
      grantGate: (p, group) => grant(p, ref('semantic.context', PLATFORM_RESOURCE.id), `gate:${group}`),
      async gate(group, open) {
        await command(staff, `/v1/platform/exposure/${group}:${open ? 'open' : 'close'}`);
      },
      async suspend(p) {
        await command(staff, `/v1/accounts/${p.accountId}:suspend`, {});
      },
      async ban(realm, p) {
        await startWorker();
        const moderator = await driver.authenticate(staff, ['realm:ban']);
        const response = await command(
          moderator,
          `/v1/realms/${realm.id}/bans/${p.accountId}`,
          { reason: 'Viewer actions ban' },
          'PUT',
        );
        const { ban } = await response.json();
        if (ban.workflowId) await work!.retrieveWorkflow(ban.workflowId).getResult();
        await stopWorker();
      },
      async revokeAssignment() {
        const parts = requestedBy.split(':');
        await createDelegationCommands({ pool: db!.pool, access: auth!.access, action: 'account:manage' }).revoke(
          { ...context(), actor: await auth!.access.authenticate(active!.principal.credential, context()) },
          { principalId: parts[3]!, requestId: parts[4]!, key: key() },
        );
      },
      async fault(resource) {
        fault = resource;
      },
      async additionalCollections(curator, count) {
        const refs = [];
        for (let i = 0; i < count; i++) refs.push(await collection(curator));
        return refs;
      },
      async seed(f, scale, axis) {
        const id = `${f.collection.id}/${axis}`;
        const previous = grown.get(id) ?? 0;
        if (previous === 0 && axis !== 'unrelated_resources') {
          await growRange(0, 128, async () => {
            await command(staff, '/fixture/items');
            await unrelatedRealm();
          });
        }
        if (previous === 0 && axis === 'unrelated_grants') {
          grantResources.set(id, supportGrantResources);
        }
        await seedGrowth(
          db!,
          {
            name: id,
            hotPartition: partitionOf(routeOf(f.collection.id)!),
            async write(_database, { ordinal: i }) {
              if (axis === 'unrelated_resources') {
                await collection(staff);
                await command(staff, '/fixture/items');
                await unrelatedRealm();
              } else if (axis === 'unrelated_grants') {
                await grant(staff, grantResources.get(id)![i]!, 'viewer_fixture:read');
              } else {
                // Closed exact-key intervals must never change the live decision.
                const end = new Date(Date.parse(liveValid.slice(1, -2)) - 60000 - i * 2000).toISOString();
                const start = new Date(Date.parse(end) - 1000).toISOString();
                await grant(f.assigned, f.collection, 'collection:update', false, `[${start},${end})`);
                await grant(f.principal, f.collection, 'collection:update', false, `[${start},${end})`);
                await grant(f.stranger, f.item, 'viewer_fixture:update', false, `[${start},${end})`);
              }
            },
          },
          { from: previous, to: 128 * scale },
        );
        grown.set(id, 128 * scale);
        measuredSeed = { axis, scale };
      },
      async measure(read) {
        trace = {
          statements: 0,
          examinedRows: 0,
          sharedBlocks: 0,
          sequentialRelations: [],
          preparations: { actor: 0, principal: 0, gates: 0 },
          permissionCalls: 0,
          formulaPages: [],
          readTimes: [],
          candidateActions: [],
        };
        const observed = trace;
        try {
          const measured = await capture(db!, read);
          const cost = costOf(withoutCatalogStatements('viewer actions outcome', measured.capture));
          observed.statements = cost.statements;
          observed.examinedRows = cost.rows;
          observed.sharedBlocks = cost.blocks;
          observed.sequentialRelations = Object.entries(cost.relations)
            .filter(([name, value]) => value.sequentialScans > 0 && !name.startsWith('core.'))
            .map(([name]) => name)
            .sort();
          if (measuredSeed) console.info('VIEWER_ACTIONS_COST', JSON.stringify({ ...measuredSeed, cost }));
          return { value: measured.value, trace: observed };
        } finally {
          trace = undefined;
        }
      },
      close,
    };
    // The fixed catalogue backdrop belongs to fixture setup. Each scenario and
    // its independent growth axes retain their existing runtime budgets.
    const createFixture = driver.fixture;
    let prepared: ViewerActionsFixture | undefined = await createFixture();
    await seedSupport(prepared);
    driver.fixture = async () => {
      if (prepared) {
        const fixture = prepared;
        prepared = undefined;
        return fixture;
      }
      return createFixture();
    };
    return driver;
  } catch (error) {
    await close();
    throw error;
  }
}
