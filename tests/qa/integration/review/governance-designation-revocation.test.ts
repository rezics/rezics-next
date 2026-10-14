import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../../scripts/dev/config.ts';
import { personaSessions, type PersonaSessions } from '../../support/personas.ts';

type Grant = {
  id: string; permission: string; scopeId: string; issuerSubject: string;
  recipient: { principalId?: string }; active: boolean; generation: string;
};
type Page = { authorityEpoch: string; items: Grant[]; nextCursor: string | null };
const controls = [
  { migration: '2066_governance_rule_publisher.sql',
    installed: 'seed_rule_publisher_assignment_ceiling',
    permission: 'platform:resource:governance.rule.publish', scope: () => 'governance:platform' },
  { migration: '2067_realm_attachment_assignment.sql',
    installed: 'seed_realm_attachment_assignment_ceiling',
    permission: 'platform:resource:realm.attach', scope: () => `realm:attach:${sessions!.realm}` },
] as const;
let sessions: PersonaSessions | undefined;
let access: Pool | undefined;
let admin: Pool | undefined;
let database: string;
let baseline: string;
let baselineReady = false;
let evidencePath: string;
let phase = 'bootstrap';
const repairPath = 'services/main/migrations/access/2070_governance_designation_ceiling_revocation.sql';

function evidence(value: Record<string, unknown>) {
  appendFileSync(evidencePath, `${JSON.stringify({ phase, ...value })}\n`);
}

async function start() {
  sessions = await personaSessions('public', { observeMain: async observation => {
    evidence({ caller: observation.caller.accountId, request: observation.request,
      response: observation.response, requestStartedAt: observation.requestStartedAt,
      answeredAt: observation.answeredAt });
  } });
  access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 1 });
}

async function close() {
  try { await sessions?.close(); }
  finally { sessions = undefined; await access?.end(); access = undefined; }
}

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

async function page(after?: string): Promise<Page> {
  const operator = sessions!.operator;
  const query = new URLSearchParams({ profile: 'platform-grants-v1',
    issuerSubject: operator.actingSubject!, ...(after ? { after } : {}) });
  return answer(operator.main('GET', `/v1/access/grants?${query}`));
}

async function inventory(): Promise<Grant[]> {
  const grants: Grant[] = [];
  let after: string | undefined;
  do {
    const result = await page(after);
    grants.push(...result.items);
    after = result.nextCursor ?? undefined;
  } while (after);
  return grants;
}

async function change(body: Record<string, unknown>): Promise<Response> {
  return sessions!.operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', issuerSubject: sessions!.operator.actingSubject,
    expectedAuthorityEpoch: (await page()).authorityEpoch, ...body,
  });
}

async function installedRevocation() {
  return (await access!.query<{ definition: string }>(
    "SELECT pg_get_functiondef('access.revoke_source_publication_assignment_ceiling()'::regprocedure) AS definition",
  )).rows[0]!.definition;
}

async function permissionRows() {
  return (await access!.query<{ id: string; value: { active: boolean } }>(
    'SELECT id,to_jsonb(g) AS value FROM access.permission_grant g ORDER BY id',
  )).rows;
}

beforeAll(async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.ACCESS_DATABASE_URL) throw new Error('Requires the isolated QA integration tier');
  evidencePath = resolve('.temp/governance-designation-revocation', runId, 'requests.jsonl');
  mkdirSync(dirname(evidencePath), { recursive: true });
  const started = performance.now();
  await start();
  for (const control of controls) {
    const source = readFileSync(`services/main/migrations/access/${control.migration}`, 'utf8');
    const installed = await access!.query<{ definition: string }>(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      [`access.${control.installed}(uuid,text)`]);
    evidence({ migration: control.migration, sha256: createHash('sha256').update(source).digest('hex'),
      source, installed: installed.rows[0]!.definition });
  }
  const repair = readFileSync(repairPath, 'utf8');
  evidence({ migration: repairPath, sha256: createHash('sha256').update(repair).digest('hex'),
    source: repair, installed: await installedRevocation() });
  const compose = readEnv(resolve('.temp/stack', `rezics-qa-${runId}`, 'compose.env'));
  const url = new URL(Bun.env.ACCESS_DATABASE_URL);
  database = url.pathname.slice(1);
  baseline = `designation_baseline_${randomUUID().replaceAll('-', '')}`;
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('Unsafe QA database name');
  admin = new Pool({ connectionString: `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`, max: 1 });
  // Preserve the actual bootstrapped owner state once. Each destructive case
  // restores this copy after closing its listeners, including failed assertions.
  await close();
  await admin.query(`CREATE DATABASE ${baseline} WITH TEMPLATE ${database}`);
  baselineReady = true;
  evidence({ baseline, preparationSeconds: (performance.now() - started) / 1000 });
}, 180_000);

