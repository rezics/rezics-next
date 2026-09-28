import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import { png, sha, startMediaStack } from './media-support.ts';
import { REALM_MEDIA_COST } from '../../../services/main/src/modules/content-publication/realm-media.ts';

test('WIKI05: Realm serving text and search keep its accepted draft while the source edits', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `wiki-realm-selection-${randomUUID()}`),
    'openid work:create work:edit work:read space:create realm:adopt semantic:read');
  try {
    await f.grant('space:create:root', 'space.create');
    const space = await f.json<{ space: string; realm: string }>(await f.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Accepted wiki', capabilities: ['realm'],
      actingSubject: f.actor }), 201);
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', { language: 'en',
      profile: 'metadata-only-v1', title: 'Accepted source', actingSubject: f.actor }), 201);
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const oldTerm = `acceptedwiki${randomUUID().replaceAll('-', '')}`;
    const nextTerm = `editedwiki${randomUUID().replaceAll('-', '')}`;
    const oldBody = `${oldTerm} old accepted body`;
    const nextBody = `${nextTerm} changed private draft`;
    const draft = await f.json<{ contribution: string; draftRevision: string }>(await f.call('POST',
      '/v1/contributions', { profile: 'text-contribution-v1', work: work.work,
        language: 'en', body: oldBody, actingSubject: f.actor }), 201);
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:edit:${draft.contribution}`, 'contribution.edit');
    const published = await f.json<{ publicationDecision: string; selectedDraft: string }>(
      await f.call('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
        contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: f.actor }), 201);
    await f.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
    const adopted = await f.json<{ selection: string; selectedDraft: string }>(await f.call('POST',
      '/v1/publication-selections', { profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: space.realm }, work: work.work,
        mainVersion: work.mainVersion, contribution: draft.contribution,
        publicationDecision: published.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
        actingSubject: f.actor }), 201);
    expect(adopted.selectedDraft).toBe(draft.draftRevision);
    const selectionPath = `/v1/realms/${shortId(space.realm)}/main-versions/${shortId(work.mainVersion)}/selection`;
    const before = await f.json<{ body: string; selection: string }>(await f.call('GET', selectionPath), 200);
    expect(before).toMatchObject({ body: oldBody, selection: adopted.selection });
    const edited = await f.json<{ draftRevision: string }>(await f.call('POST',
      '/v1/contribution-edits', { profile: 'text-contribution-v1',
        contribution: draft.contribution, expectedHead: draft.draftRevision,
        body: nextBody, actingSubject: f.actor }), 200);
    expect(edited.draftRevision).not.toBe(draft.draftRevision);
    const after = await f.json<{ body: string; selection: string; selectedDraft: string }>(
      await f.call('GET', selectionPath), 200);
    expect(after).toMatchObject({ body: oldBody, selection: adopted.selection,
      selectedDraft: draft.draftRevision });
    const search = async (phrase: string) => f.json<{ total: number;
      results: Array<{ work: string; revision: string; selection: string }> }>(await f.call('POST',
        '/v1/queries', { profile: 'public-realm-phrase-v1',
          context: { kind: 'realm-local', id: space.realm }, phrase, language: 'en' }), 200);
    const oldResults = await search(oldTerm);
    expect(oldResults.total).toBe(1);
    expect(oldResults.results[0]).toMatchObject({ work: work.work,
      revision: draft.draftRevision, selection: adopted.selection });
    expect((await search(nextTerm)).total).toBe(0);
    expect((await f.call('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: space.realm },
      work: work.work, mainVersion: work.mainVersion, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: f.actor })).status).toBe(409);
  } finally { await f.close(); }
}, 180_000);

test('WIKI05: Realm media serves its accepted exact set after the source publishes a newer set', async () => {
  const stack = await startMediaStack('wiki-realm-media');
  try {
    const author = await stack.member('wiki-media-author');
    const stranger = await stack.member('wiki-media-stranger');
    const work = await stack.publicWork(author.actor);
    const text = work.variants[0]!;
    await author.grant('space:create:root', 'space.create');
    const spaceResponse = await author.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Media wiki', capabilities: ['realm'],
      actingSubject: author.actor });
    expect(spaceResponse.status).toBe(201);
    const space = await spaceResponse.json() as { realm: string };
    await author.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
    await author.grant(`content:draft:${work.work}`, 'content.draft');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await author.grant(`content:publish:${work.work}`, 'content.publish');
    const oldBytes = png(32, 24);
    const nextBytes = png(40, 30);
    const oldAsset = await author.upload(oldBytes);
    const nextAsset = await author.upload(nextBytes);
    const save = async (asset: string, expectedHead: string | null) => {
      const response = await author.send('POST', '/v1/media/publications', {
        profile: 'media-set-v1', resourceId: work.work, variantId, expectedHead,
        assets: [asset], actingSubject: author.actor });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ revisionId: string; byteDigest: string;
        sourcePosition: { dataEpoch: string }; body: { items: Array<{ use: string }> } }>;
    };
    const publish = async (saved: Awaited<ReturnType<typeof save>>, expectedPublicationHead: string | null) => {
      const response = await author.send('POST', '/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: `wiki-media-${randomUUID()}`,
        revisionId: saved.revisionId, expectedDigest: saved.byteDigest,
        expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: work.work,
        variantId, expectedPublicationHead, actingSubject: author.actor });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ decision: string }>;
    };
    const oldSet = await save(oldAsset.asset, null);
    const oldPublished = await publish(oldSet, null);
    const intent = { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: space.realm }, work: work.work,
      mainVersion: work.mainVersion, contribution: text.contribution,
      publicationDecision: text.decision,
      media: { variantId, publicationDecision: oldPublished.decision },
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
      actingSubject: author.actor };
    expect((await stranger.send('POST', '/v1/publication-selections',
      { ...intent, actingSubject: stranger.actor })).status).toBe(403);
    const key = `wiki-media-select-${randomUUID()}`;
    const graph = stack.env.fuseki;
    let lostGraphAck = false;
    stack.env.fuseki = new Proxy(graph, { get(target, property) {
      if (property === 'commandWithReceipt') return async (...args: Parameters<typeof target.commandWithReceipt>) => {
        const result = await target.commandWithReceipt(...args);
        if (!lostGraphAck && args[0].update.includes('rv:mediaVariant')) {
          lostGraphAck = true;
          throw new Error('lost Realm media selection acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof graph;
    const acceptedResponse = await author.send('POST', '/v1/publication-selections', intent, key);
    stack.env.fuseki = graph;
    expect(acceptedResponse.status).toBe(201);
    expect(lostGraphAck).toBe(true);
    const accepted = await acceptedResponse.json() as { selection: string; replayed: boolean };
    expect(accepted.replayed).toBe(false);
    const replay = await author.send('POST', '/v1/publication-selections', intent, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ selection: accepted.selection, replayed: true });
    expect((await author.send('POST', '/v1/publication-selections', intent)).status).toBe(409);
    const selectionPath = `/v1/realms/${shortId(space.realm)}`
      + `/main-versions/${shortId(work.mainVersion)}/selection`;
    const selectedResponse = await author.read(selectionPath);
    expect(selectedResponse.status).toBe(200);
    const selected = await selectedResponse.json() as { selection: string; reason: string;
      media: { revisionId: string; publicationDecision: string;
        items: Array<{ use: string; url: string }> } };
    expect(selected).toMatchObject({ selection: accepted.selection, reason: 'realm-adoption',
      media: { revisionId: oldSet.revisionId,
        publicationDecision: oldPublished.decision,
        items: [{ use: oldSet.body.items[0]!.use }] } });
    const oldUrl = selected.media.items[0]!.url;
    const beforeDelivery = stack.fuseki.queries;
    const delivered = await author.read(oldUrl);
    expect(delivered.status).toBe(200);
    expect(sha(new Uint8Array(await delivered.arrayBuffer()))).toBe(sha(oldBytes));
    expect(stack.fuseki.queries - beforeDelivery).toBeLessThanOrEqual(
      REALM_MEDIA_COST.servingGraphReads);

    const nextSet = await save(nextAsset.asset, oldSet.revisionId);
    const nextPublished = await publish(nextSet, oldPublished.decision);
    expect(nextPublished.decision).not.toBe(oldPublished.decision);
    const afterResponse = await author.read(selectionPath);
    expect(afterResponse.status).toBe(200);
    const after = await afterResponse.json() as typeof selected;
    expect(after.media).toEqual(selected.media);
    expect(sha(new Uint8Array(await (await author.read(oldUrl)).arrayBuffer()))).toBe(sha(oldBytes));
    const unacceptedUrl = oldUrl.replace(oldSet.body.items[0]!.use, nextSet.body.items[0]!.use);
    expect((await author.read(unacceptedUrl)).status).toBe(404);
    expect(JSON.stringify(after)).not.toContain(nextSet.body.items[0]!.use);
    const replacement = await author.send('POST', '/v1/publication-selections', {
      ...intent, media: { variantId, publicationDecision: nextPublished.decision },
      expectedSelectionHead: accepted.selection });
    expect(replacement.status).toBe(201);
    const newer = await (await author.read(selectionPath)).json() as typeof selected;
    expect(newer.media).toMatchObject({ revisionId: nextSet.revisionId,
      publicationDecision: nextPublished.decision,
      items: [{ use: nextSet.body.items[0]!.use }] });
    expect((await author.read(oldUrl)).status).toBe(404);
    const nextUrl = newer.media.items[0]!.url;
    expect(sha(new Uint8Array(await (await author.read(nextUrl)).arrayBuffer()))).toBe(sha(nextBytes));
    const hidden = await author.send('POST', `/v1/media/assets/${nextAsset.asset}/state`, {
      profile: 'media-asset-state-v1', expectedState: nextAsset.stateHead,
      disclosure: 'private', lifecycle: 'active', actingSubject: author.actor });
    expect(hidden.status).toBe(201);
    expect((await author.read(nextUrl)).status).toBe(404);
  } finally { await stack.stop(); }
}, 180_000);
