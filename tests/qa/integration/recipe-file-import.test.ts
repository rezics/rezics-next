import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { MAX_RECIPE_FILE_BYTES } from '../../../services/main/src/modules/recipe/file-intake.ts';

test('a Work editor retains and idempotently imports one bounded Recipe file', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-file-import-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works',
      await f.authoredBody({ language: 'en', profile: 'metadata-only-v1',
        title: 'Crème brûlée acceptance recipe', semanticTypes: ['https://schema.org/Recipe'],
        actingSubject: f.actor })), 201);
    const editGrant = await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const created = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'recipe-composition', work: work.work,
        mainVersion: work.mainVersion, actingSubject: f.actor }, `recipe-${randomUUID()}`), 201);
    const recipeWorkPath = `/v1/recipes/works/${shortId(work.work)}?actingSubject=${encodeURIComponent(f.actor)}`;
    const fileBytes = await Bun.file(new URL('./recipe-file-import.fixture.json', import.meta.url)).bytes();
    // This small Schema.org Recipe was written for this test and is not derived from an external recipe.
    const importPath = (expectedHead: string) => `/v1/recipes/${shortId(created.structure)}/file-imports`
      + `?actingSubject=${encodeURIComponent(f.actor)}&expectedHead=${encodeURIComponent(expectedHead)}`;
    const idempotencyKey = `recipe-file-${randomUUID()}`;
    const imported = await f.json<{ structure: string; revision: string; sourceObservation: string;
      replayed: boolean; receipts: string[] }>(await f.callRaw('POST', importPath(created.revision),
      fileBytes, 'application/ld+json; charset=utf-8', idempotencyKey), 201);
    expect(imported).toMatchObject({ structure: created.structure, replayed: false });
    expect(imported.receipts.length).toBeGreaterThan(0);

    const retained = await f.intake.read(f.principalId, shortId(imported.sourceObservation));
    expect(retained?.rawBytesBase64).toBe(Buffer.from(fileBytes).toString('base64'));
    expect(Buffer.from(retained!.rawBytesBase64!, 'base64')).toEqual(Buffer.from(fileBytes));
    expect(retained?.sourceRevision).toBe(created.revision);
    const record = await f.pool.query<{ provider: string; namespace: string; external_id: string }>(
      `SELECT provider, namespace, external_id FROM source.record WHERE id = $1::uuid`,
      [shortId(retained!.record)]);
    expect(record.rows[0]).toEqual({ provider: 'rezics', namespace: 'recipe-file', external_id: work.work });

    type RecipePage = { revision: string; occurrences: Array<{ role: string; sourceKey?: string }>;
      ingredients: Array<{ originalText: string; amount?: { numerator: number; denominator: number } }> };
    const firstPage = await f.json<RecipePage>(await f.call('GET', recipeWorkPath), 200);
    expect(firstPage.revision).toBe(imported.revision);
    expect(firstPage.occurrences.map(row => row.role).sort()).toEqual(['group', 'ingredient', 'step']);
    expect(firstPage.occurrences.every(row => row.sourceKey?.includes(imported.sourceObservation))).toBe(true);
    expect(firstPage.ingredients).toContainEqual(expect.objectContaining({
      originalText: '1 1/2 cups heavy cream', amount: { numerator: 3, denominator: 2 },
    }));

    const replay = await f.json<{ revision: string; sourceObservation: string; replayed: boolean }>(
      await f.callRaw('POST', importPath(created.revision), fileBytes,
        'application/ld+json; charset=utf-8', idempotencyKey), 200);
    const replayPage = await f.json<RecipePage>(await f.call('GET', recipeWorkPath), 200);
    expect(replay).toMatchObject({ revision: imported.revision,
      sourceObservation: imported.sourceObservation, replayed: true });
    expect(replayPage.occurrences).toEqual(firstPage.occurrences);
    expect(replayPage.ingredients).toEqual(firstPage.ingredients);

    const maxPrefix = '{"@type":"Recipe","recipeIngredient":["1 cup salt"],"name":"';
    const maxSuffix = '"}';
    const maxBytes = Buffer.from(`${maxPrefix}${'x'.repeat(MAX_RECIPE_FILE_BYTES
      - Buffer.byteLength(maxPrefix) - Buffer.byteLength(maxSuffix))}${maxSuffix}`);
    expect(maxBytes.byteLength).toBe(MAX_RECIPE_FILE_BYTES);
    const maxKey = `recipe-file-max-${randomUUID()}`;
    const maximum = await f.json<{ revision: string; sourceObservation: string }>(
      await f.callRaw('POST', importPath(imported.revision), maxBytes, 'application/json', maxKey), 201);
    const retainedMaximum = await f.intake.read(f.principalId, shortId(maximum.sourceObservation));
    expect(retainedMaximum?.byteLength).toBe(MAX_RECIPE_FILE_BYTES);
    expect(Buffer.from(retainedMaximum!.rawBytesBase64!, 'base64')).toEqual(maxBytes);

    const staleKey = `recipe-file-stale-${randomUUID()}`;
    expect((await f.callRaw('POST', importPath(created.revision), fileBytes,
      'application/ld+json', staleKey)).status).toBe(409);
    expect(await f.intake.replay(f.principalId, `recipe-file-import:${staleKey}`)).toBeNull();

    const oversizedKey = `recipe-file-large-${randomUUID()}`;
    const oversized = new Uint8Array(MAX_RECIPE_FILE_BYTES + 1).fill(0x20);
    expect((await f.callRaw('POST', importPath(maximum.revision), oversized,
      'application/json', oversizedKey)).status).toBe(413);
    expect(await f.intake.replay(f.principalId, `recipe-file-import:${oversizedKey}`)).toBeNull();

    const htmlKey = `recipe-file-html-${randomUUID()}`;
    expect((await f.callRaw('POST', importPath(maximum.revision), Buffer.from('<!doctype html><script/>'),
      'text/html', htmlKey)).status).toBe(422);
    expect(await f.intake.replay(f.principalId, `recipe-file-import:${htmlKey}`)).toBeNull();

    const noScopeKey = `recipe-file-no-scope-${randomUUID()}`;
    expect((await f.callRaw('POST', importPath(maximum.revision), fileBytes,
      'application/ld+json', noScopeKey, f.account.noScope)).status).toBe(401);
    expect(await f.intake.replay(f.principalId, `recipe-file-import:${noScopeKey}`)).toBeNull();

    await f.accessPool.query('DELETE FROM access.permission_grant WHERE id = $1', [editGrant]);
    const deniedKey = `recipe-file-denied-${randomUUID()}`;
    expect((await f.callRaw('POST', importPath(maximum.revision), fileBytes,
      'application/ld+json', deniedKey)).status).toBe(403);
    expect(await f.intake.replay(f.principalId, `recipe-file-import:${deniedKey}`)).toBeNull();

    const hiddenPath = importPath(maximum.revision);
    const hidden = await f.callRaw('POST', hiddenPath, fileBytes, 'application/ld+json',
      `recipe-file-hidden-${randomUUID()}`, f.account.tokenB);
    const absent = await f.callRaw('POST', `/v1/recipes/${randomUUID()}/file-imports`
      + `?actingSubject=${encodeURIComponent(f.actor)}&expectedHead=${encodeURIComponent(imported.revision)}`,
    fileBytes, 'application/ld+json', `recipe-file-absent-${randomUUID()}`, f.account.tokenB);
    const hiddenBody = await hidden.text();
    const absentBody = await absent.text();
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(hiddenBody).toBe(absentBody);
    expect(JSON.parse(hiddenBody)).toMatchObject({ code: 'recipe_unavailable' });
  } finally { await f.close(); }
}, 180_000);