afterEach(async () => {
  await close();
  if (admin && baselineReady) {
    await admin.query(`DROP DATABASE ${database}`);
    await admin.query(`CREATE DATABASE ${database} WITH TEMPLATE ${baseline} OWNER access`);
    evidence({ restored: database });
  }
});

afterAll(async () => {
  try {
    await close();
    if (admin && baselineReady) await admin.query(`DROP DATABASE IF EXISTS ${baseline}`);
  } finally { await admin?.end(); }
  console.log(`Deployment designation evidence: ${evidencePath}`);
});

for (const control of controls) {
  test(`${control.migration}: revoked original designation cannot assign ${control.permission}`, async () => {
    phase = control.installed;
    await start();
    // Select the immutable original episode, not an arbitrary current grant.
    const original = (await access!.query<{ id: string }>(`SELECT principal_grant_id AS id
      FROM access.platform_grant_episode WHERE permission = 'platform:grant'
        AND principal_grant_id IS NOT NULL ORDER BY created_at,id LIMIT 1`)).rows[0]!;
    const designation = (await inventory()).find(grant => grant.id === original.id);
    if (!designation?.recipient.principalId) throw new Error('Missing original deployment designation');
    expect(designation.active).toBe(true);
    expect(designation.issuerSubject).toBe(sessions!.operator.actingSubject!);
    const principalId = designation.recipient.principalId;
    const scopeId = control.scope();

    const liveId = randomUUID();
    const live = await answer<{ grant: Grant }>(change({ action: 'create', grantId: liveId,
      permission: control.permission, scopeId, recipient: { principalId }, validUntil: null }));
    expect(live.grant).toMatchObject({ id: liveId, permission: control.permission, scopeId, active: true });
    expect((await inventory()).find(grant => grant.id === liveId)).toEqual(live.grant);
    await answer(change({ action: 'revoke', grantId: liveId,
      expectedObjectGeneration: live.grant.generation }));

    const ordinaryId = randomUUID();
    await answer(change({ action: 'create', grantId: ordinaryId, permission: 'platform:grant',
      scopeId: 'platform:access', recipient: { principalId }, validUntil: null }));
    const revoked = await answer<{ grant: Grant }>(change({ action: 'revoke', grantId: designation.id,
      expectedObjectGeneration: designation.generation }));
    expect(revoked.grant.active).toBe(false);

    // Ordinary governance remains usable after the original designation ends.
    const ordinaryControlId = randomUUID();
    const ordinary = await answer<{ grant: Grant }>(change({ action: 'create', grantId: ordinaryControlId,
      permission: 'platform:use:platform-admin', scopeId: 'platform:access',
      recipient: { principalId }, validUntil: null }));
    expect(ordinary.grant).toMatchObject({ id: ordinaryControlId, active: true });
    expect((await inventory()).find(grant => grant.id === ordinaryId)?.active).toBe(true);

    const deniedId = randomUUID();
    const response = await change({ action: 'create', grantId: deniedId,
      permission: control.permission, scopeId, recipient: { principalId }, validUntil: null });
    const raw = await response.text();
    const persisted = (await inventory()).filter(grant => grant.id === deniedId);
    evidence({ permission: control.permission, scopeId, deniedId, status: response.status,
      response: raw, persisted });
    expect(persisted, `Revoked designation created a privileged assignment: ${raw}`).toEqual([]);
    expect(response.status, raw).toBe(403);
    expect(JSON.parse(raw)).toMatchObject({ code: 'grant_denied' });
    expect((await access!.query<{ active: boolean }>(`SELECT active FROM access.permission_grant
      WHERE assigned_by_principal = $1 AND scope_id = 'work:publish:*'
        AND action = 'access.grant.assign.work.publish'`, [principalId])).rows).toEqual([{ active: false }]);
  }, 180_000);
}

