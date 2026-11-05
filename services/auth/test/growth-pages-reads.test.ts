import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount } from '../src/index.ts';

const signingKid = randomUUID();
const signingKey = {
  ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
  kid: signingKid,
};

for (const axis of ['sessions', 'clients', 'consents'] as const) {
  test(`consent read and sessions list stay bounded as unrelated ${axis} grow`, async () => {
    // The check database is shared by parallel files. Signing and page reads need a private server.
    const fixture = testDatabase();
    const url = fixture.url;
    const db = await openGrowthDatabase(url);
    try {
      const prefix = randomUUID();
      const person: AccessAccount = {
        accountId: randomUUID(),
        kind: 'actor',
        state: 'pending',
        automated: false,
        authnEpoch: 1,
      };
      const issuer = 'https://growth.pages.auth.test';
      const web = `${prefix}-web`;
      const external = `${prefix}-external`;
      const password = 'pages growth fixture correct horse battery staple';
      const service = await createAuthService({
        database: db.pool,
        issuer,
        audience: 'https://growth.pages.api.test',
        secret: 'growth-pages-secret-with-at-least-32-bytes',
        signing: { activeKid: signingKid, privateKeys: [signingKey] },
        trustedAccess: trustedAccessPorts({
          async readFencedAccount(id) {
            return this.readAccount(id);
          },
          async readAccount(id) {
            return id === person.accountId ? person : null;
          },
          async authorizeProvisioning(accountId) {
            return { accountId };
          },
        }),
      });
      await service.internal.provisionPassword({
        authorization: person.accountId,
        email: `${prefix}@example.test`,
        password,
      });
      person.state = 'active';
      await service.internal.registerClient({ clientId: web, firstParty: true, scopes: ['read'] });
      await service.internal.registerClient({
        clientId: external,
        firstParty: false,
        scopes: ['read'],
        displayName: 'Selected Client',
      });
      let cookie = '';
      const request = (path: string, body?: unknown) =>
        service.handler(
          new Request(`${issuer}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { origin: issuer, 'content-type': 'application/json', cookie },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const login = await request('/signin', {
        account_id: person.accountId,
        password,
        client_id: web,
        scope: ['read'],
      });
      expect(login.status).toBe(200);
      cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect((await request('/consent', { client_id: external, scope: ['read'] })).status).toBe(200);
      // Fix the selected person's full 64-session neighborhood at every scale.
      const current = (await db.admin.query('SELECT id FROM session WHERE "userId"=$1', [person.accountId])).rows[0].id;
      await db.admin.query(
        `INSERT INTO session (id,token,"userId","clientId","createdAt","updatedAt","expiresAt","grantedScope","authnEpoch","authTime","authMethods")
        SELECT $1||'-own-'||i,$1||'-token-'||i,$2,$3,now()-i*interval '1 second',now(),now()+interval '1 day','read',1,extract(epoch FROM now())::integer,'pwd'
        FROM generate_series(1,63) i`,
        [prefix, person.accountId, external],
      );
      // Consent and session reads are primary-key seeks. A 64-row session neighborhood
      // is still small enough for a sequential scan, which exceeds the absolute row cap
      // on axes that do not themselves grow sessions. Seed every relation those reads
      // touch so the planner uses the indexes before the first sample.
      await db.admin.query(
        `INSERT INTO "user" (id,name,"emailVerified","createdAt","updatedAt")
        SELECT $1||'-planner-'||i,'',false,now(),now() FROM generate_series(1,2000) i`,
        [prefix],
      );
      await db.admin.query(
        `INSERT INTO session (id,token,"userId","clientId","createdAt","updatedAt","expiresAt","grantedScope","authnEpoch","authTime","authMethods")
        SELECT $1||'-planner-'||i,$1||'-planner-'||i,$1||'-planner-'||i,$2,now(),now(),now()+interval '1 day','read',1,extract(epoch FROM now())::integer,'pwd'
        FROM generate_series(1,2000) i`,
        [prefix, web],
      );
      await db.admin.query(
        `INSERT INTO auth_client (client_id,first_party,scopes,display_name)
        SELECT $1||'-planner-client-'||i,false,ARRAY['read'],'Planner' FROM generate_series(1,2000) i`,
        [prefix],
      );
      await db.admin.query(
        `INSERT INTO auth_client_coverage (client_id,ready)
        SELECT $1||'-planner-client-'||i,true FROM generate_series(1,2000) i`,
        [prefix],
      );
      await db.admin.query(
        `INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party)
        SELECT $1||'-planner-client-'||i,$1||'-planner-client-'||i,ARRAY['read'],false FROM generate_series(1,2000) i`,
        [prefix],
      );
      await db.admin.query(
        `INSERT INTO auth_consent (account_id,client_id,scopes)
        SELECT $1||'-planner-'||i,$1||'-planner-client-'||i,ARRAY['read'] FROM generate_series(1,2000) i`,
        [prefix],
      );
      await db.admin.query(
        'VACUUM (ANALYZE) "user", session, auth_client, auth_client_coverage, auth_client_reduction, auth_consent',
      );
      const reports = [];
      for (const path of [`/consent/${external}`, '/sessions']) {
        let grown = 0;
        const tag = `${prefix}-${path.startsWith('/consent') ? 'consent' : 'list'}`;
        const report = await checkGrowth(db, {
          name: `${path.startsWith('/consent') ? 'Consent read' : 'Session list'} with unrelated ${axis}`,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          async grow(_, scale) {
            // Each route gets its own independent 1x/8x/64x population.
            const range = [tag, grown + 1, scale * 500];
            if (axis === 'sessions') {
              await db.admin.query(
                `INSERT INTO "user" (id,name,"emailVerified","createdAt","updatedAt")
                SELECT $1||i,'',false,now(),now() FROM generate_series($2::int,$3::int) i`,
                range,
              );
              await db.admin.query(
                `INSERT INTO session (id,token,"userId","clientId","createdAt","updatedAt","expiresAt","grantedScope","authnEpoch","authTime","authMethods")
                SELECT $1||i,$1||i,$1||i,$4,now(),now(),now()+interval '1 day','read',1,extract(epoch FROM now())::integer,'pwd'
                FROM generate_series($2::int,$3::int) i`,
                [...range, web],
              );
            } else if (axis === 'clients') {
              await db.admin.query(
                `INSERT INTO auth_client (client_id,first_party,scopes,display_name)
                SELECT $1||i,false,ARRAY['read'],'Unrelated' FROM generate_series($2::int,$3::int) i`,
                range,
              );
              await db.admin.query(
                `INSERT INTO auth_client_coverage (client_id,ready)
                SELECT $1||i,true FROM generate_series($2::int,$3::int) i`,
                range,
              );
              await db.admin.query(
                `INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party)
                SELECT $1||i,$1||i,ARRAY['read'],false FROM generate_series($2::int,$3::int) i`,
                range,
              );
            } else {
              await db.admin.query(
                `INSERT INTO auth_consent (account_id,client_id,scopes)
                SELECT $1||i,$4,ARRAY['read'] FROM generate_series($2::int,$3::int) i`,
                [...range, external],
              );
            }
            grown = scale * 500;
            await db.admin.query('VACUUM (ANALYZE)');
          },
          async operation() {
            const response = await request(path);
            expect(response.status).toBe(200);
            const body = await response.json();
            if (path.startsWith('/consent')) {
              expect(body).toEqual({
                client_id: external,
                display_name: 'Selected Client',
                scopes: ['read'],
                granted: ['read'],
              });
            } else {
              expect(body.sessions).toHaveLength(64);
              expect(body.sessions[0]).toMatchObject({ id: current, current: true });
              expect(body.sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
              for (const session of body.sessions)
                expect(session.client_display_name).toBe(session.client_id === external ? 'Selected Client' : null);
            }
          },
        });
        expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
        expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
        expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
        for (const { cost } of report.samples) {
          // Full handler capture includes native cookie/session and authorization reads.
          expect(cost.statements).toBeLessThanOrEqual(10);
          expect(cost.rows).toBeLessThanOrEqual(path === '/sessions' ? 3 * 64 + 32 : 32);
          const relation = { sessions: 'session', clients: 'auth_client', consents: 'auth_consent' }[axis];
          expect(cost.relations?.[`public.${relation}`]?.sequentialScans ?? 0).toBe(0);
        }
        reports.push(report);
        // Remove only this route's seeded population so both reads see the same
        // independent 1x/8x/64x growth, with no previous run masking a scan.
        const selected = `SELECT $1||i FROM generate_series(1,$2::int) i`;
        if (axis === 'sessions') {
          await db.admin.query(`DELETE FROM session WHERE "userId" IN (${selected})`, [tag, grown]);
          await db.admin.query(`DELETE FROM "user" WHERE id IN (${selected})`, [tag, grown]);
        } else if (axis === 'clients') {
          for (const table of ['auth_client_reduction', 'auth_client_coverage', 'auth_client'])
            await db.admin.query(`DELETE FROM ${table} WHERE client_id IN (${selected})`, [tag, grown]);
        } else {
          await db.admin.query(`DELETE FROM auth_consent WHERE account_id IN (${selected})`, [tag, grown]);
        }
      }
      await Bun.write(`.temp/pages-reads-${axis}-growth.json`, JSON.stringify(reports, null, 2));
    } finally {
      await db.close();
      fixture.close();
    }
  }, 120000);
}
