import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

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
    const work = await f.json<{ work: string; mainVersion: string }>(await f.call('POST', '/v1/works', {
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
