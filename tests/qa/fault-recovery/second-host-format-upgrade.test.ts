import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { readEnv, stackDirectory, type StackOptions } from '../../../scripts/dev/config.ts';
import { beginFormatUpgrade, installRelease, readFormatMarker } from '../../../scripts/dev/install.ts';
import { capturePrincipalHost, createStoppedRecoveryCut, qualifyManualFailover,
  removeRecoveryCut, restoreRecoveryCut, startRestoredHost, type RecoverySamples } from '../../../scripts/ops/failover.ts';

const root = resolve(import.meta.dir, '../../..');

function command(program: string, args: string[], timeout = 120_000): string {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-1200)}`);
  }
  return result.stdout.trim();
}

function options(suffix: string): StackOptions {
  const source = Bun.env.REZICS_QA_RUN_ID;
  if (!source) throw new Error('Run through isolated fault/recovery QA');
  return { profile: 'qa', persistent: true, runId: `ops-${source.slice(-12)}-${suffix}` };
}

function stack(action: 'stack:down' | 'stack:reset', target: StackOptions): void {
  command('corepack', ['yarn', action, '--profile', 'qa', '--run-id', target.runId!, '--persistent']);
}

function crashAndFence(target: StackOptions): void {
  const containers = command('docker', ['ps', '-q', '--filter',
    `label=com.docker.compose.project=rezics-qa-${target.runId}`]).split('\n').filter(Boolean);
  if (!containers.length) throw new Error('Principal has no live containers to fail');
  command('docker', ['kill', ...containers]);
  stack('stack:down', target);
}

async function seedOwners(source: StackOptions): Promise<RecoverySamples> {
  const apps = readEnv(join(stackDirectory(root, source), 'apps.env'));
  const accountPool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  try {
    const email = `ops02-${randomUUID()}@example.test`;
    const account = createAccountApp(createAccountAuth({ baseURL: apps.ACCOUNT_BASE_URL!, secret: apps.ACCOUNT_SECRET!,
      resource: apps.ACCOUNT_MAIN_RESOURCE!, pool: accountPool, operatorUserIds: new Set() }), accountPool);
    const signed = await account.handle(new Request(`${apps.ACCOUNT_BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: apps.ACCOUNT_BASE_URL! },
      body: JSON.stringify({ name: 'Recovery Sample', email, password: 'correct horse battery staple' }),
    }));
    expect(signed.status).toBe(200);
    const principalId = randomUUID();
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, apps.ACCOUNT_ISSUER, randomUUID()]);
    const body = { body: 'Exact OPS02 recovery sample' };
    const saved = await new ContentCore(contentPool).saveDraft({ operationId: randomUUID(),
      variant: { id: randomUUID(), resourceId: `urn:rezics:ops02:${randomUUID()}`,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'ops02-recovery-sample-v1', sourceRevision: null,
      provenance: { kind: 'ops02-recovery-sample-v1' }, serializedJson: JSON.stringify(body) });
    expect(saved.outcome).toBe('succeeded');
    if (!saved.revisionId) throw new Error('Content recovery sample has no revision');
    return { accountEmail: email, accessPrincipalId: principalId,
      contentRevision: saved.revisionId, contentBody: JSON.stringify(body) };
  } finally { await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]); }
}

test('OPS02/OPS04: principal crash requires manual second-host restore; failed format switch restores v1', async () => {
  const source = options('a');
  const second = options('b');
  const rollback = options('c');
  const id = `ops-${Bun.env.REZICS_QA_RUN_ID!.slice(-12)}`;
  try {
    await installRelease(source);
    const samples = await seedOwners(source);
    stack('stack:down', source);
    await createStoppedRecoveryCut(id, source, samples);
    await installRelease(source);
    const outage = capturePrincipalHost(source);
    await restoreRecoveryCut(id, second);
    await expect(qualifyManualFailover(outage, second)).rejects.toThrow('Principal is still live');
    await expect(startRestoredHost(outage, second)).rejects.toThrow('Principal is still live');
    crashAndFence(source);
    await startRestoredHost(outage, second);
    const promoted = await qualifyManualFailover(outage, second);
    expect(promoted.status).toBe('manual-route-ready');
    expect(promoted.cutId).toBe(id);
    expect(promoted.samples).toBe(3);

    const beforeUpgrade = capturePrincipalHost(second);
    beginFormatUpgrade(second, 2);
    expect(readFormatMarker(second)?.state).toBe('upgrade-pending');
    await expect(installRelease(second)).rejects.toThrow('unqualified or differs');
    crashAndFence(second);
    await restoreRecoveryCut(id, rollback);
    await startRestoredHost(beforeUpgrade, rollback);
    const restored = await qualifyManualFailover(beforeUpgrade, rollback);
    expect(restored.samples).toBe(promoted.samples);
    expect(readFormatMarker(rollback)?.formatVersion).toBe(1);
    expect(readFormatMarker(rollback)?.state).toBe('ready');
  } finally {
    for (const target of [source, second, rollback]) {
      try { stack('stack:reset', target); } catch { /* Retain primary failure and QA logs. */ }
    }
    try { removeRecoveryCut(id); } catch { /* Retain primary failure and QA logs. */ }
  }
}, 330_000);
