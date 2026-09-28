import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

test('RECIPE04: two Realms independently adopt published Recipe variants of one Main Version', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `recipe-realms-${randomUUID()}`),
    'openid work:create work:edit work:read source:read space:create realm:adopt');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', { language: 'en',
      profile: 'metadata-only-v1', title: 'Realm recipe variants',
      semanticTypes: ['https://schema.org/Recipe'], actingSubject: f.actor,
    }), 201);
    await f.grant(`work:edit:${work.work}`, 'recipe.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    const structure = await f.json<{ structure: string }>(await f.call('POST', '/v1/recipes', {
      owner: work.work, mainVersion: work.mainVersion, actingSubject: f.actor,
    }, `recipe-${randomUUID()}`), 201);
    expect(structure.structure).toMatch(/^https:\/\/rezics\.com\/id\//);

    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const publish = async (body: string) => {
      const draft = await f.json<{ contribution: string; draftRevision: string }>(await f.call('POST',
        '/v1/contributions', { profile: 'text-contribution-v1', work: work.work,
          language: 'en', body, actingSubject: f.actor }, `recipe-draft-${randomUUID()}`), 201);
      await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
      const publication = await f.json<{ publicationDecision: string }>(await f.call('POST',
        '/v1/contribution-publications', { profile: 'text-publication-v1',
          contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
          expectedPublicationHead: null, rightsBasis: 'original-contribution',
          disclosure: 'public', actingSubject: f.actor }, `recipe-publish-${randomUUID()}`), 201);
      return { contribution: draft.contribution, publicationDecision: publication.publicationDecision, body };
    };
    const main = await publish('Recipe main version: bake at 180 C.');
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await f.json<{ selection: string }>(await f.call('POST',
      '/v1/publication-selections', { profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
        contribution: main.contribution, publicationDecision: main.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: f.actor },
      `recipe-main-${randomUUID()}`), 201);
    expect(selected.selection).toBeTruthy();

    await f.grant('space:create:root', 'space.create');
    const realms: string[] = [];
    for (const label of ['A', 'B']) {
      const created = await f.json<{ realm: string }>(await f.call('POST', '/v1/spaces', {
        profile: 'space-realm-v1', name: `Recipe Realm ${label} ${randomUUID()}`,
        capabilities: ['realm'], actingSubject: f.actor,
      }, `recipe-space-${randomUUID()}`), 201);
      realms.push(created.realm);
    }
    const variants = [await publish('Recipe A: steam for 10 minutes.'),
      await publish('Recipe B: roast for 20 minutes.')];
    for (const [index, realm] of realms.entries()) {
      const variant = variants[index]!;
      const intent = { profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: realm }, work: work.work,
        mainVersion: work.mainVersion, contribution: variant.contribution,
        publicationDecision: variant.publicationDecision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review', actingSubject: f.actor };
      await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
        [`publication:adopt:${realm}`]);
      expect((await f.call('POST', '/v1/publication-selections', intent,
        `recipe-realm-denied-${randomUUID()}`)).status).toBe(403);
      await f.grant(`publication:adopt:${realm}`, 'publication.adopt');
      const key = `recipe-realm-${randomUUID()}`;
      const adopted = await f.json<{ selection: string; replayed: boolean }>(await f.call('POST',
        '/v1/publication-selections', intent, key), 201);
      expect(adopted.replayed).toBe(false);
      expect(await f.json(await f.call('POST', '/v1/publication-selections', intent, key), 200))
        .toMatchObject({ selection: adopted.selection, replayed: true });
      expect((await f.call('POST', '/v1/publication-selections', intent,
        `recipe-realm-stale-${randomUUID()}`)).status).toBe(409);
    }
    const selection = async (realm: string) => f.json<{ mainVersion: string; realm: string;
      body: string; contribution: string }>(await f.call('GET',
      `/v1/realms/${shortId(realm)}/main-versions/${shortId(work.mainVersion)}/selection`), 200);
    const first = await selection(realms[0]!);
    const second = await selection(realms[1]!);
    expect(first).toMatchObject({ mainVersion: work.mainVersion, realm: realms[0],
      body: variants[0]!.body, contribution: variants[0]!.contribution });
    expect(second).toMatchObject({ mainVersion: work.mainVersion, realm: realms[1],
      body: variants[1]!.body, contribution: variants[1]!.contribution });
    expect(first.contribution).not.toBe(second.contribution);
  } finally { await f.close(); }
}, 180_000);
