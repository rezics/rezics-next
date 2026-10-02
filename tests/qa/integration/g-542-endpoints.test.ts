import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack, seedHome } from './feed-read-support.ts';
import { claimFixture, fixtureReasons } from './g-565-decision-support.ts';
import { png } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GovernanceStore, GLOBAL_CONTEXT, type EvidenceTarget } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { readZoneModuleData } from '../../../services/main/src/modules/zone/publication.ts';
import type { ZoneConfiguration } from '../../../services/main/src/modules/zone/config-format.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { readFeed } from '../../../services/main/src/modules/feed/read.ts';
import { queryPublicMainPhrase } from '../../../services/main/src/modules/work/search-public.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';

const short = (ref: string) => ref.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;
type Target = Pick<EvidenceTarget, 'owner' | 'resource' | 'component' | 'revision'>;

test('G-542: endpoints enforce governance while returning rated content to unknown-age viewers', async () => {
  const home = await startHomeStack('g542endpointphrase');
  const { stack, author: member } = home;
  try {
    const seeded = await seedHome(home, 3), work = seeded.works[0]!;
    const principal = member.principal, actor = seeded.author;
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), member.principalId, actor, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    const scope = `governance:platform:${randomUUID()}`;
    for (const [name, action] of [[scope, 'governance.moderate'], [scope, 'governance.rule.publish'],
      ['governance:platform', 'governance.moderate'], [`work:read:${work.work}`, 'work.read'],
      [`release:seal:${work.mainVersion}`, 'release.seal']] as const) await grant(name, action);
    const rules = new GovernanceRules(stack.accessPool);
    const governance = new GovernanceStore(stack.accessPool, ownerEvidenceCapture({
      graph: { env: stack.env, canReadWork: async () => true },
      content: { core: stack.content, canRead: async (_p, _a, ids) => new Set(ids) },
      media: { pool: stack.contentPool, canReadWork: async () => true },
    }), ownerTargetHeads({ graph: stack.env, content: stack.contentPool }), rules,
    ownerModerationEffects(new ContentModeration(stack.contentPool), stack.env,
      { pool: stack.contentPool, core: stack.content }));
    const suitability = new SuitabilityStore(stack.accessPool, stack.access);
    const cursor = new ContentProjectionCursor(stack.contentPool), consumer = `g542-${randomUUID()}`;
    await cursor.initialize(consumer);
    const projectContent = async () => {
      for (let i = 0; i < 200; i++) if (!await relayContentProjectionOnce(stack.env, stack.content, cursor, consumer)) return;
      throw new Error('Content fixture projection exceeded its preparation budget');
    };
    await projectContent();
    const app = createMainApp(stack.fuseki, { ...home.deps, governance: { store: governance, rules }, suitability,
      accessPolicy: new AccessPolicyOwner(stack.accessPool),
      exports: new ExportStore(stack.contentPool), contentProjection: { content: stack.content, cursor, consumer } });
    const call = (method: string, path: string, body?: object, signed = false) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(signed ? { authorization: `Bearer ${member.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), 'idempotency-key': randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const text = await response.text();
      if (response.status !== status) throw new Error(`${response.status}: ${text}`);
      return JSON.parse(text) as T;
    };
    const heads = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head ?mainHead ?selection WHERE {
      GRAPH <urn:rezics:graph:current> { <${work.work}> rv:head ?head .
        <${work.mainVersion}> rv:head ?mainHead ; rv:selectionHead ?selection } }`)).results!.bindings[0]!;
    const release = await json<{ release: string; sourcePosition: { dataEpoch: string; sequence: string } }>(await call('POST', '/v1/fixed-releases', {
      profile: 'fixed-native-text-release-v1', work: work.work, mainVersion: work.mainVersion,
      expectedMainRevision: heads.mainHead!.value, expectedSelection: heads.selection!.value, actingSubject: actor,
    }, true), 201);
    await grant(`export:${release.release}`, 'export.create');
    await member.grant(`content:draft:${work.work}`, 'content.draft');
    await member.grant(`content:publish:${work.work}`, 'content.publish');
    await member.grant(`work:read:${work.work}`, 'work.read');
    const picture = await member.upload(png(12, 12), 'public');
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const media = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string };
      body: { items: { use: string }[] } }>(await call('POST', '/v1/media/publications', {
      profile: 'media-set-v1', resourceId: work.work, variantId: variant, expectedHead: null,
      assets: [picture.asset], actingSubject: member.actor,
    }, true), 201);
    await json(await call('POST', '/v1/content-publications', { profile: 'content-publication-v1',
      preparationId: `g542-${randomUUID()}`, revisionId: media.revisionId, expectedDigest: media.byteDigest,
      expectedContentEpoch: media.sourcePosition.dataEpoch, resourceId: work.work, variantId: variant,
      expectedPublicationHead: null, actingSubject: member.actor }, true), 201);
    await projectContent();
    const post = { id: seeded.discussion.reply, draft_head: seeded.discussion.revisionId, parent_reply: null };
    const reply = { id: seeded.response.reply, draft_head: seeded.response.revisionId, parent_reply: seeded.discussion.reply };
    const thread = `/v1/realms/${short(seeded.realm.realm)}/threads/${short(post.id)}`;
    const exportBody = { profile: 'export-create-v1', actingSubject: actor, useScope: 'excerpt',
      selection: { kind: 'fixed-release', reference: release.release, expectedPosition: {
        dataEpoch: release.sourcePosition.dataEpoch, sequence: release.sourcePosition.sequence } } };
    const channels = [
      { name: 'feed', read: (signed = false) => call('GET', '/v1/feed?sort=new&scope=all&limit=20'
        + (signed ? `&actingSubject=${encodeURIComponent(actor)}` : ''), undefined, signed),
        visible: (body: string) => body.includes(work.title) },
      { name: 'thread', read: (signed = false) => call('GET', thread
        + (signed ? `?actingSubject=${encodeURIComponent(actor)}` : ''), undefined, signed),
        visible: (body: string) => body.includes('A reviewed Home discussion') },
      { name: 'search', read: (signed = false) => call('POST', '/v1/queries', { profile: 'public-main-phrase-v1',
        phrase: 'g542endpointphrase', language: null }, signed), visible: (body: string) => body.includes(work.work) },
      { name: 'export', read: () => call('POST', '/v1/exports', exportBody, true),
        visible: (body: string) => !body.includes('disclosure_restricted') && body.includes(work.work) },
      { name: 'media', read: (signed = true) => call('GET', `/v1/media/uses/${media.body.items[0]!.use}`
        + (signed ? `?actingSubject=${encodeURIComponent(actor)}` : ''), undefined, signed),
        visible: (_body: string, status: number) => status === 200 },
    ];
    const check = async (visible: boolean) => {
      await projectContent();
      // Export currently advances Content's owner sequence without an outbox
      // event. Exercise its real endpoint last so that unrelated source gap
      // cannot prevent the search disclosure assertions.
      for (const channel of channels.filter(channel => channel.name !== 'export')) for (const signed of [false, true]) {
        const response = await channel.read(signed), body = await response.text();
        if (![200, 201, 404].includes(response.status)) {
          if (channel.name === 'feed') await workRead(home.deps, new Request('http://main.local/v1/feed'),
            { limit: 20 }, session => readFeed(session, { sort: 'new', scope: 'all' }));
          if (channel.name === 'search') await queryPublicMainPhrase(stack.env,
            { phrase: 'g542endpointphrase', language: null, contentProjection: { content: stack.content, cursor, consumer } });
          throw new Error(`${channel.name}: ${response.status}: ${body}`);
        }
        expect(channel.visible(body, response.status), `${channel.name}:${signed ? 'unknown-age' : 'anonymous'}`).toBe(visible);
      }
    };
    const rule = await rules.publish(principal, { ref: `urn:rezics:rule:${randomUUID()}`, scopeId: scope,
      actingSubject: actor, expectedRevision: null, document: { purpose: 'g542-real-endpoints' }, idempotencyKey: randomUUID() });
    const restrict = async (target: Target, context = GLOBAL_CONTEXT, locator: string | null = null) => {
      const report = await governance.submitReport(principal, { kind: 'content_report', actingSubject: actor,
        authority: { kind: 'platform', scopeId: scope }, context, target, disclosure: 'parties',
        reasonCode: 'policy', statement: 'Endpoint matrix', evidence: [{ ...target, locator }], idempotencyKey: randomUUID() });
      const input = { caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: actor,
        outcome: 'restrict' as const, evidenceDigest: report.evidenceDigest,
        rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
        targets: [{ ...target, locator, scopeKind: 'exact_revision' as const,
          expectedHead: target.owner === 'media' ? null : target.revision, effect: 'disclosure' as const }],
        reversesDecisionId: null, answersStepId: null, rationale: 'Endpoint matrix', disclosure: 'parties' as const,
        reasons: fixtureReasons, idempotencyKey: randomUUID() };
      await claimFixture(stack.accessPool, report.caseId, member.principalId, actor);
      const decision = await governance.decide(principal, input);
      expect(decision.operation.status, JSON.stringify(decision.operation)).toBe('completed');
      return async (expectedHead = target.revision) => {
        await claimFixture(stack.accessPool, report.caseId, member.principalId, actor);
        return governance.decide(principal, { ...input,
          targets: input.targets.map(target => ({ ...target, expectedHead: target.owner === 'media' ? null : expectedHead })),
          outcome: 'reverse', expectedGeneration: decision.caseGeneration,
          reversesDecisionId: decision.decisionId, idempotencyKey: randomUUID() });
      };
    };
    await check(true);
    const restore = await restrict({ owner: 'graph', resource: work.work, component: 'title', revision: heads.head!.value });
    await check(false);
    await restore();
    await check(true);
    const restoreMedia = await restrict({ owner: 'media', resource: work.work, component: 'media_use',
      revision: picture.revision }, GLOBAL_CONTEXT, media.body.items[0]!.use);
    expect((await channels[4]!.read()).status).toBe(404);
    await restoreMedia();
    expect((await channels[4]!.read()).status).toBe(200);
    const chapter = seeded.chapterRevisions[0]!;
    const phrase = async () => {
      await projectContent();
      return json<{ total: number; results: { resource: string }[] }>(await call('POST', '/v1/queries',
        { profile: 'public-content-phrase-v1', phrase: seeded.chapterPhrase, language: 'en' }));
    };
    expect((await phrase()).total).toBe(2);
    const restoreChapter = await restrict({ owner: 'content', resource: chapter.resource_id,
      component: 'body', revision: chapter.id });
    expect((await phrase()).total).toBe(1);
    expect((await phrase()).results.some(row => row.resource === chapter.resource_id)).toBe(false);
    const toc = await json<{ items: { target: string }[] }>(await call('GET', `/v1/works/${short(seeded.works[2]!.work)}/contents?language=en`));
    expect(toc.items).toHaveLength(1);
    expect(toc.items.some(row => row.target === chapter.resource_id)).toBe(false);
    await restoreChapter();
    expect((await phrase()).total).toBe(2);
    const book = seeded.works[2]!.work;
    const bookHead = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
      GRAPH <urn:rezics:graph:current> { <${book}> rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    const restoreBook = await restrict({ owner: 'graph', resource: book, component: 'title', revision: bookHead });
    expect((await phrase()).total).toBe(0);
    expect((await phrase()).results).toEqual([]);
    await restoreBook();
    expect((await phrase()).total).toBe(2);
    for (const row of [reply, post]) {
      const restore = await restrict({ owner: 'content', resource: row.id, component: 'body', revision: row.draft_head }, seeded.realm.realm);
      expect((await call('GET', `/v1/realms/${short(seeded.realm.realm)}/threads/${short(row.id)}`)).status).toBe(404);
      const feed = await (await call('GET', '/v1/feed?sort=new&scope=all&limit=20')).text();
      expect(feed).not.toContain(row.parent_reply ? 'A reviewed Home response' : 'A reviewed Home discussion');
      await restore();
      expect((await call('GET', `/v1/realms/${short(seeded.realm.realm)}/threads/${short(row.id)}`)).status).toBe(200);
    }
    const resolved = { resource: work.work, base: 'resource' as const, types: [], work: null,
      revision: heads.head!.value, disclosure: 'public' as const };
    const assessment = await suitability.write(principal, resolved,
      { actingSubject: actor, expectedRevision: null, labels: ['r18'], basis: 'platform' }, randomUUID());
    await check(true);
    const cleared = await suitability.write(principal, resolved, { actingSubject: actor,
      expectedRevision: assessment.assessment.revision, labels: [], basis: 'platform' }, randomUUID());
    await check(true);
    const releaseOldTitle = await restrict({ owner: 'graph', resource: work.work, component: 'title', revision: heads.head!.value });
    await check(false);
    await grant(`work:edit:${work.work}`, 'work.edit');
    work.title = 'Fixed Home Work title';
    const fixed = await json<{ revision: string }>(await call('POST', '/v1/content-edits', {
      profile: 'metadata-only-v1', work: work.work, expectedHead: heads.head!.value,
      title: work.title, actingSubject: actor }, true));
    heads.head!.value = fixed.revision;
    await check(true);
    await releaseOldTitle(fixed.revision);
    // Zone's graph-budget Proxy must inherit the same configured live owner.
    const definition = native();
    await json(await call('POST', '/v1/collection-definitions', { definition, name: 'Endpoint query', disclosure: 'public',
      actingSubject: actor, query: { phrase: 'g542endpointphrase', language: null }, resultBudget: 16 }, true), 201);
    const config = { queryBlocks: [{ block: 'matrix', definition, maxRows: 20 }], budget: { timeMs: 2000, rows: 1000 },
      presentation: { modules: [{ id: 'matrix', source: { kind: 'query-block', block: 'matrix' } }] } } as unknown as ZoneConfiguration;
    expect(JSON.stringify(await readZoneModuleData(stack.env, config))).toContain(work.work);
    const restoreZone = await restrict({ owner: 'graph', resource: work.work, component: 'title', revision: heads.head!.value });
    expect(JSON.stringify(await readZoneModuleData(stack.env, config))).not.toContain(work.work);
    await restoreZone();
    const checkExport = async (visible: boolean) => {
      const response = await channels[3]!.read(), body = await response.text();
      expect(response.status, body).toBe(201);
      expect(channels[3]!.visible(body), 'export').toBe(visible);
    };
    await checkExport(true);
    const restoreExport = await restrict({ owner: 'graph', resource: work.work, component: 'title', revision: heads.head!.value });
    await checkExport(false);
    await restoreExport();
    await checkExport(true);
    const adult = await suitability.write(principal, { ...resolved, revision: heads.head!.value },
      { actingSubject: actor, expectedRevision: cleared.assessment.revision,
        labels: ['r18'], basis: 'platform' }, randomUUID());
    await checkExport(true);
    await suitability.write(principal, { ...resolved, revision: heads.head!.value },
      { actingSubject: actor, expectedRevision: adult.assessment.revision, labels: [], basis: 'platform' }, randomUUID());
    await checkExport(true);
  } finally { await home.stop(); }
}, 360_000);
