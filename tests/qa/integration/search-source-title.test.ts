import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceAuthorNameStore } from '../../../services/main/src/modules/source/author-name.ts';
import { adoptAuthorCredit } from '../../../services/main/src/modules/work/author-credit.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { assertCommandRace } from '../support/command-race.ts';

async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text);
}

test('title, localized title, tagline and retained author facts match current public Works with title-first ranking and CJK typeahead', async () => {
  const stack = await startMediaStack('search-source-title');
  try {
    const actor = await stack.member('writer');
    const intake = new SourceIntakeStore(stack.contentPool);
    let requests = 0, revision = 1, displayName: string | undefined = 'Jane Austen';
    intake.reserveOpenLibrarySlot = async () => {};
    const names = new SourceAuthorNameStore(stack.contentPool, intake, (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://openlibrary.org/authors/OL1A.json');
      requests++;
      return Response.json({ key: '/authors/OL1A', type: { key: '/type/author' }, revision, name: displayName });
    }) as typeof fetch);
    const discovery = new DiscoveryProjection(stack.accessPool);
    await actor.grant('work:create:root', 'work.create');
    const deps = { actingContexts: new AccessActingContexts(stack.accessPool), environment: stack.env, access: stack.access, sourceIntake: intake,
      sourceAuthorNames: names, sourceAdoptions: stack.composition.dependencies.sourceAdoptions,
      templateSeek: stack.templateSeek, discovery, judgments: new AccessJudgments(stack.accessPool),
      account: { verify: async (request: Request, scopes: readonly string[]) => {
        if (request.headers.get('authorization') === 'Bearer owner'
          || (request.headers.get('authorization') === 'Bearer reader' && scopes[0] === 'source:read')) return actor.principal;
        throw new AccountAssertionDenied('Denied source scope');
      } } };
    const app = createMainApp(stack.fuseki, deps);
    const call = (path: string, body?: unknown, token?: string, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const search = (phrase: string, paged = true) => call(`/v1/queries${paged ? '/page' : ''}`, {
      profile: paged ? 'public-main-phrase-page-v1' : 'public-main-phrase-v1', phrase,
      language: null, ...(paged ? { pageSize: 20 } : {}) }).then(response => json(response));
    const suggest = (prefix: string) => call(`/v1/search/typeahead?prefix=${encodeURIComponent(prefix)}`).then(response => json(response));
    const title = await stack.publicWork(actor.actor, ['en'], 'Pride and Prejudice');
    const bun = await stack.publicWork(actor.actor, ['en'], 'Bun runtime');
    const bodyOnly = await stack.privateWork(actor.actor, 'Other book');
    const body = await stack.contribution(bodyOnly.work, actor.actor, 'en', 'Pride '.repeat(20));
    const input = { context: { kind: 'main-version-default' as const, id: bodyOnly.mainVersion },
      work: bodyOnly.work, contribution: body.contribution, publicationDecision: body.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor.actor };
    await selectMainDefault(stack.env, stack.admission(actor.actor, `publication:select:${bodyOnly.mainVersion}`,
      'publication.select', mainSelectionDigest(input)), input);
    const hidden = await stack.privateWork(actor.actor, 'Pride private secret');
    await stack.contribution(hidden.work, actor.actor, 'en', 'Pride private body');
    await actor.grant(`work:edit:${title.work}`, 'work.edit');
    const state = { kind: 'header', originalTitle: { value: '西游記原題', language: 'ja' },
      localized: [{ language: 'zh', title: '西游记', description: 'DescriptionOnlyNeedle', mainVersionLabel: null,
        tagline: '寻找齐天大圣的故事' }, { language: 'en', title: 'Pride and Prejudice',
        description: null, mainVersionLabel: null, tagline: 'A social comedy' }] };
    const saved = await json(await actor.send('PUT', `/v1/works/${title.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', state, expectedHead: null, actingSubject: actor.actor }));
    const result = await search('pride');
    expect(result.results.map((row: any) => row.work)).toEqual([title.work, bodyOnly.work]);
    expect(result.results[0]).toMatchObject({ matchedField: 'title', title: { value: 'Pride and Prejudice' } });
    expect((await search('Bun')).results.map((row: any) => row.work)).toEqual([bun.work]);
    expect((await search('西游')).results).toMatchObject([{ work: title.work, matchedField: 'title' }]);
    expect((await search('大圣')).results).toMatchObject([{ work: title.work, matchedField: 'tagline' }]);
    expect((await search('DescriptionOnlyNeedle')).total).toBe(0);
    expect((await suggest('pr')).items).toMatchObject([{ work: title.work, matchedField: 'title' }]);
    expect((await suggest('西')).items).toMatchObject([{ work: title.work, matchedField: 'title' }]);
    expect((await suggest('preju')).items).toMatchObject([{ work: title.work }]);
    expect((await suggest('ride')).items).toEqual([]);
    expect((await suggest('大圣')).items).toEqual([]);

    const credit = `https://rezics.com/id/${randomUUID()}`;
    const head = await json(await call(`/v1/works/${title.work.slice(-36)}`));
    // The credits read uses this app's template directory. A raw insert never
    // updates that directory, so the credit is adopted and the directory rebuilt.
    await adoptAuthorCredit(stack.env, deps.account, stack.access, new Request('http://main.local/credits', {
      headers: { authorization: 'Bearer owner' },
    }), {
      work: title.work, credit, revision: `https://rezics.com/id/${randomUUID()}`,
      expectedHead: head.revision, sourceKey: '/authors/OL1A', sourceRoleKey: null, nativeOrdinal: 0,
      actingSubject: actor.actor,
    }, `https://rezics.com/id/${randomUUID()}`, randomUUID());
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const path = '/v1/sources/open-library/authors/OL1A/name';
    const refresh = { action: 'refresh', expectedRevision: null };
    expect((await call(path, refresh, 'reader')).status).toBe(401);
    expect(requests).toBe(0);
    const key = randomUUID();
    const first = await json(await call(path, refresh, 'owner', key));
    expect(first.name).toMatchObject({ displayName: 'Jane Austen', nameSource: { basis: 'facts', field: '/name',
      url: 'https://openlibrary.org/authors/OL1A.json', sourceRevision: 'open-library-revision:1' } });
    expect((await json(await call(path, refresh, 'owner', key))).replayed).toBe(true);
    expect(requests).toBe(1);
    expect((await json(await call(`/v1/works/${title.work.slice(-36)}/credits`))).items)
      .toMatchObject([{ id: credit, displayName: 'Jane Austen', nameSource: first.name.nameSource }]);
    expect((await search('Jane')).results).toMatchObject([{ work: title.work, matchedField: 'credit',
      primaryCredits: [{ displayName: 'Jane Austen' }] }]);
    expect((await suggest('aus')).items).toMatchObject([{ work: title.work, matchedText: 'Jane Austen' }]);
    const unpaged = await search('Jane', false);
    expect(unpaged).toMatchObject({ complete: true, total: 1, cardWindow: { hydrated: 1, next: null } });
    expect(unpaged.results[0]).toMatchObject({ cover: { kind: 'fallback' }, primaryCredits: [{ displayName: 'Jane Austen' }],
      rating: null, tagline: { value: 'A social comedy' }, completionStatus: null });

    await actor.grant(MANAGE_SCOPE, MANAGE_ACTION);
    let build = await json(await call('/v1/discovery/generation-builds', { profile: 'discovery-generation-build-v1',
      actingSubject: actor.actor, basis: { scope: 'global', realm: null, context: null } }, 'owner'));
    for (let i = 0; !build.complete && i < 10; i++) build = await json(await call(
      `/v1/discovery/generations/${build.generation}/advance`, { actingSubject: actor.actor,
        expectedCheckpoint: build.checkpoint }, 'owner'));
    expect(build.complete).toBe(true);
    await json(await call('/v1/discovery/generation-activations', { profile: 'discovery-generation-activation-v1',
      actingSubject: actor.actor, generation: build.generation, expectedHeadRevision: null }, 'owner'));
    expect((await json(await call('/v1/works'))).items.find((row: any) => row.id === title.work).primaryCredits)
      .toMatchObject([{ displayName: 'Jane Austen' }]);
    revision++;
    displayName = '珍·奥斯汀';
    const updated = await json(await call(path, { action: 'refresh', expectedRevision: first.revision }, 'owner'));
    expect((await search('Jane')).total).toBe(0);
    expect((await suggest('珍')).items).toMatchObject([{ work: title.work, matchedText: '珍·奥斯汀' }]);
    // Discovery does not need a projection rebuild to refresh a source fact.
    expect((await json(await call('/v1/works'))).items.find((row: any) => row.id === title.work).primaryCredits)
      .toMatchObject([{ displayName: '珍·奥斯汀' }]);
    expect((await call(path, { action: 'remove', expectedRevision: first.revision, reason: 'stale' }, 'owner')).status).toBe(409);
    const competingCommands = ['one', 'two'].map((reason) =>
      call.bind(
        null,
        path,
        {
          action: 'remove',
          expectedRevision: updated.revision,
          reason,
        },
        'owner',
        randomUUID(),
      ),
    );
    await assertCommandRace(
      await Promise.all(competingCommands.map((send) => send())),
      200,
      (index) => competingCommands[index]!(),
    );
    expect((await search('奥斯汀')).total).toBe(0);
    expect((await json(await call(`/v1/works/${title.work.slice(-36)}/credits`))).items)
      .toMatchObject([{ id: credit, displayName: null }]);
    expect((await json(await call('/v1/works'))).items.find((row: any) => row.id === title.work).primaryCredits)
      .toMatchObject([{ displayName: null }]);
    expect((await json(await call(path, undefined, 'reader'))).state).toBe('removed');
    await json(await actor.send('PUT', `/v1/works/${title.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', state: { kind: 'header', originalTitle: null, localized: [] },
      expectedHead: saved.revision, actingSubject: actor.actor }));
    expect((await search('西游')).total).toBe(0);
    expect((await search('大圣')).total).toBe(0);
  } finally { await stack.stop(); }
}, 120_000);
