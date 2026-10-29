import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrate, testDatabase } from '../scripts/database.ts';
import { clientAuthority } from '../src/account-workflows.ts';
import { backfillErasureCursorPage, requireErasureCursorVersion } from '../src/erasure-cursor-cutover.ts';
import type { AuthService, TrustedAccessPorts } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';
import { AUTH_WORKFLOW_APPLICATION } from '../src/retention.ts';
import { capture, costOf, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

const migration = '20261029080000_erasure_cursor_cutover.sql';
const id = (n: number) => `owner-${String(n).padStart(6, '0')}`;
const deny = (): never => {
  throw new Error('Denied');
};

// Keep the old schema as an actual applied migration history; do not simulate an
// upgrade by rewriting an ordinal database back into its legacy shape.
test('deployment translates live, terminal and missing cursors without replay, at three native scales', async () => {
  const fixture = testDatabase();
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const previous = mkdtempSync(resolve(root, '.temp/auth-cursor-migrations-'));
  for (const file of readdirSync(resolve(import.meta.dir, '../db/migrations')))
    if (file !== migration) symlinkSync(resolve(import.meta.dir, '../db/migrations', file), resolve(previous, file));
  const admin = new Pool({ connectionString: fixture.url });
  const deploymentSamples: { statements: number; rows: number }[] = [];
  const samples: { statements: number; rows: number; blocks: number }[] = [];
  try {
    for (const scale of [128, 1024, 8192]) {
      const name = `cursor_${scale}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(fixture.url);
      url.pathname = `/${name}`;
      migrate(url.href, previous);
      const db = await openGrowthDatabase(url.href);
      try {
        await db.admin.query(
          `INSERT INTO "user" (id,name,"emailVerified")
          SELECT 'owner-'||lpad(i::text,6,'0'),'',false FROM generate_series(1,$1::int) i ORDER BY i DESC`,
          [scale],
        );
        await db.admin.query(`INSERT INTO auth_client(client_id,first_party,scopes)
          VALUES ('live',true,ARRAY['read']),('finished',false,ARRAY['read'])`);
        await db.admin.query(`INSERT INTO auth_consent(account_id,client_id,scopes)
          SELECT id,'live',ARRAY['read'] FROM "user"`);
        await db.admin.query(
          `INSERT INTO auth_client_coverage(client_id,after_account,ready,ready_after)
          VALUES ('live',$1,false,now()-interval '1 minute'),('finished',$2,true,now())`,
          [id(10) + '-missing', id(scale)],
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction_progress
          (operation_id,client_id,scopes,first_party,after_account,page_after,terminal_account,completed)
          VALUES ('live-operation','live',ARRAY['read'],false,$1,$2,$3,false),
                 ('done-operation','finished',ARRAY['read'],false,$1,$2,$3,true)`,
          [id(10) + '-missing', id(8), id(scale)],
        );
        await db.admin.query(`INSERT INTO auth_client_reduction VALUES ('live','live-operation',ARRAY['read'],false)`);
        migrate(url.href);
        await expect(
          db.pool.query(`INSERT INTO "user"(id,name,"emailVerified") VALUES ('late','',false)`),
        ).rejects.toThrow('cutover incomplete');
        const first = await capture(db, () => backfillErasureCursorPage(db.pool));
        expect(first.value).toEqual({ done: false, keys: 99 });
        const deploymentCost = costOf(first.capture);
        expect(deploymentCost.statements).toBeLessThanOrEqual(110);
        expect(
          deploymentCost.rows,
          JSON.stringify({ relations: deploymentCost.relations, statements: first.capture.statements }),
        ).toBeLessThanOrEqual(600);
        deploymentSamples.push(deploymentCost);
        // Simulate a process restart between committed pages using a fresh pool.
        const resumed = new Pool({ connectionString: url.href });
        let result;
        let pages = 1;
        try {
          do {
            const state = (await db.admin.query('SELECT phase,after_key FROM auth_erasure_cursor_cutover')).rows[0];
            if (
              (state.phase === 'coverage' && state.after_key === 'finished') ||
              (state.phase === 'reduction' && state.after_key === 'done-operation')
            ) {
              const translated = await capture(db, () => backfillErasureCursorPage(db.pool));
              const cost = costOf(translated.capture);
              expect(cost.statements).toBeLessThanOrEqual(12);
              expect(cost.rows).toBeLessThanOrEqual(16);
              expect(cost.blocks).toBeLessThanOrEqual(60);
              const relation = cost.relations[state.phase === 'coverage' ? 'public.user' : 'public.auth_consent'];
              expect(relation?.rows).toBeLessThanOrEqual(3);
              expect(relation?.sequentialScans).toBe(0);
              result = translated.value;
            } else result = await backfillErasureCursorPage(resumed);
            expect(result.keys).toBeLessThanOrEqual(99);
            pages++;
          } while (!result.done);
        } finally {
          await resumed.end();
        }
        expect(pages).toBeGreaterThan(Math.floor(scale / 99));
        expect(await backfillErasureCursorPage(db.pool)).toEqual({ done: true, keys: 0 });
        const marker = (await db.admin.query('SELECT * FROM auth_erasure_cursor_cutover')).rows[0];
        expect(marker).toMatchObject({ writer_version: 2, phase: 'done', after_key: null, after_client: null });
        expect(marker.completed_at).toBeInstanceOf(Date);
        const ordinal = async (n: number) =>
          (await db.admin.query('SELECT traversal_ordinal FROM "user" WHERE id=$1', [id(n)])).rows[0]
            .traversal_ordinal as string;
        const consentOrdinal = async (n: number) =>
          (
            await db.admin.query(
              "SELECT traversal_ordinal FROM auth_consent WHERE client_id='live' AND account_id=$1",
              [id(n)],
            )
          ).rows[0].traversal_ordinal as string;
        expect(
          (await db.admin.query("SELECT after_ordinal FROM auth_client_coverage WHERE client_id='live'")).rows[0]
            .after_ordinal,
        ).toBe(await ordinal(10));
        const progress = (
          await db.admin.query("SELECT * FROM auth_client_reduction_progress WHERE operation_id='live-operation'")
        ).rows[0];
        expect(progress).toMatchObject({
          after_ordinal: await consentOrdinal(10),
          page_after: await consentOrdinal(8),
          terminal_ordinal: await consentOrdinal(scale),
          cutover_after: await consentOrdinal(10),
        });
        for (const table of ['auth_client_coverage', 'auth_client_reduction_progress']) {
          const cursors = (await db.admin.query(`SELECT * FROM ${table}`)).rows;
          expect(JSON.stringify(cursors)).not.toContain('owner-');
          for (const cursor of cursors) {
            expect(cursor.legacy_after_account).toBeNull();
            expect(cursor.after_ordinal).toMatch(/^\d+$/);
            if ('page_after' in cursor) {
              expect(cursor.page_after).toMatch(/^\d+$/);
              expect(cursor.terminal_ordinal).toMatch(/^\d+$/);
              expect(cursor.page_end).toMatch(/^\d+$/);
              expect(cursor.legacy_page_after).toBeNull();
              expect(cursor.legacy_terminal_account).toBeNull();
            }
          }
        }
        const connection = await db.pool.connect();
        try {
          await expect(requireErasureCursorVersion(connection, 1)).rejects.toThrow('version refused');
          await requireErasureCursorVersion(connection);
        } finally {
          connection.release();
        }
        await expect(
          db.pool.query("UPDATE auth_client_coverage SET legacy_after_account='old-worker'"),
        ).rejects.toThrow('version refused');
        await expect(db.pool.query("UPDATE auth_client_coverage SET after_account='old-worker'")).rejects.toThrow();
        const authority = clientAuthority(db.pool, {} as TrustedAccessPorts, deny, (v) => v as string[]);
        const expected = Array.from({ length: scale - 10 }, (_, n) => id(n + 11));
        const coverage: string[] = [];
        let done = false;
        // Read the native relation page represented by each returned ordinal.
        let boundary = await ordinal(10);
        while (!done) {
          const before = boundary;
          const measuredCoverage = await capture(db, () =>
            authority.internal.backfillClientIssuance({ clientId: 'live', limit: 100 }),
          );
          const coverageCost = costOf(measuredCoverage.capture);
          expect(coverageCost.statements).toBeLessThanOrEqual(10);
          expect(coverageCost.rows).toBeLessThanOrEqual(400);
          expect(coverageCost.blocks).toBeLessThanOrEqual(1600);
          const page = measuredCoverage.value;
          boundary = (await db.admin.query("SELECT after_ordinal FROM auth_client_coverage WHERE client_id='live'"))
            .rows[0].after_ordinal;
          coverage.push(
            ...(
              await db.admin.query(
                'SELECT id FROM "user" WHERE traversal_ordinal>$1 AND traversal_ordinal<=$2 ORDER BY traversal_ordinal',
                [before, boundary],
              )
            ).rows.map((r) => r.id as string),
          );
          done = page.ready;
        }
        expect(coverage).toEqual(expected);
        await db.admin.query('ANALYZE');
        const measured = await capture(db, () =>
          authority.internal.clientReductionPage({
            clientId: 'live',
            operationId: 'live-operation',
            after: progress.after_ordinal,
            limit: 100,
          }),
        );
        expect(measured.value.items).toEqual(expected.slice(0, 100));
        expect(measured.value.next).toBe(await consentOrdinal(110));
        const cost = costOf(measured.capture);
        expect(cost.statements).toBeLessThanOrEqual(10);
        expect(
          cost.rows,
          JSON.stringify({ relations: cost.relations, statements: measured.capture.statements }),
        ).toBeLessThanOrEqual(110);
        expect(cost.blocks).toBeLessThanOrEqual(160);
        samples.push(cost);
        const visited = [...measured.value.items];
        let remaining = measured.value;
        while (remaining.next !== null) {
          // Fixture acknowledgement of this page's already processed owners;
          // receipt/floor acknowledgement is exercised by client-reduction-cost.
          await db.admin.query(
            "UPDATE auth_client_reduction_progress SET after_ordinal=page_end WHERE operation_id='live-operation'",
          );
          remaining = await authority.internal.clientReductionPage({
            clientId: 'live',
            operationId: 'live-operation',
            after: remaining.next,
            limit: 100,
          });
          visited.push(...remaining.items);
        }
        expect(visited).toEqual(expected);

        // No separate mapping survives native owner deletion. Late keys receive
        // sequence values, even when their spelling sorts before every old key.
        const deletedOrdinal = await ordinal(1);
        await db.admin.query('DELETE FROM "user" WHERE id=$1', [id(1)]);
        expect(
          (await db.admin.query('SELECT id FROM "user" WHERE traversal_ordinal=$1', [deletedOrdinal])).rows,
        ).toEqual([]);
        await db.admin.query(`INSERT INTO "user"(id,name,"emailVerified") VALUES ('aaa-late','',false)`);
        const late = (await db.admin.query(`SELECT traversal_ordinal FROM "user" WHERE id='aaa-late'`)).rows[0]
          .traversal_ordinal;
        expect(BigInt(late)).toBeGreaterThan(BigInt(await ordinal(scale)));
      } finally {
        await db.close();
      }
    }
    expect(new Set(deploymentSamples.map((cost) => cost.statements)).size).toBe(1);
    expect(new Set(deploymentSamples.map((cost) => cost.rows)).size).toBe(1);
    expect(new Set(samples.map((cost) => cost.statements)).size).toBe(1);
    expect(new Set(samples.map((cost) => cost.rows)).size).toBe(1);
  } finally {
    await admin.end();
    rmSync(previous, { recursive: true });
    fixture.close();
  }
}, 180000);

