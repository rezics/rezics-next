import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { fromPlainText } from '@rezics/document';
import { expect, type Browser, type TestInfo } from '@playwright/test';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import type { DecisionInput, DecisionResult, ReportResult } from '../../../services/main/src/modules/governance/store.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { fixtureReasons } from '../../../tests/qa/integration/g-565-decision-support.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { PublicCommands, selectedSessionAgent } from './direction-9-fixture.ts';

export const short = (iri: string) => iri.slice(-36);
const native = () => `https://rezics.com/id/${randomUUID()}`;

export async function closureRequestEvidence(info: TestInfo, name: string, request: object) {
  const path = info.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(request, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

/** Only authority is fixture data. Content, placement, publication and closure use public commands. */
async function grant(pool: Pool, principalId: string, actor: string, scope: string, ...actions: string[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const action of actions) await grantFixtureAuthority(client, {
      scope, requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function closureFixture(browser: Browser, info: TestInfo) {
  const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  const database = process.env.ACCESS_DATABASE_URL;
  if (!privatePath || !database) throw new Error('Realm closure needs the isolated QA web-auth and Access fixtures');
  const saved = JSON.parse(readFileSync(privatePath, 'utf8')) as {
    member: { email: string; password: string }; principalId: string;
  };
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const page = await context.newPage();
  const pool = new Pool({ connectionString: database });
  try {
    await signInAtAccounts(page, '/en', saved.member);
    const actor = await selectedSessionAgent(page.request, await context.cookies());
    const api = new PublicCommands(page.request);
    // Governance binds its body key to the transport key; keep one intent for every retry.
    const governance = async <T>(path: string, data: Record<string, unknown> & { idempotencyKey: string }): Promise<T> => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await page.request.post(`/api/main/v1${path}`, {
          headers: { 'idempotency-key': data.idempotencyKey }, data,
        });
        const body = await response.text();
        if ([200, 201].includes(response.status())) return JSON.parse(body) as T;
        if (![202, 503].includes(response.status())) {
          await closureRequestEvidence(info, 'governance-fixture-request', { method: 'POST', path, data,
            status: response.status(), response: body });
          throw new Error(`POST ${path}: HTTP ${response.status()} ${body}`);
        }
        await page.waitForTimeout(500);
      }
      throw new Error(`POST ${path} did not settle within 15 seconds`);
    };
    const authority = (scope: string, ...actions: string[]) => grant(pool, saved.principalId, actor, scope, ...actions);
    await authority('space:create:root', 'space.create');
    const suffix = randomUUID().slice(0, 8);
    const realmName = `Closure harbor ${suffix}`;
    const liveName = `Closure harbor neighbor ${suffix}`;
    const createRealm = (name: string) => api.write<{ realm: string; space: string }>('/spaces', {
      profile: 'space-realm-v2', capabilities: ['realm'], name, language: 'en', actingSubject: actor,
      initialSettings: { visibility: 'public', reviewMode: 'open', reviewRequired: false,
        whoMaySubmit: 'granted', selfJoin: false, rules: [] },
    });
    const realm = await createRealm(realmName);
    const live = await createRealm(liveName);
    await authority('work:create:root', 'work.create');
    const title = `Harbor independent guide ${suffix}`;
    const work = await api.write<{ work: string; mainVersion: string }>('/works', {
      profile: 'metadata-only-v1', title, language: 'en', authoring: 'own-work', actingSubject: actor,
    });
    await authority(`work:read:${work.work}`, 'work.read');
    await authority(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await api.write<{ contribution: string; draftRevision: string }>('/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: 'The independently published harbor guide survives community closure.', actingSubject: actor,
    });
    await authority(`contribution:read:${draft.contribution}`, 'contribution.read');
    await authority(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await api.write<{ publicationDecision: string }>('/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    });
    await authority(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await api.write<{ selectedDraft: string }>('/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
    });
    await authority(`publication:adopt:${realm.realm}`, 'publication.adopt');
    await api.write('/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm.realm },
      work: work.work, mainVersion: work.mainVersion, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: actor,
    });
    await authority(`reply:create:${work.work}`, 'reply.create');
    await authority(`reply:place:${realm.realm}`, 'reply.place');
    const place = async (body: string, parent?: { reply: string; revision: string }) => {
      const reply = native();
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      await authority(`content:draft:${reply}`, 'content.draft');
      const content = await api.write<{ revisionId: string; revisionDigest: string }>('/member-reply-drafts', {
        profile: 'member-reply-draft-v1', reply, variantId, rootTarget: work.work,
        rootRevision: selected.selectedDraft, originRealm: realm.realm, language: 'en', direction: 'ltr',
        spoiler: false, expectedHead: null, document: fromPlainText(body, 'blocks'), actingSubject: actor,
      });
      await api.write('/realm-replies', {
        profile: 'realm-reply-identity-v1', reply, variantId, revisionId: content.revisionId, author: actor,
        rootTarget: work.work, rootRevision: selected.selectedDraft, parentReply: parent?.reply ?? null,
        parentRevision: parent?.revision ?? null, contextRevision: null, spoiler: false,
      });
      await api.write('/realm-reply-placements', {
        profile: 'realm-reply-placement-v1', realm: realm.realm, reply, revisionId: content.revisionId,
        revisionDigest: content.revisionDigest, reviewDecisionId: null, expectedHead: null, actingSubject: actor,
      });
      return { reply, revision: content.revisionId, body };
    };
    const opening = await place(`Harbor discussion ${suffix}`);
    const reply = await place(`Harbor nested answer ${suffix}`, opening);

    const zoneName = `Independent harbor site ${suffix}`;
    const zone = await api.write<{ zone: string; space: string; revision: string }>('/spaces', {
      profile: 'space-zone-v1', capabilities: ['zone'], name: zoneName, language: 'en',
      visibility: 'public', listing: 'listed', actingSubject: actor,
    });
    await authority(`zone:edit:${zone.zone}`, 'zone.edit');
    await authority(`realm:attach:${realm.realm}`, 'realm.attach');
    const zonePath = `/zones/${short(zone.zone)}`;
    const configuration = await api.read<{ revision: string }>(`${zonePath}/configuration?actingSubject=${encodeURIComponent(actor)}`);
    await api.write(`${zonePath}/configuration`, {
      expectedHead: configuration.revision, defaultRealm: realm.realm, actingSubject: actor,
      presentation: { ...DEFAULT_ZONE_PRESENTATION, modules: [{ id: 'adoptions', type: 'shelf',
        title: 'Harbor community shelf', source: { kind: 'query-block', block: 'new-adoptions' } }] },
      prepareHomeDocument: true,
    }, 'PUT');
    const current = await api.read<{ revision: string; configuration: { homeDocument: string } }>(`${zonePath}/configuration?actingSubject=${encodeURIComponent(actor)}`);
    const homeDocument = current.configuration.homeDocument;
    const navigation = await api.read<{ revision: string }>(`${zonePath}?actingSubject=${encodeURIComponent(actor)}`);
    const mount = await api.write<{ revision: string }>(`${zonePath}/mounts`, {
      expectedHead: navigation.revision, target: work.work, routeSegment: 'guide', disclosure: 'public', actingSubject: actor,
    });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await authority(`content:draft:${homeDocument}`, 'content.draft');
    const homeText = `Welcome to the independent harbor ${suffix}`;
    const home = await api.write<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>('/content-drafts', {
      profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
      document: fromPlainText(homeText, 'blocks'), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', actingSubject: actor,
    });
    await api.write(`${zonePath}/site-publications`, {
      expectedHead: current.revision, routesRevision: mount.revision, navigationRevision: mount.revision,
      actingSubject: actor, pages: [{ page: homeDocument, variantId, revisionId: home.revisionId,
        byteDigest: home.byteDigest, contentEpoch: home.sourcePosition.dataEpoch }],
    });
    await authority('governance:platform', 'governance.moderate', 'governance.safety.evidence', 'governance.rule.publish');
    const rule = await governance<DecisionInput['rule']>('/governance/rules', {
      profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform',
      expectedRevision: null, document: { rule: 'A platform decision closes a Realm until restoration.' },
      actingSubject: actor, idempotencyKey: randomUUID(),
    });
    const header = await api.read<{ revision: string }>(`/realms/${short(realm.realm)}?actingSubject=${encodeURIComponent(actor)}`);
    // Real placement writes precede the asynchronous reply/ranking projection.
    await expect.poll(async () => {
      const path = `/realms/${short(realm.realm)}/threads/${short(opening.reply)}?actingSubject=${encodeURIComponent(actor)}`;
      const read = await api.inspect(path);
      if (read.status !== 200) {
        if (![409, 503].includes(read.status)) throw new Error(`GET ${path}: HTTP ${read.status} ${JSON.stringify(read.body)}`);
        return false;
      }
      const items = (read.body as { items: { reply: string }[] }).items;
      return [opening.reply, reply.reply].every(id => items.some(item => item.reply === id));
    }, { timeout: 120_000, intervals: [1000], message: 'Initial Realm thread projection is ready' }).toBe(true);
    let decision: { input: DecisionInput; result: DecisionResult } | undefined;
    const decide = async (input: DecisionInput, evidence: TestInfo) => {
      const path = '/api/main/v1/moderation/decisions';
      const data = { profile: 'moderation-decision-v1', ...input };
      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await page.request.post(path, { headers: { 'idempotency-key': input.idempotencyKey }, data });
        const body = await response.text();
        if (response.status() !== 202) {
          await closureRequestEvidence(evidence, `realm-${input.outcome}-request`, { method: 'POST', path, data,
            status: response.status(), response: body });
          expect(response.status(), `POST ${path}: ${body}`).toBe(200);
          const result = JSON.parse(body) as DecisionResult;
          expect(result.operation.status).toBe('completed');
          return result;
        }
        await page.waitForTimeout(500);
      }
      throw new Error(`POST ${path}: Realm ${input.outcome} did not confirm within 15 seconds`);
    };
    return {
      page, realm, live, realmName, liveName, zone, zoneName, homeText, work, title, opening, reply,
      async closeRealm(evidence: TestInfo) {
        const report = await governance<ReportResult>('/reports', {
          profile: 'content-report-v1', actingSubject: actor,
          authority: { kind: 'platform', scopeId: 'governance:platform' }, context: 'urn:rezics:context:global',
          target: { owner: 'graph', resource: realm.realm, component: 'record' }, disclosure: 'parties',
          reasonCode: 'reviewed_removal', statement: 'Review the harbor community as a whole.',
          evidence: [{ owner: 'graph', resource: realm.realm, component: 'record', revision: null, locator: null }],
          idempotencyKey: randomUUID(),
        });
        await governance(`/safety-cases/${report.caseId}/claim`, { actingSubject: actor, idempotencyKey: randomUUID() });
        const basis = await api.read<{ generation: string; reports: { evidenceDigest: string }[] }>(
          `/safety-cases/${report.caseId}?actingSubject=${encodeURIComponent(actor)}`);
        const input: DecisionInput = {
          caseId: report.caseId, expectedGeneration: basis.generation, actingSubject: actor, outcome: 'restrict',
          targets: [{ owner: 'graph', resource: realm.realm, component: 'record', locator: null,
            scopeKind: 'component', revision: null, expectedHead: header.revision, effect: 'disclosure' }],
          rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest }, evidenceDigest: basis.reports[0]!.evidenceDigest,
          reversesDecisionId: null, answersStepId: null, rationale: 'Close this Realm pending platform review.',
          disclosure: 'parties', reasons: fixtureReasons, idempotencyKey: randomUUID(),
        };
        decision = { input, result: await decide(input, evidence) };
      },
      async restoreRealm(evidence: TestInfo) {
        if (!decision) return;
        await governance(`/safety-cases/${decision.input.caseId}/claim`, { actingSubject: actor, idempotencyKey: randomUUID() });
        const basis = await api.read<{ generation: string }>(`/safety-cases/${decision.input.caseId}?actingSubject=${encodeURIComponent(actor)}`);
        await decide({ ...decision.input, expectedGeneration: basis.generation, outcome: 'restore',
          reversesDecisionId: decision.result.decisionId, rationale: 'Restore this Realm after platform review.',
          idempotencyKey: randomUUID() }, evidence);
        decision = undefined;
      },
      dispose: () => context.close(),
    };
  } catch (error) {
    await context.close();
    throw error;
  } finally { await pool.end(); }
}
