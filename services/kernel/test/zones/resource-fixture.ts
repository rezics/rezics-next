import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PROFILE_FORMAT, type CompositionDocument, type ZoneStarter } from '@rezics/composition';
import { bundledRelease } from '@rezics/definitions/bundled';
import bookStarter from '../../../../packages/definitions/presentation/book/zone.json';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { installResourceRoleCatalogue, resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapProfile } from '../../src/presentation/profiles.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';

export type Persona = 'owner' | 'editor' | 'other' | 'suspended' | 'operator' | 'anonymous';
export const day = 86_400_000;
export const page = (text: string, appearance = {}): CompositionDocument => ({
  root: { props: { appearance } },
  content: [{ type: 'Text', props: { id: 'copy', text } }],
});
export const starter = (): ZoneStarter => structuredClone(bookStarter) as ZoneStarter;
export const createBody = () => ({ configuration: starter(), mounts: [] as string[], visibility: 'private' });
export const problem = ({ request_id: _request, ...body }: Record<string, any>) => body;

/** Uses the shared migrated database and real Access. It never inserts Zone state or grants anonymous rights. */
export async function resourceFixture() {
  const db = await openGrowthDatabase();
  try {
    const accounts = {
      owner: newId(0x7111),
      editor: newId(0x7112),
      other: newId(0x7113),
      suspended: newId(0x7114),
      operator: newId(0x7115),
    };
    const actions = [
      'account:delete',
      'zone:create',
      'zone:read',
      'zone:configure',
      'zone:publish',
      'zone:delete',
      'zone:restore',
      'zone:purge',
      'access:grant',
      'moderation:takedown',
      'subject:create',
      'subject:read',
      'collection:create',
      'collection:read',
      'collection:update',
    ];
    const access = await createRealAccess(db.admin, accounts, actions);
    let now = Date.now();
    const clock = () => new Date(now);
    const app = createKernel({
      pool: db.pool,
      clock,
      routeKey: new Uint8Array(32).fill(73),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(74)]]) },
      requestDeadlineMs: 30_000,
      access: (config) => {
        // Lifecycle time may advance by months; credential expiry retains actual wall time.
        // Commands still receive the kernel domain clock and bind their own authoritative permission time.
        const real = access.access({ ...config, clock: () => new Date() });
        installResourceRoleCatalogue(real, resolveResourceRoles(config.actions));
        return real;
      },
      writeRate: createWriteRateLimiter({
        secret: 'zone-resource-test-write-rate-secret',
        overrides: JSON.stringify({
          'new-account': { write: { maximum: 100000, seconds: 86400 } },
          member: { write: { maximum: 100000, seconds: 86400 } },
        }),
      }),
    });
    await bootstrapRelease(db.pool, bundledRelease);
    await bootstrapProfile(db.pool, {
      format: PROFILE_FORMAT,
      generic: {
        views: { overview: { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'subject' } }] } },
      },
      types: [],
      bases: [],
      routes: [],
    });
    await db.admin.query("UPDATE access.account SET state='suspended' WHERE account_id=$1", [accounts.suspended]);
    const global = { route: 0, id: GLOBAL_CONTEXT };
    await access.grant(global, 'owner', 'subject:create');

    async function call(
      who: Persona,
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await app.handle(
        new Request(`http://kernel.test${path}`, {
          method,
          headers: {
            ...(who === 'anonymous' ? {} : { authorization: `Bearer ${access.bearer(who)}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text ? (JSON.parse(text) as Record<string, any>) : {},
      };
    }
    async function available() {
      // This MUST precede any setup involving a new action or table. Missing APIs fail here, as HTTP outcomes.
      const probe = await call('anonymous', 'POST', '/v1/zones', createBody());
      expect(probe.status, 'POST /v1/zones must exist and require authentication').toBe(401);
      expect(probe.body.code).toBe('authentication_required');
      await access.grant(global, 'owner', 'zone:create');
      await access.grant(global, 'suspended', 'zone:create');
    }
    async function create(body = createBody()) {
      const answer = await call('owner', 'POST', '/v1/zones', body);
      expect(answer.status).toBe(201);
      expect(answer.headers.get('location')).toBe(`/v1/zones/${answer.body.zone.id}`);
      expect(answer.headers.get('etag')).toBe(`"${answer.body.zone.revision}"`);
      return answer.body.zone as { id: string; revision: string; [key: string]: any };
    }
    const resource = (id: string) => ({ route: routeOf(id)!, id });
    const grant = (id: string, who: Exclude<Persona, 'anonymous'>, action: string) =>
      access.grant(resource(id), who, action);
    const revoke = (id: string, who: Exclude<Persona, 'anonymous'>, action: string) =>
      access.revoke(resource(id), who, action);
    const read = (id: string, who: Persona = 'anonymous', target: unknown = { route: '' }, languages?: string[]) =>
      call(who, 'POST', `/v1/zones/${id}:readPage`, { target, ...(languages ? { languages } : {}) });
    const conditional = (revision: string) => ({ 'if-match': `"${revision}"` });
    async function configuration(id: string) {
      const response = await call('owner', 'GET', `/v1/zones/${id}/configuration`);
      expect(response.status).toBe(200);
      return response;
    }
    async function raw(id: string) {
      const { rows } = await db.admin.query('SELECT * FROM zones.zone WHERE route=$1 AND zone_id=$2', [
        routeOf(id),
        id,
      ]);
      return rows[0] as Record<string, any> | undefined;
    }
    async function events(id: string) {
      return (
        await db.admin.query('SELECT type,data FROM core.outbox WHERE subject=$1 ORDER BY position,event_seq', [id])
      ).rows;
    }
    async function receipts() {
      return (
        await db.admin.query('SELECT count(*)::int AS n FROM core.receipt WHERE principal_id=$1', [accounts.owner])
      ).rows[0]!.n as number;
    }
    async function purge(id: string, cursor: string | null = null, limit = 2) {
      // Loaded only after native availability succeeds. This is the production bounded worker seam, not a model.
      const modulePath = '../../src/zones/purge.ts';
      const worker = await import(modulePath);
      return worker.purgeZonePage({ pool: db.pool, clock, route: routeOf(id)!, zoneId: id, cursor, limit }) as Promise<{
        next: string | null;
      }>;
    }
    async function tombstoneOwner() {
      // The real account confirmation barrier, not a fabricated account/Zone row or a grace timer.
      const lifecycleAccess = access.access({ actions: LIFECYCLE_ACTIONS });
      const context = { pool: db.pool, deadline: Date.now() + 30_000 };
      await access.grant(resource(accounts.owner), 'owner', 'account:delete');
      const actor = await lifecycleAccess.authenticate(access.bearer('owner'), context);
      return createLifecycleCommands({ pool: db.pool, access: lifecycleAccess, clock }).tombstone(
        { actor, deadline: context.deadline },
        { accountId: accounts.owner, key: randomUUID() },
      );
    }
    return {
      db,
      app,
      accounts,
      access,
      clock,
      call,
      available,
      create,
      grant,
      revoke,
      read,
      conditional,
      configuration,
      raw,
      events,
      receipts,
      purge,
      tombstoneOwner,
      advance(ms: number) {
        now += ms;
      },
      close: () => db.close(),
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
export type ResourceFixture = Awaited<ReturnType<typeof resourceFixture>>;
