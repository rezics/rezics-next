import { bundledRelease } from '@rezics/definitions/bundled';
import { Pool } from 'pg';
import type {
  Persona,
  ResourceReference,
  ViewerActionsSurfacesDriver,
  ViewerActionsSurfacesFixture,
} from '../../../../specs/viewer-actions-surfaces-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createKernelRuntimeDefaults } from '../../src/server.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createPersonas } from '../support/personas.ts';
import { registerTestClient, type TestKernel } from '../support/test-kernel.ts';
import { nativeFixture, cookies, password, issuer } from './native-account-bindings-fixture.ts';
import { openGrowthDatabase, seed, type GrowthDatabase } from '../support/growth.ts';

const key = () => crypto.randomUUID();
const persona = (p: { accountId: string; bearer: string }): Persona => ({
  accountId: p.accountId,
  credential: p.bearer,
});
export type GrowthAxis = 'subjects' | 'grants' | 'history';
export type NativeSurfacesDriver = ViewerActionsSurfacesDriver & {
  database: GrowthDatabase;
  seed(fixture: ViewerActionsSurfacesFixture, scale: number, axis: GrowthAxis): Promise<void>;
};

/** Native transport only. Each factory owns its isolated migrated kernel and Auth services. */
export async function createViewerActionsSurfacesDriver(): Promise<NativeSurfacesDriver> {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL must name the migrated test database');
  const url = new URL(source);
  const template = decodeURIComponent(url.pathname.slice(1));
  const name = `viewer_surfaces_${key().replaceAll('-', '')}`;
  url.pathname = `/${name}`;
  const maintenance = new URL(source);
  maintenance.pathname = '/postgres';
  const admin = new Pool({ connectionString: maintenance.href, max: 1 });
  let created = false;
  let database: GrowthDatabase | undefined;
  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  let kernel: TestKernel;
  let access: Access;
  let people: Awaited<ReturnType<typeof createPersonas>> | undefined;
  let staff: Persona;
  const grown = new Map<string, number>();
  const historyEnd = Date.now() - 60_000;
  async function close() {
    try {
      await auth?.close();
    } finally {
      try {
        await database?.close();
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
    }
  }
  async function request(credential: string | null, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
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
  async function subject() {
    const response = await command(staff, '/v1/subjects', { type: 'schema:Book', labels: { en: key() } });
    return { type: 'schema:Book', id: (await response.json()).subject.id } as ResourceReference;
  }
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template.replaceAll('"', '""')}"`);
    created = true;
    database = await openGrowthDatabase(url.href);
    await bootstrapRelease(database.pool, bundledRelease);
    auth = await nativeFixture(database.pool);
    const defaults = createKernelRuntimeDefaults({
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
      auth: {
        issuer,
        audience: 'https://ordinary.api.test',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async (url, init) => auth!.host.service.handler(new Request(url, init)),
      },
      env: {
        ...process.env,
        KERNEL_WRITE_RATE_SECRET: 'viewer-surfaces-native-test-secret-at-least-32-characters',
        KERNEL_WRITE_RATE_OVERRIDES: JSON.stringify(
          Object.fromEntries(
            ['new-account', 'member', 'trusted', 'service'].map((kind) => [
              kind,
              { write: { maximum: 1_000_000, seconds: 60 } },
            ]),
          ),
        ),
      },
    });
    kernel = createKernel({
      ...defaults,
      pool: database.pool,
      routeKey: new Uint8Array(32).fill(31),
      access(config) {
        return (access = defaults.access!(config));
      },
    }) as TestKernel;
    Object.defineProperty(kernel, 'testAccess', { get: () => access });
    // Resolve the kernel's lazy native Access before the persona helper reads its catalogue.
    const ready = await request(null, '/v1/viewerActions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resources: [{ type: 'schema:Book', id: newId(0x540) }] }),
    });
    if (!ready.ok) throw new Error(`Native viewer action initialization: ${ready.status} ${await ready.text()}`);
    const driver: NativeSurfacesDriver = {
      database,
      request,
      async fixture() {
        people = await createPersonas(kernel, {
          version: 1,
          pool: database!.pool,
          auth: auth!,
          ...(people ? { governance: people.staff } : {}),
        });
        const identities = people;
        staff = persona(identities.staff);
        await command(staff, '/v1/platform/exposure/personal_library:open');
        await command(staff, '/v1/grants', {
          resource: { route: routeOf(identities.alice.accountId)!, id: identities.alice.accountId },
          subject: { kind: 'account', id: identities.alice.accountId },
          actions: ['access:grant'],
          valid: '(,)',
        });
        const subjects: ResourceReference[] = [];
        for (let index = 0; index < 20; index++) subjects.push(await subject());
        const withheld = await subject(),
          concealed = await subject();
        await command(staff, `/v1/subjects/${withheld.id}:hide`, { reason: 'Withheld catalogue row' });
        await command(staff, `/v1/subjects/${concealed.id}:takedown`, {
          notice: { complaint: 'Concealed catalogue row', received_at: new Date().toISOString() },
        });
        return {
          alice: persona(identities.alice),
          bob: persona(identities.bob),
          anonymous: { credential: null },
          suspended: persona(identities.suspended),
          subjects,
          withheld,
          concealed,
          unknown: { type: 'schema:Book', id: newId(routeOf(subjects[0]!.id)!) },
          async unscoped(action) {
            return persona(await identities.unscoped(action));
          },
        };
      },
      async authenticate(p, scopes) {
        const clientId = `viewer_surfaces_${key()}`;
        await registerTestClient(auth!.host.service, { clientId, firstParty: true, scopes });
        const signed = await auth!.request('/signin', {
          account_id: p.accountId,
          password,
          client_id: clientId,
          scope: scopes,
        });
        if (!signed.ok) throw new Error(`Viewer surfaces sign-in: ${signed.status} ${await signed.text()}`);
        const issued = await auth!.request('/token', {}, cookies(signed));
        if (!issued.ok) throw new Error(`Viewer surfaces token: ${issued.status} ${await issued.text()}`);
        return { accountId: p.accountId, credential: (await issued.json()).access_token };
      },
      async suspend(p) {
        await command(staff, `/v1/accounts/${p.accountId}:suspend`, {});
      },
      async seed(f, scale, axis) {
        const name = `${f.alice.accountId}/${axis}`;
        const from = grown.get(name) ?? 0;
        await seed(
          database!,
          {
            name,
            hotPartition: partitionOf(routeOf(f.alice.accountId)!),
            hotShare: 1,
            async write(_database, { ordinal }) {
              if (axis === 'subjects') {
                await subject();
                return;
              }
              // Native grants on the same account partition, never displayed-subject mutations.
              const action = axis === 'history' ? 'follow:create' : 'access:grant';
              const valid =
                axis === 'history'
                  ? `[${new Date(historyEnd - (ordinal + 1) * 2000).toISOString()},${new Date(historyEnd - ordinal * 2000 - 1000).toISOString()})`
                  : '(,)';
              const resourceId = axis === 'history' ? f.alice.accountId : newId(routeOf(f.alice.accountId)!);
              // Past exact-key intervals retain account authority history without
              // changing live decisions. Governance delegates only its own management action.
              await command(axis === 'history' ? f.alice : staff, '/v1/grants', {
                resource: { route: routeOf(resourceId)!, id: resourceId },
                subject: { kind: 'account', id: axis === 'history' ? f.alice.accountId : f.bob.accountId },
                actions: [action],
                valid,
              });
            },
          },
          { from, to: scale },
        );
        grown.set(name, scale);
      },
      close,
    };
    return driver;
  } catch (error) {
    await close();
    throw error;
  }
}
