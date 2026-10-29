import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrate, testDatabase } from '../scripts/database.ts';
import { backfillErasureCursorPage } from '../src/erasure-cursor-cutover.ts';
import { capture, costOf, openGrowthDatabase } from '../../kernel/test/support/growth.ts';
import { statementAttributions } from '../../kernel/test/support/growth-report.ts';

test('each native deployment page stays bounded before and after its checkpoint', async () => {
  const fixture = testDatabase();
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const previous = mkdtempSync(resolve(root, '.temp/auth-cursor-page-'));
  for (const file of readdirSync(resolve(import.meta.dir, '../db/migrations')))
    if (file < '20261029080000_erasure_cursor_cutover.sql')
      symlinkSync(resolve(import.meta.dir, '../db/migrations', file), resolve(previous, file));
  const admin = new Pool({ connectionString: fixture.url });
  try {
    await admin.query('CREATE DATABASE cursor_page_cost');
    const url = new URL(fixture.url);
    url.pathname = '/cursor_page_cost';
    migrate(url.href, previous);
    const db = await openGrowthDatabase(url.href);
    try {
      await db.admin.query(`INSERT INTO "user" (id,name,"emailVerified")
        SELECT 'owner-'||lpad(i::text,6,'0'),'',false FROM generate_series(1,128) i ORDER BY i DESC`);
      await db.admin.query(`INSERT INTO auth_client(client_id,first_party,scopes)
        VALUES ('live',true,ARRAY['read']),('finished',false,ARRAY['read']);
        INSERT INTO auth_consent(account_id,client_id,scopes) SELECT id,'live',ARRAY['read'] FROM "user";
        INSERT INTO auth_client_coverage(client_id,after_account,ready)
        VALUES ('live','owner-000010-missing',false),('finished','owner-000128',true)`);
      migrate(url.href);
      for (let page = 0; page < 2; page++) {
        const measured = await capture(db, () => backfillErasureCursorPage(db.pool));
        const cost = costOf(measured.capture);
        console.info('Deployment page:', JSON.stringify(statementAttributions(measured.capture)));
        expect(measured.value).toEqual({ done: false, keys: page === 0 ? 99 : 29 });
        expect(cost.rows).toBeLessThanOrEqual(600);
        expect(cost.statements).toBeLessThanOrEqual(110);
      }
    } finally {
      await db.close();
    }
  } finally {
    await admin.end();
    rmSync(previous, { recursive: true });
    fixture.close();
  }
}, 60000);
