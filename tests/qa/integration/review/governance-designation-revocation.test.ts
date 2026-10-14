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
  }, 180_000);
}