test('DBOS refuses an old recovered worker and persists only ordinal page boundaries', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    await pool.query(`INSERT INTO auth_client(client_id,first_party,scopes) VALUES ('worker',false,ARRAY['read']);
      INSERT INTO auth_client_coverage(client_id,ready) VALUES ('worker',true);
      INSERT INTO "user"(id,name,"emailVerified") VALUES ('z-first','',false),('a-second','',false);
      INSERT INTO auth_consent(account_id,client_id,scopes) VALUES ('z-first','worker',ARRAY['read']),('a-second','worker',ARRAY['read'])`);
    const authority = clientAuthority(pool, {} as TrustedAccessPorts, deny, (v) => v as string[]);
    await authority.internal.beginClientReduction({
      clientId: 'worker',
      operationId: 'operation',
      scopes: [],
      firstParty: false,
    });
    await expect(pool.query('UPDATE auth_client_reduction_progress SET completed=true')).rejects.toThrow(
      'version refused',
    );
    const run = DBOS.registerWorkflow(
      async (version: number) => {
        return DBOS.runStep(
          async () => {
            const connection = await pool.connect();
            try {
              await requireErasureCursorVersion(connection, version);
            } finally {
              connection.release();
            }
            return authority.internal.clientReductionPage({
              clientId: 'worker',
              operationId: 'operation',
              after: '',
              limit: 1,
            });
          },
          { name: 'ordinal-page', retriesAllowed: false },
        );
      },
      { name: 'cursor-worker' },
    );
    DBOS.setConfig({
      name: 'auth-cursor-test',
      systemDatabaseUrl: fixture.url,
      systemDatabaseSchemaName: 'auth_dbos',
      logLevel: 'warn',
    });
    await DBOS.launch();
    const old = await DBOS.startWorkflow(run, { workflowID: 'old-worker' })(1);
    await expect(old.getResult()).rejects.toThrow('version refused');
    const recovered = await DBOS.rewindWorkflow('old-worker', { startStep: 0 });
    await expect(recovered.getResult()).rejects.toThrow('version refused');
    const current = await DBOS.startWorkflow(run, { workflowID: 'current-worker' })(2);
    const page = await current.getResult();
    expect(page.items).toEqual(['z-first']);
    expect(page.next).toMatch(/^\d+$/);
    // A returned boundary cannot skip an owner that has not acknowledged.
    await expect(
      authority.internal.clientReductionPage({
        clientId: 'worker',
        operationId: 'operation',
        after: page.next!,
        limit: 1,
      }),
    ).rejects.toThrow();
    await pool.query("DELETE FROM auth_consent WHERE account_id='z-first'");
    const last = await authority.internal.clientReductionPage({
      clientId: 'worker',
      operationId: 'operation',
      after: page.next!,
      limit: 1,
    });
    expect(last).toEqual({ items: ['a-second'], next: null });
    await expect(
      authority.internal.finishClientReduction({
        clientId: 'worker',
        operationId: 'operation',
        scopes: [],
        firstParty: false,
      }),
    ).rejects.toThrow();
    await pool.query("DELETE FROM auth_consent WHERE account_id='a-second'");
    await authority.internal.finishClientReduction({
      clientId: 'worker',
      operationId: 'operation',
      scopes: [],
      firstParty: false,
    });
    const saved = (await pool.query('SELECT * FROM auth_client_reduction_progress')).rows[0];
    expect(saved.completed).toBe(true);
    expect(saved.after_ordinal).toBe(saved.terminal_ordinal);
    expect(JSON.stringify(saved)).not.toContain('z-first');
    expect(JSON.stringify(saved)).not.toContain('a-second');
  } finally {
    await DBOS.shutdown({ deregister: true });
    await pool.end();
    fixture.close();
  }
}, 60000);

