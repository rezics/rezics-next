import { strict as assert } from 'node:assert';
import { createInitiatorRestorer } from '../../../src/access/durable-initiator.ts';
import { createAccountsWorkModule } from '../../../src/access/membership-work.ts';
import { createRealmMembership, readMembershipInitiator } from '../../../src/community/membership.ts';
import { communityWorkModule } from '../../../src/community/work.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { newId, partitionOf } from '../../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { openGrowthDatabase, seed, type Population } from '../../support/growth.ts';
import { productionActions } from '../../support/production-actions.ts';
import { createProductionAccess } from '../membership-fixture.ts';

export const scales = [256, 1024, 4096] as const;
export const axes = ['unrelated Realms', 'unrelated members', 'selected retained history'] as const;
export type Axis = (typeof axes)[number];
const route = 0x2130;
const created = '2000-01-01T00:00:00Z';
const nil = '00000000-0000-0000-0000-000000000000';
const scopes = ['realm:join', 'realm:read'];
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };

export type Selected = { realmId: string; accountId: string; bearer: string; denied: string };
export type CountState = { count: number; version: string; open: number; retained: number };

/** Setup rows are population only. Selected membership changes always use HTTP
 * and the installed Accounts/community workflows, including inverse completion. */
export async function openMemberCountFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 10;
  const sdkPool = db.openPool({ max: 6 });
  const consent = new Map<string, readonly string[]>();
  let time = Date.now();
  const clock = () => new Date(time);
  let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] = async () => null;
  const production = await createProductionAccess({
    actions: [...productionActions().keys()],
    realmRoleReader: (client, input) => roleReader(client, input),
  });
  const membership = createRealmMembership({
    pool: db.pool,
    access: production.access,
    referenceKeys: tokens,
    clock,
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: production.access,
      readOperation: readMembershipInitiator,
      async readConsent({ actorAccountId, clientId }) {
        const granted = consent.get(actorAccountId);
        return granted ? { actorAccountId, clientId, scopes: granted } : null;
      },
    }),
  });
  roleReader = membership.roleReader;
  const work = await createWorkClient(db.url, sdkPool);
  const runtime = await composeWork([createAccountsWorkModule({ realm: membership, access: production.access }), communityWorkModule], {
    databaseUrl: db.url,
    pool: sdkPool,
    client: work,
    clock,
    executorId: `member-count-growth-${crypto.randomUUID()}`,
    env: {
      KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
      KERNEL_SESSION_KEYS: `1:${Buffer.from(tokens.keys.get(1)!).toString('base64url')}`,
      AUTH_ISSUER: 'https://membership.auth.test',
      AUTH_AUDIENCE: 'https://membership.api.test',
      AUTH_JWKS_URL: 'https://membership.auth.test/.well-known/jwks.json',
    },
  });
  const kernel = createKernel({
    pool: db.pool, access: production.access, workClient: work, tokens, routeKey, clock,
    writeRate: createWriteRateLimiter({ secret: 'member-count-growth-native-write-rate-secret' }),
  });
  await runtime.launch();

  async function account(granted: readonly string[]) {
    const accountId = newId(route);
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
       VALUES($1,$2,'actor','active',$2)`, [route, accountId],
    );
    consent.set(accountId, granted);
    return { accountId, bearer: await production.mint(accountId, granted) };
  }

  function realmRows(realmId: string, creator: string): ReturnType<NonNullable<Population['rows']>> {
    const spaceId = newId(route);
    const revision = newId(route);
    return {
      'community.space': [{ route, space_id: spaceId, state: 'active', head_revision_id: revision, created_at: created, creator }],
      'community.space_revision': [{ route, space_id: spaceId, revision_id: revision, predecessor: null, title: 'Host', summary: '', created_at: created, author: creator }],
      'community.realm': [{ route, realm_id: realmId, space_id: spaceId, state: 'active', visibility: 'public', context_id: GLOBAL_CONTEXT, head_revision_id: revision, created_at: created, creator }],
      'community.realm_revision': [{ route, realm_id: realmId, revision_id: revision, predecessor: null, title: 'Realm', summary: '', visibility: 'public', context_id: GLOBAL_CONTEXT, created_at: created, author: creator }],
      'access.resource_initialization': [
        { route, resource_id: spaceId, resource_type: 'community.space', creator_id: creator, initialized_at: created },
        { route, resource_id: realmId, resource_type: 'community.realm', creator_id: creator, initialized_at: created },
      ],
    };
  }

  async function selected(): Promise<Selected> {
    const actor = await account(scopes);
    const denied = await account(['realm:read']);
    const realmId = newId(route);
    await seed(db, { name: `selected-${realmId}`, hotPartition: partitionOf(route), hotShare: 1, rows: () => realmRows(realmId, actor.accountId) }, { from: 0, to: 1 });
    // The existing production fixture's initial public standing. This grants no
    // ownership to the selected member; Access still decides each command.
    await db.admin.query(
      `INSERT INTO access.resource_role_grant
       (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
       VALUES($1,$2,'active_accounts',$3,'','community.realm.standing','(,)',$4)`,
      [route, realmId, nil, newId(route)],
    );
    return { ...actor, realmId, denied: denied.bearer };
  }

  async function state(s: Selected): Promise<CountState> {
    const result = await db.admin.query<CountState>(
      `SELECT c.count::integer,c.version::text,
        (SELECT count(*)::integer FROM community.realm_member m WHERE m.route=c.route AND m.realm_id=c.realm_id AND m.account_id=$3 AND upper_inf(m.valid)) AS open,
        (SELECT count(*)::integer FROM community.realm_member m WHERE m.route=c.route AND m.realm_id=c.realm_id AND m.account_id=$3 AND NOT upper_inf(m.valid)) AS retained
       FROM community.realm_member_count c WHERE c.route=$1 AND c.realm_id=$2`, [route, s.realmId, s.accountId],
    );
    assert.equal(result.rowCount, 1);
    return result.rows[0]!;
  }

  async function request(s: Selected, method: 'POST' | 'DELETE', key = crypto.randomUUID(), bearer = s.bearer) {
    const response = await kernel.handle(new Request(`http://kernel.test/v1/realms/${s.realmId}/membership`, {
      method, headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': JSON.stringify(key) },
    }));
    return { status: response.status, body: await response.json() as { workflowId?: string } };
  }

  async function complete(workflowId: string) {
    assert.equal(await work.retrieveWorkflow(workflowId).getResult(), undefined);
  }

  async function command(s: Selected, method: 'POST' | 'DELETE', key = crypto.randomUUID()) {
    const response = await request(s, method, key);
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(typeof response.body.workflowId, 'string');
    await complete(response.body.workflowId!);
    return response.body.workflowId!;
  }

  async function population(s: Selected, axis: Axis) {
    const otherRealm = newId(route);
    await seed(db, { name: `other-${otherRealm}`, hotPartition: partitionOf(route), hotShare: 1, rows: () => realmRows(otherRealm, s.accountId) }, { from: 0, to: 1 });
    return async (scale: number, previous: number) => {
      await seed(db, {
        name: `${axis}-${s.realmId}`, hotPartition: partitionOf(route), hotShare: 1,
        rows: ({ ordinal }) => {
          const realmId = axis === 'unrelated Realms' ? newId(route) : axis === 'unrelated members' ? otherRealm : s.realmId;
          const history = axis === 'selected retained history';
          const start = new Date(Date.parse(created) + ordinal * 2000).toISOString();
          const end = new Date(Date.parse(created) + ordinal * 2000 + 1000).toISOString();
          return {
            ...(axis === 'unrelated Realms' ? realmRows(realmId, s.accountId) : {}),
            'community.realm_member': [{ route, realm_id: realmId, account_id: history ? s.accountId : newId(route), role: 'member', valid: history ? `[${start},${end})` : `[${created},)`, reservation_id: newId(route), transaction_id: newId(route) }],
          };
        },
      }, { from: previous, to: scale });
    };
  }

  /** Fail at COMMIT after the native source and both count triggers have run.
   * This is a test-local fault, never a substitute membership producer. */
  async function rejectPublication(s: Selected) {
    const before = await state(s);
    await db.admin.query(`CREATE FUNCTION public.growth_member_count_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE c community.realm_member_count;
      BEGIN
        SELECT * INTO STRICT c FROM community.realm_member_count WHERE route=NEW.route AND realm_id=NEW.realm_id;
        IF c.count <> ${before.count + 1} OR c.version <> ${BigInt(before.version) + 1n} THEN
          RAISE EXCEPTION 'count trigger did not run before rollback fault';
        END IF;
        RAISE EXCEPTION 'growth count rollback after source and control' USING ERRCODE='P0001';
      END; $$`);
    await db.admin.query(`CREATE CONSTRAINT TRIGGER growth_member_count_rollback AFTER INSERT ON community.realm_member
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.account_id='${s.accountId}'::uuid)
      EXECUTE FUNCTION public.growth_member_count_rollback()`);
    return async () => {
      await db.admin.query('DROP TRIGGER growth_member_count_rollback ON community.realm_member');
      await db.admin.query('DROP FUNCTION public.growth_member_count_rollback()');
    };
  }

  return {
    db, selected, state, request, command, complete, population, rejectPublication,
    advance() { time += 1000; },
    async close() {
      try { await runtime.shutdown(); } finally {
        await work.close();
        await db.close();
      }
    },
  };
}

export type MemberCountFixture = Awaited<ReturnType<typeof openMemberCountFixture>>;
