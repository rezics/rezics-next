import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect as browserExpect } from '@playwright/test';
import { ContentCore } from '../../../services/content/src/core.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { GovernanceStore, GLOBAL_CONTEXT, type CapturedEvidence, type DecisionInput } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { DISCLOSURE_CHANNELS, disclose, type DisclosureTarget } from '../../../services/main/src/modules/disclosure/read.ts';
import { discloseNotifications } from '../../../services/main/src/modules/disclosure/notifications.ts';
import { disclosureContent } from '../../../services/main/src/modules/disclosure/assembly.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { ANONYMOUS_VIEWER, type Labels } from '../../../services/main/src/modules/suitability/policy.ts';
import { disclosureViewer } from '../../../services/main/src/modules/disclosure/viewer.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { NotificationDispatcher, type NotificationSubjectReader, type ProviderSend } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { png } from './media-support.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';

import { claimFixture, fixtureReasons } from './g-565-decision-support.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function stopWeb(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  await exited;
}

test('G-542: real governance restrict/restore and r18 policy matrix, public API and fresh-browser share URL', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const started = Date.now(), directory = resolve('.temp', `g-542-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read governance:report governance:decide');
  const content = new ContentCore(f.pool);
  const principal = { issuer: f.account.issuer, subject: f.account.a.id };
  const rules = new GovernanceRules(f.accessPool);
  const scope = `governance:platform:${randomUUID()}`;
  const heads = ownerTargetHeads({ graph: f.env, content: f.pool });
  const captures = ownerEvidenceCapture({ graph: { env: f.env, canReadWork: async () => true },
    content: { core: content, canRead: async (_principal, _actor, ids) => new Set(ids) } });
  const mediaStore = new MediaStore(f.pool, content);
  const objects = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  await objects('media/').initialize();
  let mediaEvidence: CapturedEvidence;
  const governance = new GovernanceStore(f.accessPool, { capture: async (principal, actor, target) =>
    target.owner === 'media' ? mediaEvidence : captures.capture(principal, actor, target) },
  { current: target => target.owner === 'media' ? Promise.resolve(null) : heads.current(target) }, rules,
  ownerModerationEffects(new ContentModeration(f.pool), f.env, { pool: f.pool, core: content }));
  const suitability = new SuitabilityStore(f.accessPool, f.access);
  const notifications = new NotificationStore(f.accessPool);
  const subjects: NotificationSubjectReader = { resolve: async input => ({ status: 'available',
    subject: { private: false, fields: { title: 'G-542 notification secret', linkTarget: input.ref } } }) };
  notifications.setDefaultReadSubjectReader(subjects);
  const sent: ProviderSend[] = [];
  const dispatcher = new NotificationDispatcher(f.accessPool, { name: 'g-542',
    send: async request => { sent.push(request); return { status: 'accepted', messageId: randomUUID() }; },
    lookup: async () => ({ status: 'not_found' }) }, subjects);
  const deps: MainWorkDependencies = { environment: f.env, account: f.account.verifier, access: f.access,
    media: { store: mediaStore, content, objects }, suitability, governance: { store: governance, rules }, content,
    notifications: { store: notifications, dispatcher } };
  const app = createMainApp(f.env.fuseki, deps);
  const call = (method: string, path: string, body?: object, authenticated = false) => app.handle(new Request(`http://main.local${path}`, {
    method, headers: { ...(authenticated ? { authorization: `Bearer ${f.account.tokenA}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}), 'idempotency-key': randomUUID() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  let web: ChildProcess | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const title = `G-542 secret Work ${randomUUID()}`;
    // Establish the existing represented Agent through its real graph owner.
    await createAgentGraph(f.env, { id: randomUUID(), agent: f.actor, kind: 'person',
      displayName: 'G-542 fixture author', digest: digest(`g542-agent-${f.actor}`) });
    const work = await json<{ work: string; workRevision: string; mainVersion: string }>(await call('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en', semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor,
    }, true), 201);
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'G542uniquephrase secret text', actingSubject: f.actor,
    }, true), 201);
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const publication = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor,
    }, true), 201);
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    await json(await call('POST', '/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
      contribution: draft.contribution, publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: f.actor,
    }, true), 201);
    const saved = [];
    for (const grain of ['body', 'reply', 'post']) {
      const resource = grain === 'body' ? work.work : nativeId();
      const value = await content.saveDraft({ operationId: `g-542-${randomUUID()}`,
        variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: resource,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: { fixture: grain },
        serializedJson: JSON.stringify({ body: `G-542 ${grain} secret words` }) });
      saved.push({ owner: 'content' as const, resource, component: 'body' as const, revision: value.revisionId! });
    }
    await f.grant(`media:owner:${f.actor}`, 'media.upload');
    const bytes = png(64, 64);
    const reserved = await json<{ upload: string; asset: string }>(await call('POST', '/v1/media/uploads', {
      profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), disclosure: 'public', actingSubject: f.actor,
    }, true), 201);
    const activated = await json<{ representation: string }>(await app.handle(new Request(
      `http://main.local/v1/media/uploads/${reserved.upload}/bytes`, { method: 'PUT',
        headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/octet-stream' },
        body: new Blob([bytes]) })), 201);
    const mediaRef = `https://rezics.com/id/${reserved.asset}`, mediaRevision = activated.representation;
    mediaEvidence = { owner: 'media', resource: mediaRef, component: 'cover', revision: mediaRevision, locator: null,
      state: 'available', representation: 'image/png', revisionDigest: createHash('sha256').update(bytes).digest('hex'),
      provenance: { fixture: 'g-542-owner-original' } };
    // The matrix proves the shared policy over exact owner grains. Endpoint
    // assertions below cover summaries/previews/sitemap, Content and notifications;
    // placed threads/feed/search/export and media-use bytes need their owner fixtures.
    const fixtures: DisclosureTarget[] = [
      { owner: 'graph', resource: work.work, component: 'title', revision: work.workRevision },
      ...saved, { owner: 'media', resource: mediaRef, component: 'cover', revision: mediaRevision },
    ];
    await f.grant(scope, 'governance.moderate');
    await f.grant(scope, 'governance.rule.publish');
    await f.grant('governance:platform', 'governance.moderate');
    const rule = await rules.publish(principal, { ref: `urn:rezics:rule:${randomUUID()}`, scopeId: scope,
      actingSubject: f.actor, expectedRevision: null, document: { purpose: 'g-542-disclosure-matrix' }, idempotencyKey: randomUUID() });
    expect(Date.now() - started).toBeLessThan(600_000);
    const publicRead = () => call('GET', `/v1/resources/${shortId(work.work)}`);
    const preview = () => call('GET', `/v1/public-previews/${shortId(work.work)}`);
    const sitemap = async () => json<{ entries: { reference: string }[] }>(await call('GET', '/v1/sitemap'));
    expect((await publicRead()).status).toBe(200);
    expect((await preview()).status).toBe(200);
    expect((await sitemap()).entries.some(entry => entry.reference === work.work)).toBe(true);
    await notifications.registerEndpoint(principal, { channel: 'email', deviceId: null,
      address: null, addressDigest: digest('g-542@example.test'), lockScreenDisclosure: false });
    await notifications.registerEndpoint(principal, { channel: 'push', deviceId: 'g-542-browser',
      address: 'g-542-push-fixture', addressDigest: digest('g-542-push-fixture'), lockScreenDisclosure: false });
    const enqueue = async (target: DisclosureTarget) => (await notifications.enqueue({ sourceOwner: 'graph',
      sourceEvent: `g-542-${randomUUID()}`, purpose: 'social', topic: 'reply',
      subject: { owner: target.owner === 'review' ? 'access' : target.owner,
        ref: target.resource, revision: target.revision ?? null }, disclosureBasis: 'g-542', recipients: [f.principalId],
      display: { kind: 'reply', actorAgent: null, realm: null, groupKey: null } }))[0]!;
    for (const target of fixtures) {
      for (const channel of DISCLOSURE_CHANNELS) expect(await disclose(f.env, [target], ANONYMOUS_VIEWER, channel)).toEqual(['visible']);
      const notice = await enqueue(target);
      expect(notice.deliveries).toBe(2);
      expect((await notifications.readStream(principal, null)).items.find(item => item.id === notice.itemId)?.display?.target.title)
        .toBe('G-542 notification secret');
      expect((await notifications.unreadCount(principal)).count).toBe(1);
      const sendsBefore = sent.length;
      const report = await governance.submitReport(principal, { kind: 'content_report', actingSubject: f.actor,
        authority: { kind: 'platform', scopeId: scope }, context: GLOBAL_CONTEXT,
        target, disclosure: 'parties', reasonCode: 'policy', statement: 'G-542 exact disclosure fixture',
        evidence: [{ ...target, revision: target.revision ?? null, locator: null }], idempotencyKey: randomUUID() });
      const decision: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
        actingSubject: f.actor, outcome: 'restrict', evidenceDigest: report.evidenceDigest,
        rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
        targets: [{ ...target, locator: null, scopeKind: 'exact_revision', revision: target.revision ?? null,
          expectedHead: target.owner === 'media' ? null : target.revision ?? null, effect: 'disclosure' }],
        reasons: fixtureReasons, reversesDecisionId: null, answersStepId: null, rationale: 'G-542 fixture restriction', disclosure: 'parties', idempotencyKey: randomUUID() };
      await claimFixture(f.accessPool, report.caseId, f.principalId, f.actor);
      const restricted = await governance.decide(principal, decision);
      expect(restricted.operation.status, JSON.stringify(restricted.operation)).toBe('completed');
      for (const channel of DISCLOSURE_CHANNELS) expect((await disclose(f.env, [target], ANONYMOUS_VIEWER, channel))[0]).not.toBe('visible');
      expect((await notifications.readStream(principal, null)).items.find(item => item.id === notice.itemId)?.display).toBeNull();
      expect((await notifications.unreadCount(principal)).count).toBe(0);
      expect((await dispatcher.runOnce()).cancelled).toBe(2);
      expect(sent.length).toBe(sendsBefore);
      const subjectInput = { principalId: f.principalId, owner: target.owner, ref: target.resource,
        revision: target.revision ?? null, disclosureBasis: 'g-542' };
      for (const channel of ['inbox', 'digest', 'email', 'push'] as const) {
        const [subject] = await discloseNotifications(f.accessPool, [{ input: subjectInput, result: await subjects.resolve(subjectInput) }], channel);
        expect(subject?.status).toBe('undisclosed');
        expect(JSON.stringify(subject)).not.toContain('G-542 notification secret');
      }
      if (target.owner === 'content') {
        expect((await disclose(f.env, [{ ...target, owner: 'graph',
          revision: `urn:rezics:content:revision:${target.revision}` }], ANONYMOUS_VIEWER, 'thread'))[0]).not.toBe('visible');
        const reader = disclosureContent(content, f.env);
        expect((await reader.readExactBatch([target.revision!], async ids => new Set(ids)))[0]?.status).toBe('denied');
      }
      if (target.owner === 'graph') {
        expect((await publicRead()).status).toBe(404);
        expect((await preview()).status).toBe(404);
        expect((await sitemap()).entries.some(entry => entry.reference === work.work)).toBe(false);
        // One short-lived web server against this QA fixture's Main HTTP API.
        server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.handle(request) });
        const portReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
        const webPort = portReservation.port!;
        await portReservation.stop(true);
        const log = openSync(resolve(directory, 'web.log'), 'w', 0o600);
        try {
          web = spawn('task', ['web:dev', '--', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: resolve('.'), detached: true,
            env: { ...Bun.env, VINEXT_NO_DEV_LOCK: '1', MAIN_ORIGIN: `http://127.0.0.1:${server.port}`,
              ACCOUNT_ORIGIN: f.account.issuer.replace(/\/api\/auth$/, ''), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
            stdio: ['ignore', log, log] });
        } finally { closeSync(log); }
        const url = `http://127.0.0.1:${webPort}/en/w/${shortId(work.work)}`;
        let ready = false, lastResponse = '';
        for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
          const response = await fetch(`http://127.0.0.1:${webPort}/favicon.ico`,
            { signal: AbortSignal.timeout(5_000) }).catch(() => null);
          if (response && [200, 404].includes(response.status)) { ready = true; break; }
          if (response) lastResponse = `${response.status}: ${(await response.text()).slice(0, 2_000)}`;
          await delay(500);
        }
        if (!ready) throw new Error(`G-542 web readiness failed: ${lastResponse}\n${await Bun.file(resolve(directory, 'web.log')).text()}`);
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });
        // Network idleness can precede vinext's streamed not-found boundary.
        // Wait for the actual user-visible result before inspecting its metadata.
        await browserExpect(page.getByRole('heading', { name: 'Work not found', exact: true })).toBeVisible();
        expect(await page.content()).not.toContain(title);
        expect(await page.locator('head meta[property="og:title"]').count()).toBe(0);
        expect(await page.locator('head meta[name="description"]').count()).toBe(0);
        await page.screenshot({ path: resolve(directory, 'restricted-share.png'), fullPage: true });
        await context.close();
        await browser.close(); browser = undefined;
        await stopWeb(web); web = undefined;
        await server.stop(true); server = undefined;
      }
      await claimFixture(f.accessPool, report.caseId, f.principalId, f.actor);
      await governance.decide(principal, { ...decision, expectedGeneration: restricted.caseGeneration, outcome: 'reverse',
        reversesDecisionId: restricted.decisionId, idempotencyKey: randomUUID() });
      for (const channel of DISCLOSURE_CHANNELS) expect(await disclose(f.env, [target], ANONYMOUS_VIEWER, channel)).toEqual(['visible']);
      expect((await notifications.readStream(principal, null)).items.find(item => item.id === notice.itemId)?.subject).not.toBeNull();
      expect((await notifications.unreadCount(principal)).count).toBe(1);
      const restoredNotice = await enqueue(target);
      expect((await dispatcher.runOnce()).delivered).toBe(2);
      expect(sent.length).toBe(sendsBefore + 2);
      expect(sent.slice(sendsBefore).every(send => send.payload.title === 'G-542 notification secret')).toBe(true);
      await notifications.markItemRead(principal, notice.itemId);
      await notifications.markItemRead(principal, restoredNotice.itemId);
    }
    expect((await publicRead()).status).toBe(200);
    expect((await preview()).status).toBe(200);
    expect((await sitemap()).entries.some(entry => entry.reference === work.work)).toBe(true);
    for (const target of fixtures) {
      const resolved = { resource: target.resource, base: 'resource' as const, types: [], work: null,
        revision: work.workRevision, disclosure: 'public' as const };
      const existing = (await suitability.read([resolved]))[0]!;
      let revision: string | null = existing.status === 'assessed' ? existing.revision : null;
      for (const labels of [['r18'], ['r18g']] as Labels[]) {
        const assessment = await suitability.write(principal, resolved,
          { actingSubject: f.actor, expectedRevision: revision, labels, basis: 'platform' }, randomUUID());
        revision = assessment.assessment.revision;
        for (const channel of DISCLOSURE_CHANNELS) {
          for (const viewer of [ANONYMOUS_VIEWER, disclosureViewer(principal)]) {
            const decision = (await disclose(f.env, [target], viewer, channel))[0];
            if (['email', 'push', 'digest', 'preview', 'seo', 'sitemap'].includes(channel)) {
              expect(decision).not.toBe('visible');
            } else expect(decision).toBe('visible');
          }
        }
        const sendsBefore = sent.length, notice = await enqueue(target);
        expect((await notifications.unreadCount(principal)).count).toBe(1);
        expect((await notifications.readStream(principal, null)).items.find(item => item.id === notice.itemId)?.subject).not.toBeNull();
        expect((await dispatcher.runOnce()).cancelled).toBe(2);
        expect(sent.length).toBe(sendsBefore);
        await notifications.markItemRead(principal, notice.itemId);
        if (target.owner === 'graph') {
          expect((await publicRead()).status).toBe(200);
          expect((await preview()).status).toBe(404);
          expect((await sitemap()).entries.some(entry => entry.reference === work.work)).toBe(false);
        }
      }
      const recovered = await suitability.write(principal, resolved,
        { actingSubject: f.actor, expectedRevision: revision, labels: [], basis: 'platform' }, randomUUID());
      expect(recovered.assessment.labels).toEqual([]);
    }
    // Legacy fixtures may omit governance; configured owner outages are covered separately.
    const processNotices = [
      ['realm-invitation-v1', 'realm-invitation', 'realm_invitation'],
      ['submission-decision-v1', 'submission-decision', 'submission_decision'],
      ['moderation-outcome-v1', 'moderation-outcome', 'moderation_outcome'],
      ['realm-role-change-v1', 'realm-role-change', 'realm_role_change'],
    ] as const;
    for (const [basis, topic, kind] of processNotices) {
      const processSubjects: NotificationSubjectReader = { resolve: async () => ({ status: 'available',
        subject: { private: false, fields: { excerpt: 'process outcome', linkTarget: work.work, title } } }) };
      notifications.registerReadSubjectReader(basis, processSubjects);
      dispatcher.registerSubjectReader(basis, processSubjects);
      const notice = (await notifications.enqueue({ sourceOwner: 'access', sourceEvent: randomUUID(),
        purpose: 'governance', topic, subject: { owner: 'access', ref: randomUUID(), revision: null },
        disclosureBasis: basis, recipients: [f.principalId],
        display: { kind, actorAgent: null, realm: null, groupKey: null } }))[0]!;
      expect(notice.deliveries).toBe(2);
      expect((await notifications.unreadCount(principal)).count).toBe(1);
      expect((await notifications.readStream(principal, null)).items.find(item => item.id === notice.itemId)?.display).not.toBeNull();
      expect((await dispatcher.runOnce()).delivered).toBe(2);
      await notifications.markItemRead(principal, notice.itemId);
    }
    createMainApp(f.env.fuseki, { ...deps, governance: undefined });
    expect((await preview()).status).toBe(200);
    expect(sent).toHaveLength(18);
  } finally {
    if (browser) await browser.close();
    if (web) await stopWeb(web);
    if (server) await server.stop(true);
    await f.close();
    // Browser artifacts stay in the worktree for the manager's visual review.
    rmSync(resolve(directory, 'objects'), { recursive: true, force: true });
  }
}, 360_000);