test('upgrade clears pre-migration revoked designation ceilings and preserves unrelated authority', async () => {
  phase = 'revoked-designation-upgrade';
  await start();
  const original = (await access!.query<{ id: string }>(`SELECT principal_grant_id AS id
    FROM access.platform_grant_episode WHERE permission = 'platform:grant'
      AND principal_grant_id IS NOT NULL ORDER BY created_at,id LIMIT 1`)).rows[0]!;
  const designation = (await inventory()).find(grant => grant.id === original.id);
  if (!designation?.recipient.principalId) throw new Error('Missing original deployment designation');
  expect(designation.active).toBe(true);
  const principalId = designation.recipient.principalId;
  const ceilings = (await access!.query<{ id: string; action: string; active: boolean }>(
    `SELECT id,action,active FROM access.permission_grant WHERE assigned_by_principal = $1
      AND (scope_id,action) IN (
        ('work:publish:*','access.grant.assign.work.publish'),
        ('governance:platform','access.grant.assign.governance.rule.publish'),
        ('realm:attach:*','access.grant.assign.realm.attach')) ORDER BY action`, [principalId])).rows;
  expect(ceilings.map(row => [row.action, row.active])).toEqual([
    ['access.grant.assign.governance.rule.publish', true],
    ['access.grant.assign.realm.attach', true],
    ['access.grant.assign.work.publish', true],
  ]);

  const repair = readFileSync(repairPath, 'utf8');
  const liveRows = await permissionRows();
  await access!.query(repair);
  expect(await permissionRows()).toEqual(liveRows);
  const liveGrants: Grant[] = [];
  for (const control of controls) {
    const live = await answer<{ grant: Grant }>(change({ action: 'create', grantId: randomUUID(),
      permission: control.permission, scopeId: control.scope(), recipient: { principalId }, validUntil: null }));
    expect(live.grant.active).toBe(true);
    liveGrants.push(live.grant);
  }
  const ordinaryId = randomUUID();
  await answer(change({ action: 'create', grantId: ordinaryId, permission: 'platform:grant',
    scopeId: 'platform:access', recipient: { principalId }, validUntil: null }));

  // Reinstall the exact historical function, keeping its existing trigger, so
  // the public revocation leaves the stale state that the upgrade must repair.
  const legacyPath = 'services/main/migrations/access/2068_source_publication_mandates.sql';
  const legacy = readFileSync(legacyPath, 'utf8');
  const legacyFunction = legacy.match(/CREATE FUNCTION access\.revoke_source_publication_assignment_ceiling\(\)[\s\S]*?END \$\$;/)?.[0];
  if (!legacyFunction) throw new Error('Missing historical revocation function');
  await access!.query(legacyFunction.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  evidence({ migration: legacyPath, sha256: createHash('sha256').update(legacy).digest('hex'),
    source: legacyFunction, installed: await installedRevocation() });
  const revoked = await answer<{ grant: Grant }>(change({ action: 'revoke', grantId: designation.id,
    expectedObjectGeneration: designation.generation }));
  expect(revoked.grant.active).toBe(false);
  const before = await permissionRows();
  const staleIds = ceilings.filter(row => row.action !== 'access.grant.assign.work.publish').map(row => row.id);
  expect(before.filter(row => staleIds.includes(row.id)).map(row => row.value.active)).toEqual([true, true]);
  expect(before.find(row => row.id === ceilings.find(ceiling => ceiling.action === 'access.grant.assign.work.publish')!.id)!.value.active).toBe(false);

  await access!.query(repair);
  const after = await permissionRows();
  expect(after.filter(row => staleIds.includes(row.id)).map(row => row.value.active)).toEqual([false, false]);
  const unrelated = before.filter(row => !staleIds.includes(row.id));
  expect(unrelated.length).toBeGreaterThan(0);
  expect(after.filter(row => !staleIds.includes(row.id))).toEqual(unrelated);
  evidence({ installed: await installedRevocation(), staleIds, before, after });

  const ordinary = await answer<{ grant: Grant }>(change({ action: 'create', grantId: randomUUID(),
    permission: 'platform:use:platform-admin', scopeId: 'platform:access',
    recipient: { principalId }, validUntil: null }));
  expect(ordinary.grant.active).toBe(true);
  const resource = await answer<{ grant: Grant }>(change({ action: 'create', grantId: randomUUID(),
    permission: 'platform:resource:work.create', scopeId: 'work:create:root',
    recipient: { principalId }, validUntil: null }));
  expect(resource.grant.active).toBe(true);
  const retained = await inventory();
  expect(retained.find(grant => grant.id === ordinaryId)?.active).toBe(true);
  for (const live of liveGrants) expect(retained.find(grant => grant.id === live.id)).toEqual(live);
  for (const control of controls) {
    const deniedId = randomUUID();
    const response = await change({ action: 'create', grantId: deniedId,
      permission: control.permission, scopeId: control.scope(), recipient: { principalId }, validUntil: null });
    const raw = await response.text();
    const persisted = (await inventory()).filter(grant => grant.id === deniedId);
    evidence({ permission: control.permission, deniedId, status: response.status, response: raw, persisted });
    expect(persisted).toEqual([]);
    expect(response.status, raw).toBe(403);
    expect(JSON.parse(raw)).toMatchObject({ code: 'grant_denied' });
  }
}, 180_000);
