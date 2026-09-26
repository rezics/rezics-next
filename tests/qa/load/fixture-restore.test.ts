import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { IMPORT_SEQUENCE, fixtureCorpus, workAt } from '../../../scripts/fixture/corpus.ts';
import { compatibleFixture } from '../../../scripts/fixture/restore.ts';
import { workEnvironment } from '../../../scripts/fixture/smoke.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const shortId = (iri: string) => iri.slice('https://rezics.com/id/'.length);

function yarn(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root, encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) {
    throw new Error(`yarn ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').slice(-2000)}`);
  }
}

test('fixture: restored bulk background admits a fresh API Work and serves an exact imported Work', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated load tier');
  // Bulk-build once; later runs restore the retained compatible backup.
  let manifest = compatibleFixture('small');
  if (!manifest) {
    yarn(['fixture:build', '--profile', 'small'], 100_000);
    manifest = compatibleFixture('small');
  }
  if (!manifest) throw new Error('small fixture build left no compatible backup');
  const target = `fixture-l${randomUUID().slice(0, 8)}`;
  const stack = join(root, '.temp', 'stack', `rezics-qa-${target}`);
  const closers: Array<() => Promise<unknown>> = [];
  try {
    yarn(['fixture:restore', '--fixture', manifest.id, '--run-id', target], 60_000);
    const restored = JSON.parse(readFileSync(join(root, '.artifacts', 'fixture-restore', target, 'run.json'),
      'utf8')) as { failure?: string; elapsedMs: number; samples: number; appliedMigrations: string[] };
    expect(restored.failure).toBeUndefined();
    expect(restored.elapsedMs).toBeLessThan(600_000);
    expect(restored.samples).toBe(manifest.samples.length);

    const apps = readEnv(join(stack, 'apps.env'));
    const account = await ratingAccount(apps, 'openid work:create work:read');
    closers.push(() => account.close());
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    closers.push(() => accessPool.end(), () => contentPool.end());
    const env = workEnvironment(apps, manifest.lineage);
    const app = createMainApp(env.fuseki, { environment: env, account: account.verifier,
      access: new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY),
      content: new ContentCore(contentPool) });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(
      `http://main.local${path}`, { method, headers: { authorization: `Bearer ${account.tokenA}`,
        'idempotency-key': `fixture-${randomUUID()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));

    // Run-local cohort: a fresh principal and Agent. Imported Agents gain only a
    // fresh representation; their imported grants are the authority under test.
    const principal = randomUUID();
    const actor = `https://rezics.com/id/${randomUUID()}`;
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principal, account.issuer, account.a.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    const represent = (subject: string, action: string) => accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), principal, subject, action]);
    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    await represent(actor, 'work.create');
    await grant('work:create:root', 'work.create');

    const created = await call('POST', '/v1/works', { profile: 'metadata-only-v1',
      title: 'Fresh Work on a restored fixture', actingSubject: actor });
    expect(created.status).toBe(201);
    const fresh = await created.json() as { work: string; workRevision: string;
      sourcePosition: Record<string, string> };
    // The import holds position 0, so the first command after restore commits at 1.
    expect(fresh.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: manifest.lineage.dataEpoch,
      sequence: '1' });
    await represent(actor, 'work.read');
    await grant(`work:read:${fresh.work}`, 'work.read');
    const freshRead = await call('GET', `/v1/revisions/${shortId(fresh.workRevision)}?actingSubject=${
      encodeURIComponent(actor)}`);
    expect(freshRead.status).toBe(200);
    expect((await freshRead.json() as { title: string }).title).toBe('Fresh Work on a restored fixture');

    // Expected values are recomputed from the seed, independently of the manifest samples.
    const corpus = fixtureCorpus(manifest.profile, manifest.seed);
    const bulk = workAt(corpus, manifest.samples[1]!.index);
    const other = workAt(corpus, manifest.samples[0]!.index);
    expect(other.agent).not.toBe(bulk.agent);
    const read = (path: string) => call('GET', `${path}?actingSubject=${encodeURIComponent(bulk.agent)}`);
    const exactPath = `/v1/revisions/${shortId(bulk.workRevision)}`;
    expect((await read(exactPath)).status).toBe(404);
    await represent(bulk.agent, 'work.read');
    const position = { datasetId: 'product', dataEpoch: corpus.lineage.dataEpoch, sequence: IMPORT_SEQUENCE };
    const exact = await read(exactPath);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({ revision: bulk.workRevision, work: bulk.work,
      operation: corpus.importOperation, mainVersion: bulk.mainVersion, title: bulk.title,
      language: 'en', semanticTypes: bulk.semanticTypes, sourcePosition: position });
    const main = await read(`/v1/main-versions/${shortId(bulk.mainVersion)}/revisions/${shortId(bulk.mainRevision)}`);
    expect(main.status).toBe(200);
    expect(await main.json()).toEqual({ revision: bulk.mainRevision, mainVersion: bulk.mainVersion,
      work: bulk.work, operation: corpus.importOperation, hostingPolicy: 'metadata-only',
      defaultSelection: null, sourcePosition: position });
    const content = await read(`/v1/content-revisions/${bulk.contentRevision}`);
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({ reference: { resourceId: bulk.work,
      variantId: bulk.variant, revisionId: bulk.contentRevision }, body: { body: bulk.contentBody } });
    // Imported grants are per Agent and Work: another Agent's Work stays hidden.
    expect((await read(`/v1/revisions/${shortId(other.workRevision)}`)).status).toBe(404);
  } finally {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    spawnSync('corepack', ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', target, '--persistent'],
      { cwd: root, encoding: 'utf8', timeout: 120_000 });
    rmSync(stack, { recursive: true, force: true });
  }
}, 175_000);