test('production reduction replaces legacy DBOS pages from the translated acknowledged ordinal', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  const operationId = `accounts:${createHash('sha256').update(JSON.stringify('client-reduction:upgrade')).digest('hex')}`;
  const request = {
    kind: 'client-reduction' as const,
    operationKey: 'upgrade',
    authorization: 'approved',
    clientId: 'upgrade',
    scopes: [],
    firstParty: false,
  };
  let workflows: ReturnType<typeof createAccountWorkflows> | undefined;
  const visited: string[] = [];
  let fail = true;
  try {
    await pool.query(`INSERT INTO auth_client(client_id,first_party,scopes) VALUES ('upgrade',false,ARRAY['read']);
      INSERT INTO auth_client_coverage(client_id,ready) VALUES ('upgrade',true);
      INSERT INTO auth_consent(account_id,client_id,scopes)
      VALUES ('owner-1','upgrade',ARRAY['read']),('owner-2','upgrade',ARRAY['read']),
             ('owner-3','upgrade',ARRAY['read']),('owner-4','upgrade',ARRAY['read'])`);
    const authority = clientAuthority(pool, {} as TrustedAccessPorts, deny, (v) => v as string[]);
    await authority.internal.beginClientReduction({ ...request, operationId });
    // The deployment translates a page starting at owner-1, acknowledged through
    // owner-2. Its stable restart snapshot must not replay either owner.
    await pool.query(`UPDATE auth_client_reduction_progress SET
      after_ordinal=(SELECT traversal_ordinal FROM auth_consent WHERE account_id='owner-2'),
      cutover_after=(SELECT traversal_ordinal FROM auth_consent WHERE account_id='owner-2'),
      page_after=(SELECT traversal_ordinal FROM auth_consent WHERE account_id='owner-1')`);
    await pool.query('INSERT INTO auth_workflow_request VALUES ($1,$2,$3)', [operationId, Buffer.alloc(32), request]);
    const legacyId = `${operationId}:page:${createHash('sha256').update(JSON.stringify('owner-1')).digest('hex')}`;
    const legacy = DBOS.registerWorkflow(
      async (_input: unknown) => {
        throw new Error('Old executor interrupted');
      },
      { name: 'accounts.client-reduction' },
    );
    DBOS.setConfig({
      name: AUTH_WORKFLOW_APPLICATION,
      systemDatabaseUrl: fixture.url,
      systemDatabaseSchemaName: 'auth_dbos',
      applicationVersion: 'accounts-v1',
      logLevel: 'warn',
    });
    await DBOS.launch();
    await expect(
      (
        await DBOS.startWorkflow(legacy, { workflowID: legacyId })({ ...request, operationId, after: 'owner-1' })
      ).getResult(),
    ).rejects.toThrow();
    await DBOS.shutdown({ deregister: true });
    const access: AccountWorkflowPorts = {
      registrationTarget: deny,
      reserveHandle: deny,
      createPending: deny,
      claimHandle: deny,
      activate: deny,
      expireRegistration: deny,
      releaseExpiredRegistrationHandle: deny,
      provisioningReference: deny,
      provisioningEvidence: deny,
      authorizeOperation: async () => ({ actor: { accountId: 'admin' } }),
      async readAccount(accountId) {
        visited.push(accountId);
        if (accountId === 'owner-4' && fail) throw new Error('Interrupted ordinal owner');
        return { accountId, handle: null, operatorAccountId: null, state: 'deleted', fenced: true };
      },
      raiseFence: deny,
    };
    workflows = createAccountWorkflows({
      database: pool,
      systemDatabaseUrl: fixture.url,
      stagingKey: randomBytes(32),
      auth: { internal: authority.internal } as AuthService,
      access,
    });
    await workflows.start();
    // The actual production registrar refuses cached legacy pages before fences.
    await expect((await DBOS.rewindWorkflow(legacyId, { startStep: 0 })).getResult()).rejects.toThrow(
      'version refused',
    );
    expect(visited).toEqual([]);
    await expect(workflows.resumeClientReduction('upgrade')).rejects.toThrow();
    expect(visited[0]).toBe('owner-3');
    expect(visited.slice(1).every((id) => id === 'owner-4')).toBe(true);
    expect(visited.length).toBeGreaterThanOrEqual(2);
    const failedVisits = visited.length;
    fail = false;
    await workflows.close();
    workflows = createAccountWorkflows({
      database: pool,
      systemDatabaseUrl: fixture.url,
      stagingKey: randomBytes(32),
      auth: { internal: authority.internal } as AuthService,
      access,
    });
    await workflows.start();
    expect(await workflows.resumeClientReduction('upgrade')).toEqual({ clientId: 'upgrade' });
    expect(visited).toHaveLength(failedVisits + 1);
    expect(visited.filter((id) => id === 'owner-3')).toHaveLength(1);
    expect(visited.at(-1)).toBe('owner-4');
    const progress = (await pool.query('SELECT * FROM auth_client_reduction_progress')).rows[0];
    expect(progress.completed).toBe(true);
    expect(progress.after_ordinal).toBe(progress.terminal_ordinal);
    expect(JSON.stringify(progress)).not.toContain('owner-');
    expect(await workflows.resumeClientReduction('upgrade')).toEqual({ clientId: 'upgrade' });
    expect(visited).toHaveLength(failedVisits + 1);
  } finally {
    if (workflows) await workflows.close();
    else await DBOS.shutdown({ deregister: true });
    await pool.end();
    fixture.close();
  }
}, 60000);
