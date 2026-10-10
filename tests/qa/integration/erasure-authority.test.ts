import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { provisionFixtureAuthor } from '../fixtures/authored-work.ts';

test('a refused erasure is the same for an unknown id, another owner, and another kind', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = resolve('.temp', `erasure-authority-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid access:manage work:create work:edit work:read work:protect classification:define');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const content = new ContentCore(f.pool);
  const structureObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await structureObjects.initialize();
  await provisionFixtureAuthor(f.env, f.actor);
  const app = createMainApp(f.env.fuseki, { environment: f.env, catalogueIntake: f.catalogueIntake,
    access: f.access, account: f.account.verifier, content, contentAuthoring: content,
    mediaAccess: new MediaAccessBatchReader(f.accessPool, f.env.fuseki), structureObjects,
    platformAccess: new AccessExposure(f.accessPool),
    erasures: new ErasureService(relay, f.pool, f.accessPool) } satisfies MainWorkDependencies);
  const post = (token: string, resourceId: string, revisionId: string) => app.handle(new Request(
    'http://main.local/v1/erasures', { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ profile: 'content-revision-erasure-v1', actingSubject: f.actor, resourceId,
      revisionIds: [revisionId] }) }));
  const text = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());
  try {
    await f.grant('catalogue:verify:root', 'catalogue.verify');
    const work = async (title: string) => {
      const response = await app.handle(new Request('http://main.local/v1/works', { method: 'POST', headers: {
        authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify(await f.catalogueBody({
        profile: 'metadata-only-v1', language: 'en', title, semanticTypes: ['https://schema.org/Book'],
        actingSubject: f.actor })) }));
      if (response.status !== 201) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<{ work: string; mainVersion: string; workRevision: string }>;
    };
    const owned = await work('Authority owned');
    const other = await work('Authority other owner');
    await f.grant(`work:edit:${owned.work}`, 'work.edit');
    const releaseId = nativeId();
    const release = await app.handle(new Request(
      `http://main.local/v1/works/${shortId(owned.work)}/releases/${shortId(releaseId)}`, { method: 'PUT',
        headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, body: JSON.stringify({ profile: 'release-v1', expectedHead: null,
          actingSubject: f.actor, id: releaseId, kind: 'formal', status: 'official', contentLanguages: ['en'],
          isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
          title: { value: 'Authority release', language: 'en' }, editionStatement: null, publisher: 'Example',
          publicationYear: 2026, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null,
          evidence: null }) }));
    if (release.status !== 200) throw new Error(`${release.status}: ${await release.text()}`);
    const released = await release.json() as { revision: string };
    const uuidOf = (value: string) => value.slice('https://rezics.com/id/'.length);
    await f.grant(`erasure:${owned.work}`, 'erasure.request');
    const decoy = nativeId();
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`erasure:${decoy}`]);
    await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'erasure.request',now() + interval '1 hour')`,
    [randomUUID(), f.otherPrincipal, f.actor]);
    await f.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'erasure.request',now() + interval '1 hour')`,
    [randomUUID(), f.actor, `erasure:${decoy}`]);
    const unknown = randomUUID();
    const ownedRefusal = await text(await post(f.account.tokenA, owned.work, unknown));
    const otherOwner = await text(await post(f.account.tokenA, owned.work, uuidOf(other.workRevision)));
    const otherKind = await text(await post(f.account.tokenA, owned.work, uuidOf(released.revision)));
    const otherPrincipalUnknown = await text(await post(f.account.tokenB, decoy, unknown));
    const otherPrincipalRevision = await text(await post(f.account.tokenB, decoy, uuidOf(owned.workRevision)));
    const otherPrincipalKind = await text(await post(f.account.tokenB, decoy, uuidOf(released.revision)));
    expect(ownedRefusal).toBe(otherOwner);
    expect(ownedRefusal).toBe(otherKind);
    expect(ownedRefusal).toBe(otherPrincipalUnknown);
    expect(ownedRefusal).toBe(otherPrincipalRevision);
    expect(ownedRefusal).toBe(otherPrincipalKind);
    expect(ownedRefusal).toContain('"status":400');
    expect(ownedRefusal).not.toContain(owned.workRevision);
    expect(ownedRefusal).not.toContain(other.workRevision);
    expect(ownedRefusal).not.toContain(released.revision);
    expect(ownedRefusal).not.toContain(f.account.a.id);
    expect(ownedRefusal).not.toContain(f.account.b.id);

    const erased = await post(f.account.tokenA, owned.work, uuidOf(owned.workRevision));
    expect(erased.status).toBe(200);
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`erasure:${owned.work}`]);
    await f.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'erasure.request',now() + interval '1 hour')`,
    [randomUUID(), f.actor, `erasure:${owned.work}`]);
    const ownerAgain = await post(f.account.tokenA, owned.work, uuidOf(owned.workRevision));
    const otherPrincipal = await post(f.account.tokenB, owned.work, uuidOf(owned.workRevision));
    const ownerBody = await text(ownerAgain);
    const otherBody = await text(otherPrincipal);
    expect(ownerAgain.status).toBe(409);
    expect(otherPrincipal.status).toBe(409);
    expect(ownerBody).toBe(otherBody);
    expect(ownerBody).not.toContain(f.account.a.id);
    expect(ownerBody).not.toContain(f.account.b.id);
    expect(ownerBody).not.toContain(f.principalId);
    expect(ownerBody).not.toContain(f.otherPrincipal);
  } finally {
    await relay.end();
    await f.pool.end();
    await f.accessPool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
