import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { grantPlatformResource, platformAdministratorSession, revokePlatformUse } from '../../../tests/qa/fixtures/platform-grant.ts';
import { PublicCommands, selectedSessionAgent } from './direction-9-fixture.ts';
import { newPostProgress, postDocument } from '../features/post-composer/api.ts';
import { browseQuery, emptyBrowse } from '../features/discover/browse-state.ts';

const short = (id: string) => id.slice(-36);

/** Setup uses the running stack's public commands. Keep every failing exchange
 * with the journey so an API refusal cannot be mistaken for browser proof. */
export async function realmClosureFixture(page: Page, info: TestInfo, surface: 'feed' | 'rankings' | 'search') {
  const actor = await selectedSessionAgent(page.request, await page.context().cookies());
  const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!privatePath) throw new Error('Realm closure needs the isolated web-auth fixture');
  const { principalId } = JSON.parse(readFileSync(privatePath, 'utf8')) as { principalId: string };
  const exchanges: unknown[] = [];
  mkdirSync('.temp/realm-closure-evidence', { recursive: true });
  const evidencePath = `.temp/realm-closure-evidence/${process.env.REZICS_QA_RUN_ID}-${surface}-${randomUUID()}.json`;
  const retain = () => writeFileSync(evidencePath, JSON.stringify(exchanges, null, 2));
  const request = {
    async get(path: string) {
      const url = new URL(path, 'http://fixture.invalid');
      url.searchParams.set('actingSubject', actor);
      path = url.pathname + url.search;
      const response = await page.request.get(path);
      const body = await response.json();
      exchanges.push({ method: 'GET', path, status: response.status(), body });
      retain();
      if (response.status() >= 400) await info.attach('realm-closure-api-read', {
        body: JSON.stringify(exchanges, null, 2), contentType: 'application/json',
      });
      return response;
    },
    async fetch(path: string, options: { method: string; data: unknown; headers: Record<string, string> }) {
      const commandKey = options.data && typeof options.data === 'object' && 'idempotencyKey' in options.data
        ? String(options.data.idempotencyKey) : options.headers['idempotency-key'];
      const response = await page.request.fetch(path, { ...options,
        headers: { ...options.headers, 'idempotency-key': commandKey! } });
      const body = await response.json();
      exchanges.push({ method: options.method, path, request: options.data, status: response.status(), body });
      retain();
      if (response.status() >= 400) await info.attach('realm-closure-api-failure', {
        body: JSON.stringify(exchanges, null, 2), contentType: 'application/json',
      });
      return response;
    },
  };
  const api = new PublicCommands(request);
  const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  async function grant(scope: string, action: string) {
    await grantFixtureAuthority(pool, { scope, requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' } });
  }
  const phrase = `Closuregarden${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const realmName = `${phrase} community`;
  const title = `${phrase} original`;
  const threadTitle = `${phrase} discussion`;
  try {
    if (!process.env.ACCESS_DATABASE_URL) throw new Error('Realm closure needs the isolated Access database');
    await grant('space:create:root', 'space.create');
    const { realm, space } = await api.write<{ realm: string; space: string }>('/spaces', {
      profile: 'space-realm-v1', name: realmName, capabilities: ['realm'], actingSubject: actor,
      initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'members', selfJoin: true, rules: [] },
    });
    await grant(`governance:realm:${realm}`, 'publication.adopt');
    const work = await api.write<{ work: string; mainVersion: string }>('/works', {
      profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Book'],
      authoring: 'own-work', actingSubject: actor,
    });
    const draft = await api.write<{ contribution: string; draftRevision: string }>('/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'A gardener plants a seed and keeps the original story available.', actingSubject: actor,
    });
    const published = await api.write<{ publicationDecision: string }>('/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    });
    const selection = { work: work.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null, actingSubject: actor };
    await api.write('/publication-selections', { ...selection, profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer' });
    await api.write('/publication-selections', { ...selection, profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: realm }, mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' });

    const progress = newPostProgress();
    const replyDraft = await api.write<{ revisionId: string; revisionDigest: string }>('/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply: progress.reply, variantId: progress.variantId,
      rootTarget: work.work, rootRevision: draft.draftRevision, originRealm: realm,
      language: 'en', direction: 'ltr', spoiler: false, expectedHead: null, actingSubject: actor,
      document: postDocument({ realm, work: work.work, mainVersion: work.mainVersion, title: threadTitle,
        body: 'Discuss the independently published original.', language: 'en', spoiler: false, actingSubject: actor }, progress),
    });
    await api.write('/realm-replies', { profile: 'realm-reply-identity-v1', reply: progress.reply,
      variantId: progress.variantId, revisionId: replyDraft.revisionId, author: actor,
      rootTarget: work.work, rootRevision: draft.draftRevision, parentReply: null,
      parentRevision: null, contextRevision: null, spoiler: false });
    await api.write('/realm-reply-placements', { profile: 'realm-reply-placement-v1', realm,
      reply: progress.reply, revisionId: replyDraft.revisionId, revisionDigest: replyDraft.revisionDigest,
      reviewDecisionId: null, expectedHead: null, actingSubject: actor });
    const following = await api.read<{ revision: string | null }>(`/me/follow-state?${new URLSearchParams({ target: realm, actingSubject: actor })}`);
    await api.write('/follows', { profile: 'follow-command-v1', target: realm, actingSubject: actor,
      following: true, level: 'all', expectedRevision: following.revision });

    // Command receipts precede relay convergence. Qualify the read basis and
    // actual searchable occurrence before opening the reader's browser pages.
    let position = '', stable = 0;
    await api.until<{ sourcePosition: unknown }>(`/works/${short(work.work)}`, value => {
      const next = JSON.stringify(value.sourcePosition);
      stable = next === position ? stable + 1 : 0;
      position = next;
      return stable >= 4;
    });
    for (const scope of surface === 'search'
      ? [{ kind: 'global' }, { kind: 'realm', realm: short(realm) }] as const : []) {
      await api.until<{ result: { items: { id: string }[] } }>('/query',
        value => value.result.items.some(item => item.id === work.work),
        browseQuery({ ...emptyBrowse, q: phrase, scope }));
    }

    return { api, actor, realm, space, phrase, realmName, title, threadTitle, work: work.work,
      async close() {
        const administrator = await platformAdministratorSession();
        // Publish with a bounded public designation, then remove that standing power.
        const designation = await grantPlatformResource(administrator, principalId,
          'governance.rule.publish', 'governance:platform', new Date(Date.now() + 3_600_000).toISOString());
        let rule: { ref: string; revision: string; digest: string };
        try {
          const publishedRule = await api.write<typeof rule>('/governance/rules', { profile: 'governance-rule-v1',
            ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform', actingSubject: actor,
            expectedRevision: null, document: { rule: 'Close the reviewed Realm while preserving independent originals.' },
            idempotencyKey: randomUUID() });
          rule = { ref: publishedRule.ref, revision: publishedRule.revision, digest: publishedRule.digest };
        } finally { await revokePlatformUse(administrator, designation); }
        for (const action of ['governance.moderate', 'governance.safety.evidence'])
          await grant('governance:platform', action);
        const header = await api.read<{ revision: string }>(`/realms/${short(realm)}`);
        const report = await api.write<{ reportId: string; caseId: string }>('/public-reports', {
          profile: 'public-report-v1', actingSubject: actor, target: realm,
          category: 'spam_or_manipulation', contentLanguage: 'en', statement: 'Review only the Realm record.',
        });
        await api.write(`/safety-cases/${report.caseId}/claim`, { actingSubject: actor, idempotencyKey: randomUUID() });
        const safety = await api.read<{ generation: string; reports: { evidenceDigest: string }[] }>(
          `/safety-cases/${report.caseId}?${new URLSearchParams({ actingSubject: actor })}`);
        const decision = await api.write<{ operation: { status: string } }>('/moderation/decisions', {
          profile: 'moderation-decision-v1', caseId: report.caseId, expectedGeneration: safety.generation,
          actingSubject: actor, outcome: 'restrict', targets: [{ owner: 'graph', resource: realm,
            component: 'record', locator: null, scopeKind: 'component', revision: null,
            expectedHead: header.revision, effect: 'disclosure' }], rule,
          evidenceDigest: safety.reports[0]!.evidenceDigest, reversesDecisionId: null, answersStepId: null,
          rationale: 'Close only the reviewed Realm record.', disclosure: 'parties',
          reasons: { facts: 'Reviewed exact record.', scope: 'This Realm only.', duration: 'Until a later decision.',
            automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
          idempotencyKey: randomUUID(),
        });
        expect(decision.operation.status).toBe('completed');
        await info.attach('realm-closure-commands', { body: JSON.stringify(exchanges, null, 2), contentType: 'application/json' });
      },
      async dispose() {
        await info.attach('realm-closure-api', { body: JSON.stringify(exchanges, null, 2), contentType: 'application/json' });
        await pool.end();
      },
    };
  } catch (error) {
    console.error('Realm closure failing exchange', JSON.stringify(exchanges.at(-1)));
    console.error(`Realm closure evidence: ${evidencePath}`);
    await info.attach('realm-closure-api', { body: JSON.stringify(exchanges, null, 2), contentType: 'application/json' });
    await pool.end(); throw error;
  }
}
