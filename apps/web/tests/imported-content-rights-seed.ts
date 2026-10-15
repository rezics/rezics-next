import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { grantRecordedPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { seedImportedCatalogue } from '../../../tests/qa/fixtures/imported-catalogue.ts';
import { settledWrite } from '../../../tests/qa/support/settled-write.ts';
import { joiningAuthFixture } from '../../../tests/qa/support/joining-auth.ts';

const run = process.env.REZICS_QA_RUN_ID ?? '';
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(run)) throw new Error('Use isolated browser QA');
const auth = await joiningAuthFixture(process.env.REZICS_BROWSER_STACK_RUN_ID ?? run);
const operator = await platformAdministratorSession({ ...process.env,
  REZICS_WEB_AUTH_PUBLIC_PATH: auth.publicConfigPath, REZICS_WEB_AUTH_PRIVATE_PATH: auth.privateConfigPath },
  'openid work:create work:edit work:read source:intake source:read rights:assess governance:decide rights:decide');
const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
try {
  await grantRecordedPlatformUse(pool, operator.principalId, ['catalogue-import']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [scope, action] of [['work:create:catalogue-import', 'work.create'], ['work:create:root', 'work.create'],
      ['rights:assess', 'rights.assess'], ['governance:platform', 'governance.moderate'],
      ['governance:platform', 'governance.rights.decide'], ['governance:platform', 'governance.rule.publish']]) {
      await grantFixtureAuthority(client, { scope: scope!, requireDispatch: true,
        representations: [{ principalId: operator.principalId, actor: operator.actingSubject, action: action!, lifetime: '8 hours' }],
        grant: { actor: operator.actingSubject, action: action!, lifetime: '8 hours' } });
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} finally { await pool.end(); }
const request = async (method: string, path: string, body?: unknown, key?: string) => fetch(new URL(path, operator.mainOrigin), {
  method, headers: { authorization: `Bearer ${await operator.session.current()}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const directory = resolve('.temp/imported-content-rights-browser', run);
mkdirSync(directory, { recursive: true });
const imported = await seedImportedCatalogue({ actor: operator.actingSubject, root: directory,
  request: (method, path, body, key) => settledWrite(request, method, path, body, key) });
const key = crypto.randomUUID();
const response = await request('POST', '/v1/governance/rules', { profile: 'governance-rule-v1',
  ref: `urn:rezics:rule:imported-content:${run}`, scopeId: 'governance:platform',
  actingSubject: operator.actingSubject, expectedRevision: null,
  document: { rule: 'Restrict imported material after review of a rights holder complaint.' }, idempotencyKey: key }, key);
if (!response.ok) throw new Error(`Rights rule: ${response.status} ${await response.text()}`);
const rule = await response.json() as { ref: string; revision: string; digest: string };
writeFileSync(resolve(directory, 'seed.json'), JSON.stringify({ ...imported, rule,
  publicConfigPath: auth.publicConfigPath, privateConfigPath: auth.privateConfigPath }));
