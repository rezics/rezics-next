import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService } from '../src/index.ts';
import { attemptStatement, withAuthTransport } from '../src/rate-limit.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../../kernel/test/support/growth.ts';

// Better Auth resolves production enablement at module load. Use a fresh graph,
// without importing the frozen native security suite or replacing native policy.
if (process.env.AUTH_RATE_GROWTH_CHILD !== '1') {
  test('actual native Auth rate limit uses one replica safe point consume as population grows', async () => {
    const child = Bun.spawn(['bun', 'test', import.meta.path], {
      env: { ...process.env, NODE_ENV: 'production', AUTH_RATE_GROWTH_CHILD: '1' },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    expect(await child.exited).toBe(0);
  }, 180000);
} else {
  let fixture: ReturnType<typeof testDatabase>;
  let db: GrowthDatabase;
  let services: readonly [AuthService, AuthService];
  let freshServices: () => Promise<void>;
  const issuer = 'https://rate.growth.test';
  const secret = 'native-rate-growth-persistent-secret-32-bytes';
  const account: AccessAccount = {
    accountId: 'measured-owner',
    kind: 'actor',
    state: 'pending',
    authnEpoch: 7,
    automated: false,
  };
  let delivered = 0;
  let serial = 0;
  let emptyScans = 0;
  const inspectedIndexVisitsByScale: Record<number, Readonly<Record<string, number>>> = {};
  const rateSlack = {
    rows: { absolute: 0, relative: 0 },
    blocks: { absolute: 0, relative: 0 },
  };
  let verifiedCosts: readonly { rows: number; statements: number }[] = [];

  beforeAll(async () => {
    // Always our own migrated database, even when a full-module fixture is set.
    fixture = testDatabase();
    db = await openGrowthDatabase(fixture.url);
    const pair = await generateKeyPair('ES256', { extractable: true });
    const key = { ...(await exportJWK(pair.privateKey)), kid: 'rate-growth', alg: 'ES256' };
    const options = {
      database: db.pool,
      issuer,
      secret,
      audience: 'https://api.growth.test',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id: string) {
          return id === account.accountId ? account : null;
        },
        async readAccount(id: string) {
          return id === account.accountId ? account : null;
        },
        async readRecoveryAccount(id: string) {
          return id === account.accountId ? account : null;
        },
        async authorizeProvisioning() {
          return { accountId: account.accountId };
        },
        async authorizeRecovery() {
          throw new Error('Invalid proofs must not advance the floor');
        },
        async completeRecovery() {
          throw new Error('Invalid proofs must not complete recovery');
        },
      }),
      recoveryDelivery: {
        async deliver() {
          delivered++;
        },
      },
    };
    const first = await createAuthService(options);
    await first.internal.provisionPassword({
      authorization: 'approved',
      email: 'measured@example.test',
      password: 'correct horse battery staple',
    });
    account.state = 'active';
    await first.internal.registerClient({ clientId: 'measured-client', firstParty: true, scopes: ['read'] });
    // Distinct native routers and service state, sharing the instrumented pool
    // so capture sees every query from both instances.
    freshServices = async () => {
      services = [await createAuthService(options), await createAuthService(options)];
    };
  }, 60000);
  afterAll(async () => {
    await db?.close();
    fixture?.close();
  }, 60000);

  function counterKey(peer: string, path: string) {
    return createHmac('sha256', secret)
      .update(JSON.stringify([issuer, `${peer}|${path}`]))
      .digest('hex');
  }

  // Every measured branch shares this population. Grow same-family unrelated
  // peers, native credentials/clients, unrelated AND measured-owner history,
  // recovery bindings and expired verifications together, without planner hints.
  async function grow(database: GrowthDatabase, scale: number, previous: number) {
    const range = [previous * 1024 + 1, scale * 1024];
    await database.admin.query(
      `INSERT INTO "user" (id,name,email,"emailVerified")
      SELECT 'owner-'||i,'','owner-'||i||'@example.test',false FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await database.admin.query(
      `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt")
      SELECT 'credential-'||i,'owner-'||i,'credential','owner-'||i,'unused-hash',now()
      FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await database.admin.query(
      `INSERT INTO auth_client
      SELECT 'client-'||i,true,ARRAY['read'] FROM generate_series($1::int,$2::int) i`,
      range,
    );
    // Match registered-client coverage so admission grows with the client store.
    await database.admin.query(
      `INSERT INTO auth_client_coverage (client_id,ready,ready_after)
      SELECT 'client-'||i,true,statement_timestamp() FROM generate_series($1::int,$2::int) i`,
      range,
    );
    // Native insertion caps each owner's history at 64, including expired rows.
    // Keep that full neighborhood fixed while unrelated session owners grow.
    await database.admin.query(
      `INSERT INTO session
      (id,token,"userId","updatedAt","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods")
      SELECT kind||i,kind||i,CASE WHEN kind='history-' THEN 'measured-owner' ELSE 'owner-'||i END,
        now(),now()-interval '1 day',CASE WHEN kind='history-' THEN 'measured-client' ELSE 'client-'||i END,
        'read',7,1,'pwd' FROM generate_series($1::int,$2::int) i CROSS JOIN unnest(ARRAY['history-','session-']) kind
        WHERE kind='session-' OR i<=64`,
      range,
    );
    await database.admin.query(
      `INSERT INTO auth_recovery
      SELECT md5(kind||i),CASE WHEN kind='history-' THEN 'measured-owner' ELSE 'owner-'||i END,7,now()-interval '1 day'
      FROM generate_series($1::int,$2::int) i CROSS JOIN unnest(ARRAY['history-','recovery-']) kind`,
      range,
    );
    await database.admin.query(
      `INSERT INTO verification (id,identifier,value,"expiresAt")
      SELECT 'verification-'||i,'reset-password:history-'||i,'measured-owner',now()-interval '1 day'
      FROM generate_series($1::int,$2::int) i`,
      range,
    );
    // Keep unrelated rows in the seek relation at every scale so the measured
    // missing-key probe uses its indexed plan from the first population onward.
    await database.admin.query(
      `INSERT INTO auth_client_reduction
      SELECT 'client-'||i,'reduction-'||i,ARRAY['read'],true
      FROM generate_series($1::int,$2::int) i ON CONFLICT DO NOTHING`,
      [previous * 1024 + 1, scale * 1024],
    );
    const keys: string[] = [];
    for (let i = range[0]!; i <= range[1]!; i++) {
      const peer = `10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`;
      for (const path of ['/sign-in/email', '/request-password-reset', '/reset-password'])
        keys.push(counterKey(peer, path));
    }
    await database.admin.query(
      `INSERT INTO auth_attempt_counter
      SELECT key,1,statement_timestamp(),true FROM unnest($1::text[]) key`,
      [keys],
    );
    // The operation inserts into these tables. Indexes grown by incremental random inserts hold pages at every fill
    // level, and an insert that lands on a full page splits it and reads its new sibling and neighbour. That is
    // amortized maintenance and not the descent being bounded, so measure from a rebuild that leaves each leaf half
    // empty, which is room for far more inserts than the runs make.
    await database.admin.query(`DO $$ DECLARE name text; BEGIN
      FOR name IN SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename IN ('auth_recovery','verification')
      LOOP EXECUTE format('ALTER INDEX public.%I SET (fillfactor=50)', name); END LOOP; END $$`);
    await database.admin.query('REINDEX TABLE auth_recovery');
    await database.admin.query('REINDEX TABLE verification');
    for (const table of [
      '"user"',
      'account',
      'auth_client',
      'auth_client_coverage',
      'auth_client_reduction',
      'session',
      'auth_recovery',
      'verification',
      'auth_attempt_counter',
    ])
      await database.admin.query(`VACUUM (ANALYZE) ${table}`);
    // Inspect the same whole handlers at every scale, not re-executed EXPLAINs
    // or substitute counter queries. checkGrowth measures them again below.
    await freshServices();
    inspectedIndexVisitsByScale[scale] = await attempts(true);
    if (scale === 1)
      rateSlack.blocks.absolute = Object.entries(inspectedIndexVisitsByScale[scale]!)
        .filter(([relation]) => relation.startsWith('public.'))
        .reduce((sum, [, visits]) => sum + visits, 0);
    await freshServices();
  }

  function nodes(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    const object = value as Record<string, unknown>;
    return [...('Node Type' in object ? [object] : []), ...Object.values(object).flatMap(nodes)];
  }

  async function indexVisits(plans: readonly unknown[]) {
    const visits: Record<string, number> = {};
    const modifications: Record<string, number> = {};
    for (const plan of plans) {
      const query = String((plan as Record<string, unknown>)['Query Text'] ?? '');
      const insert = /\bINSERT\b/i.test(query);
      for (const node of nodes(plan)) {
        const nodeType = node['Node Type'];
        const relation = node['Relation Name'];
        if (typeof relation !== 'string' || typeof node.Schema !== 'string') continue;
        const loops = Number(node['Actual Loops'] ?? 1);
        const relationName = `${node.Schema}.${relation}`;
        if (['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(String(nodeType)))
          visits[relationName] = (visits[relationName] ?? 0) + loops;
        if (nodeType === 'ModifyTable' && insert)
          modifications[relationName] =
            (modifications[relationName] ?? 0) + Math.max(1, Number(node['Actual Rows'] ?? 0)) * loops;
      }
    }

    const modifiedRelations = Object.keys(modifications);
    if (modifiedRelations.length > 0) {
      const indexes = await db.admin.query<{ relation: string; indexes: number }>(
        `SELECT n.nspname||'.'||table_class.relname AS relation,count(index_class.oid)::integer AS indexes
         FROM pg_class table_class JOIN pg_namespace n ON n.oid=table_class.relnamespace
         LEFT JOIN pg_index i ON i.indrelid=table_class.oid
         LEFT JOIN pg_class index_class ON index_class.oid=i.indexrelid
         WHERE n.nspname||'.'||table_class.relname=ANY($1::text[])
         GROUP BY n.nspname,table_class.relname`,
        [modifiedRelations],
      );
      for (const { relation, indexes: count } of indexes.rows)
        visits[relation] = (visits[relation] ?? 0) + (modifications[relation] ?? 0) * count;
    }
    return visits;
  }

  async function request(index: number, peer: string, path: string, body: unknown, origin = issuer) {
    return withAuthTransport(peer, () =>
      services[index % 2]!.handler(
        new Request(issuer + path, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    );
  }

  async function attempts(inspect = false) {
    const peer = `198.18.${Math.floor(++serial / 256)}.${serial % 256}`;
    const recoveryDeliveryKey = createHmac('sha256', secret)
      .update(JSON.stringify(['auth-recovery-mail-v1', account.accountId]))
      .digest('hex');
    const before = delivered;
    const inspectedPlans: unknown[] = [];
    const families = [
      {
        path: '/signin',
        native: '/sign-in/email',
        status: 401,
        body: {
          email: 'measured@example.test',
          password: 'wrong password',
          client_id: 'measured-client',
          scope: ['read'],
        },
      },
      {
        path: '/recovery/start',
        native: '/request-password-reset',
        status: 200,
        body: { email: 'measured@example.test' },
      },
      {
        path: '/recovery/complete',
        native: '/reset-password',
        status: 401,
        body: { account_id: account.accountId, token: 'invalid', new_password: 'new correct horse password' },
      },
    ];
    for (const family of families) {
      const deniedOrigin = () => request(0, peer, family.path, family.body, 'https://other.test');
      if (inspect) {
        const denied = await capture(db, deniedOrigin);
        expect(denied.value.status).toBe(403);
        expect(denied.capture.statements).toEqual([]);
      } else expect((await deniedOrigin()).status).toBe(403);
      // Alternate replicas within one key/window; the fourth charge is denied.
      for (let charge = 0; charge < 4; charge++) {
        if (family.path === '/recovery/start' && charge < 3) {
          // Isolate the per-peer handler limit from the separate per-account mail cooldown.
          await db.admin.query('DELETE FROM auth_attempt_counter WHERE key=$1', [recoveryDeliveryKey]);
        }
        const body =
          family.path === '/signin' && charge === 1 ? { ...family.body, email: 'absent@example.test' } : family.body;
        const invoke = async () => {
          const response = await request(charge, peer, family.path, body);
          if (family.path === '/recovery/start' && charge < 3) {
            const expectedDeliveries = before + charge + 1;
            for (let attempt = 0; attempt < 500 && delivered < expectedDeliveries; attempt++) await Bun.sleep(10);
            expect(delivered).toBe(expectedDeliveries);
          }
          return response;
        };
        const actual = inspect ? await capture(db, invoke) : undefined;
        const response = actual ? actual.value : await invoke();
        expect(response.status).toBe(charge === 3 ? 429 : family.status);
        expect(response.headers.getSetCookie()).toEqual([]);
        if (response.status !== 200) expect(await response.text()).toBe('{"error":"authentication_denied"}');
        if (charge === 3) expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        if (actual) {
          inspectedPlans.push(...actual.capture.plans);
          const expectedConsumes = family.path === '/recovery/start' && charge < 3 ? 2 : 1;
          expect(actual.capture.statements.filter((sql) => sql === attemptStatement)).toHaveLength(expectedConsumes);
          const counterPlans = actual.capture.plans.filter(
            (plan) => (plan as Record<string, unknown>)['Query Text'] === attemptStatement,
          );
          expect(counterPlans).toHaveLength(expectedConsumes);
          for (const plan of counterPlans) {
            const counter = nodes(plan).find((node) => node['Node Type'] === 'ModifyTable');
            expect(counter?.['Actual Rows']).toBe(1);
            expect(counter?.['Actual Loops']).toBe(1);
            expect(counter?.['Conflict Resolution']).toBe('UPDATE');
            expect(counter?.['Conflict Arbiter Indexes']).toEqual(['auth_attempt_counter_pkey']);
          }
          const cost = costOf(actual.capture);
          // Includes all credential/client/verification work, filtered rows and
          // loops. Empty scans cost zero; no populated sequential scan is free.
          expect(cost.plans).toBeGreaterThanOrEqual(cost.statements);
          expect(
            Object.entries(cost.relations)
              .filter(([name]) => name.startsWith('public.'))
              .reduce((sum, [, relation]) => sum + relation.rows, 0),
          ).toBeLessThanOrEqual(8);
          for (const node of nodes(actual.capture.plans)) {
            // Native cold-start catalog introspection is captured and charged
            // too; its fixed-schema scans/loops are not population scans.
            if (node.Schema !== 'public') continue;
            expect(Number(node['Actual Loops'])).toBeLessThanOrEqual(1);
            const examined =
              Number(node['Actual Rows']) +
              Number(node['Rows Removed by Filter'] ?? 0) +
              Number(node['Rows Removed by Index Recheck'] ?? 0);
            const blocks = Number(node['Shared Hit Blocks']) + Number(node['Shared Read Blocks']);
            if (node['Node Type'] === 'Seq Scan') {
              expect(examined).toBe(0);
              expect(blocks).toBe(0);
            }
            if (
              ['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(String(node['Node Type'])) &&
              examined === 0
            )
              emptyScans++;
          }
          if (charge === 3) expect(cost.statements).toBe(1);
        }
      }
      if (inspect) {
        const counter = await db.admin.query('SELECT count,accepted FROM auth_attempt_counter WHERE key=$1', [
          counterKey(peer, family.native),
        ]);
        expect(counter.rows).toEqual([{ count: 3, accepted: false }]);
      }
    }
    expect(delivered - before).toBe(3);
    expect(account.authnEpoch).toBe(7);
    return inspect ? await indexVisits(inspectedPlans) : {};
  }

  test('checkGrowth measures whole own handler including empty bounded scans', async () => {
    const report = await checkGrowth(db, {
      name: 'actual native Auth attempt handlers',
      grow,
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      // Permit an extra tree level across the cohort's bounded index visits;
      // no relative allowance from the much larger constant catalog work.
      slack: rateSlack,
      async operation() {
        await attempts();
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
    verifiedCosts = report.samples.map(({ cost }) => cost);
    console.info('Whole native Auth rate growth:', JSON.stringify(report.samples));
    const relationNames = new Set([
      ...Object.keys(report.samples[1]!.cost.relations ?? {}),
      ...Object.keys(report.samples[2]!.cost.relations ?? {}),
    ]);
    const relationChanges = [...relationNames].map((name) => ({
      relation: name,
      blocks8: report.samples[1]!.cost.relations?.[name]?.blocks ?? 0,
      blocks64: report.samples[2]!.cost.relations?.[name]?.blocks ?? 0,
      indexVisitsAt1: inspectedIndexVisitsByScale[1]?.[name] ?? 0,
    }));
    console.info('Whole native Auth rate relation growth:', JSON.stringify(relationChanges));
    for (const { blocks8, blocks64, indexVisitsAt1 } of relationChanges)
      expect(blocks64 - blocks8).toBeLessThanOrEqual(indexVisitsAt1);
    expect(emptyScans).toBeGreaterThan(0);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBeGreaterThan(12); // Not just the twelve consumes.
      expect(cost.relations?.['public.user']?.rows).toBeGreaterThan(0);
      expect(cost.relations?.['public.account']?.rows).toBeGreaterThan(0);
      expect(cost.relations?.['public.auth_client']?.rows).toBeGreaterThan(0);
    }
  }, 150000);

  test('README rate row matches verified behavior', async () => {
    const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
    const row = readme.split('\n').find((line) => line.startsWith('| Native attempt rate limiter'));
    expect(row).toBeDefined();
    expect(verifiedCosts).toHaveLength(3);
    for (const cost of verifiedCosts) {
      expect(row).toContain(`Q=${cost.statements}`);
      expect(row).toContain(`${cost.rows} examined rows`);
    }
    expect(row).toContain('B=O(log C + log R)');
    expect(row).toContain('one atomic upsert');
    expect(row).toContain('growth-auth-rate.test.ts');
  });
}
