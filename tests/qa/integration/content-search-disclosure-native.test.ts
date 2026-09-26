import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { DEFAULT_MEDIA_CONTEXT, type MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { InvalidPublicDisclosure, PUBLIC_DISCLOSURE_COST, PublicDisclosureUnavailable,
  disclosePublicSearchFields, matchPublicDisclosedPhrase }
  from '../../../services/main/src/modules/search-disclosure/public-fields.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { contextFixture, nativeId } from './context-fixture.ts';
import { png, startMediaStack } from './media-support.ts';

const short = (id: string) => id.split('/').at(-1)!;

test('SEARCH03/SEARCH11: public owner values exclude private Context selections and spoiler Statements before score and facets', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const visible = `visible${randomUUID().replaceAll('-', '')}`;
    const secret = `secret${randomUUID().replaceAll('-', '')}`;
    const realm = await f.realm('Search disclosure name');
    const visibleValueRealm = await f.realm(visible);
    const hiddenValueRealm = await f.realm(secret);
    const spaceFor = async (selectedRealm: string) => {
      const rows = (await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?space a rv:Space ;
          rv:realmCapability ${iri(selectedRealm)} ; rv:disclosure rv:Public . }
      }`)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      return rows[0]!.space!.value;
    };
    const space = await spaceFor(realm.realm);
    const visibleValue = await spaceFor(visibleValueRealm.realm);
    const hiddenValue = await spaceFor(hiddenValueRealm.realm);
    const hiddenWork = await f.work(`Hidden name ${randomUUID()}`);
    const target = nativeId();
    const relation = `${RV}searchDisclosureRelation`;
    await f.grant('context:create:root', 'context.create');
    const makeContext = async (disclosure: 'public' | 'private', label: string) => {
      const entry = (item: string) => ({ target: item, relation, state: 'defined' as const,
        definition: nativeId(), applicability: [] });
      const created = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
        '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure, base: null,
          entries: disclosure === 'public'
            ? [entry(target), entry(visibleValue), entry(hiddenValue)] : [entry(target), entry(visibleValue)],
          actingSubject: f.actorA }), 201);
      await f.grant(`context:change:${created.context}`, 'context.preference');
      await f.json(await f.call('POST', `/v1/contexts/${short(created.context)}/preferences`, {
        profile: 'context-preference-v1', expectedPreferenceHead: null,
        labels: [{ target, language: 'en', label }], actingSubject: f.actorA }), 201);
      return created;
    };
    const publicContext = await makeContext('public', visible);
    const privateContext = await makeContext('private', secret);
    await f.grant(`context:read:${privateContext.context}`, 'context.read');

    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    await f.globalAcceptance();
    await f.grant('classification:decide:global', 'statement.decide');
    const makeStatement = async (value: string, selected = publicContext) => {
      const written = await f.json<{ statement: string }>(await f.call('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: space,
        predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: value },
        applicability: [], interpretation: { kind: 'explicit',
          context: selected.context, semanticRevision: selected.semanticRevision }, evidence: [],
        actingSubject: f.actorA }), 201);
      await f.json(await f.call('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1', target: { kind: 'statement', statement: written.statement },
        acceptance: { kind: 'global' }, expectedDecisionHead: null,
        outcome: 'accepted', actingSubject: f.actorA }), 201);
      return written.statement;
    };
    const publicStatement = await makeStatement(visibleValue);
    const hiddenStatement = await makeStatement(hiddenValue);
    const privateMeaningStatement = await makeStatement(visibleValue, privateContext);
    // Seed the Access aggregate fixture with eight non-spoiler votes. Its real
    // protection projection keeps the other accepted Statement protected.
    await f.accessPool.query(`INSERT INTO access.judgment_aggregate
      (statement, context_key, spoiler_none) VALUES ($1, 'global', 8)`, [publicStatement]);
    const judgments = new AccessJudgments(f.accessPool);
    expect((await judgments.protectionCheck(publicStatement, { kind: 'global' }, null))
      .protection).toBe('show-all');
    expect((await judgments.protectionCheck(hiddenStatement, { kind: 'global' }, null))
      .protection).not.toBe('show-all');
    const baselineInput = { contexts: [publicContext.context], statements: [
      { statement: publicStatement, acceptance: { kind: 'global' as const } }],
    resources: [space], mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en' };
    const baseline = await disclosePublicSearchFields(f.env, undefined, judgments, baselineInput);
    const baselineVisible = matchPublicDisclosedPhrase(baseline, visible);
    expect(baselineVisible.total).toBe(2);
    expect(baselineVisible.facets).toEqual({ contexts: 1, statements: 1, names: 0 });
    await f.json(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object: target },
      selection: { context: privateContext.context,
        semanticRevision: privateContext.semanticRevision }, expectedRevision: null,
      actingSubject: f.actorA }), 201);
    const principal = { issuer: f.account.issuer, subject: f.account.a.id };
    expect((await f.selections.candidates(principal, [{ kind: 'object', object: target }]))[0]
      ?.context).toBe(privateContext.context);
    f.resetQueries();
    const expanded = await disclosePublicSearchFields(f.env, undefined, judgments, {
      ...baselineInput, contexts: [publicContext.context, privateContext.context],
      statements: [...baselineInput.statements,
        { statement: hiddenStatement, acceptance: { kind: 'global' } },
        { statement: privateMeaningStatement, acceptance: { kind: 'global' } }],
      resources: [space, hiddenWork.work!] });
    expect(f.queries()).toBeLessThanOrEqual(PUBLIC_DISCLOSURE_COST.graphQueries);
    expect(matchPublicDisclosedPhrase(expanded, visible)).toEqual(baselineVisible);
    expect(matchPublicDisclosedPhrase(expanded, secret))
      .toMatchObject({ total: 0, matches: [], facets: { contexts: 0, statements: 0, names: 0 } });
    expect(JSON.stringify(expanded)).not.toContain(secret);
    expect(JSON.stringify(expanded)).not.toContain(privateContext.context);
    expect(JSON.stringify(expanded)).not.toContain(hiddenStatement);
    expect(JSON.stringify(expanded)).not.toContain(privateMeaningStatement);
    expect(expanded.cost).toMatchObject({ contexts: 2, statements: 3,
      badgeChecks: 3, mediaBatches: 0 });
    expect(expanded.cost.summaryTargets).toBeLessThanOrEqual(PUBLIC_DISCLOSURE_COST.summaryTargets);
    const concurrently = await Promise.all(Array.from({ length: 2 }, () =>
      disclosePublicSearchFields(f.env, undefined, judgments, baselineInput)));
    expect(concurrently[0]!.fields).toEqual(concurrently[1]!.fields);
    f.resetQueries();
    const bounded = await disclosePublicSearchFields(f.env, undefined, judgments, {
      ...baselineInput,
      contexts: [publicContext.context, ...Array.from({ length: 7 }, nativeId)],
      statements: [baselineInput.statements[0]!, ...Array.from({ length: 15 },
        () => ({ statement: nativeId(), acceptance: { kind: 'global' as const } }))],
      resources: [space, ...Array.from({ length: 31 }, nativeId)] });
    expect(matchPublicDisclosedPhrase(bounded, visible)).toEqual(baselineVisible);
    expect(f.queries()).toBeLessThanOrEqual(PUBLIC_DISCLOSURE_COST.graphQueries);
    const recovery = await engageAccessRecoveryFence(f.accessPool);
    await expect(disclosePublicSearchFields(f.env, undefined, judgments, baselineInput))
      .rejects.toBeInstanceOf(PublicDisclosureUnavailable);
    await releaseAccessRecoveryFence(f.accessPool, recovery);
    expect(matchPublicDisclosedPhrase(await disclosePublicSearchFields(
      f.env, undefined, judgments, baselineInput), visible)).toEqual(baselineVisible);
    await expect(disclosePublicSearchFields(f.env, undefined, judgments, {
      ...baselineInput, resources: Array.from({ length: 33 }, nativeId) }))
      .rejects.toBeInstanceOf(InvalidPublicDisclosure);
    await expect(disclosePublicSearchFields(f.env, undefined, judgments, {
      ...baselineInput, statements: [...baselineInput.statements, baselineInput.statements[0]!] }))
      .rejects.toBeInstanceOf(InvalidPublicDisclosure);
    const oldEpoch = f.env.lineage.dataEpoch;
    try {
      f.env.lineage.dataEpoch = randomUUID();
      await expect(disclosePublicSearchFields(f.env, undefined, judgments, baselineInput))
        .rejects.toBeInstanceOf(PublicDisclosureUnavailable);
    } finally { f.env.lineage.dataEpoch = oldEpoch; }
    let badgeReads = 0;
    const moving = { protectionCheck: async (...args: Parameters<AccessJudgments['protectionCheck']>) => {
      badgeReads++;
      if (badgeReads === 2) await f.work('Concurrent search disclosure change');
      return judgments.protectionCheck(...args);
    } };
    await expect(disclosePublicSearchFields(f.env, undefined, moving, baselineInput))
      .rejects.toBeInstanceOf(PublicDisclosureUnavailable);
  } finally { await f.close(); }
}, 120_000);

test('SEARCH03/SEARCH11: hidden names and private avatars do not enter public search fields or counts', async () => {
  const stack = await startMediaStack('search-disclosure');
  try {
    const owner = await stack.member('disclosure-owner');
    const visible = `publicname${randomUUID().replaceAll('-', '')}`;
    const secret = `privatename${randomUUID().replaceAll('-', '')}`;
    const shown = await stack.publicWork(owner.actor, ['en'], visible);
    const hidden = await stack.privateWork(owner.actor, secret);
    await owner.grant(`media:avatar:${shown.work}`, 'media.avatar');
    await owner.grant(`media:avatar:${hidden.work}`, 'media.avatar');
    await owner.grant(`work:read:${hidden.work}`, 'work.read');
    const image = await owner.upload(png(128, 128), 'public');
    const choose = async (target: string, asset: string) => {
      const response = await owner.send('PUT', `/v1/resources/${short(target)}/avatar`, {
        profile: 'resource-avatar-selection-v1', expectedSelection: null,
        asset, actingSubject: owner.actor });
      expect(response.status).toBe(201);
      return (await response.json() as { selection: string }).selection;
    };
    const shownAvatar = await choose(shown.work, image.asset);
    const hiddenAvatar = await choose(hidden.work, image.asset);
    const restrictedTitles = async () => new Set<string>();
    const input = { contexts: [], statements: [], resources: [shown.work],
      mediaContext: DEFAULT_MEDIA_CONTEXT, language: 'en' };
    const before = await disclosePublicSearchFields(stack.env, stack.store, undefined,
      input, restrictedTitles);
    expect(before.fields).toMatchObject([{ kind: 'resource-name', owner: shown.work,
      avatar: { kind: 'image', selection: shownAvatar } }]);
    const after = await disclosePublicSearchFields(stack.env, stack.store, undefined,
      { ...input, resources: [shown.work, hidden.work] }, restrictedTitles);
    expect(after.fields).toEqual(before.fields);
    expect(matchPublicDisclosedPhrase(after, visible)).toEqual(matchPublicDisclosedPhrase(before, visible));
    expect(matchPublicDisclosedPhrase(after, secret)).toMatchObject({ total: 0, matches: [] });
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(JSON.stringify(after)).not.toContain(hiddenAvatar);
    expect(after.cost.mediaBatches).toBe(2);
    expect(after.cost.summaryTargets).toBe(2);
    let mediaReads = 0;
    const movingMedia = { avatarRows: async (...args: Parameters<MediaStore['avatarRows']>) => {
      const batch = await stack.store.avatarRows(...args);
      mediaReads++;
      if (mediaReads === 1) await owner.upload(png(128, 128), 'private');
      return batch;
    } } as MediaStore;
    await expect(disclosePublicSearchFields(stack.env, movingMedia, undefined,
      input, restrictedTitles)).rejects.toBeInstanceOf(PublicDisclosureUnavailable);
  } finally { await stack.stop(); }
}, 120_000);
