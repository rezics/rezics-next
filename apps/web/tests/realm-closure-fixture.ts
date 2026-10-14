import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { fromPlainText, normalizeDocument, type DocumentSnapshot } from '@rezics/document';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { grantPlatformResource, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { selectedSessionAgent } from './direction-9-fixture.ts';

export const short = (iri: string) => iri.slice(-36);
const subject = (actor: string) => `actingSubject=${encodeURIComponent(actor)}`;

function originalPixel() {
  const chunk = (kind: string, data: Uint8Array) => {
    const encoded = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of encoded) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, encoded, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 33, 150, 83, 255]))), chunk('IEND', new Uint8Array())]);
}

/** Preserve the exact failing public request in Playwright's output, including a pending command's receipt. */
export async function command<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const key = data && typeof data === 'object' && 'idempotencyKey' in data && typeof data.idempotencyKey === 'string'
    ? data.idempotencyKey : randomUUID();
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await page.request.fetch(`/api/main/v1${path}`, {
      method, data, headers: method === 'GET' ? {} : { 'idempotency-key': key },
    });
    const raw = await response.text();
    if ([200, 201].includes(response.status())) return JSON.parse(raw) as T;
    if (response.status() !== 202 || attempt === 59)
      throw new Error(`${method} /v1${path}\nrequest: ${JSON.stringify(data)}\nHTTP ${response.status()}: ${raw}`);
    await page.waitForTimeout(250);
  }
  throw new Error(`Command did not complete: ${method} /v1${path}`);
}

async function principal(actor: string) {
  const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  try {
    const result = await pool.query<{ principal_id: string }>(`SELECT principal_id FROM access.representation
      WHERE subject_id=$1 AND action='agent.control' AND active AND valid_until>now() LIMIT 1`, [actor]);
    expect(result.rows[0], 'The signed-in Person has a controlling principal').toBeDefined();
    return result.rows[0]!.principal_id;
  } finally { await pool.end(); }
}

async function grant(actor: string, principalId: string, scope: string, action: string) {
  if (!process.env.ACCESS_DATABASE_URL) throw new Error('Realm closure journeys need an isolated QA Access database');
  const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' } });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}

type Person = { page: Page; actor: string; principalId: string; name: string };
type Realm = { realm: string; space: string; name: string };
export type Work = { work: string; mainVersion: string; workRevision: string; title: string };

export async function realmClosureFixture(browser: Browser, info: TestInfo) {
  const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!privatePath) throw new Error('Realm closure journeys need REZICS_WEB_AUTH_PRIVATE_PATH');
  const auth = JSON.parse(readFileSync(privatePath, 'utf8')) as {
    member: { email: string; password: string }; operator: { email: string; password: string };
  };
  const contexts: Awaited<ReturnType<Browser['newContext']>>[] = [];
  async function person(credentials: typeof auth.member, onboard: boolean): Promise<Person> {
    const context = await browser.newContext({ ...info.project.use, reducedMotion: 'reduce' });
    contexts.push(context);
    const page = await context.newPage();
    await signInAtAccounts(page, '/en', credentials, onboard);
    if (new URL(page.url()).pathname.endsWith('/onboarding')) {
      const key = (await context.cookies()).find(cookie => cookie.name === 'rezics_session_key')!.value;
      const created = await page.request.post('/api/main/v1/me/onboarding', {
        headers: { 'x-session-key': key, 'idempotency-key': randomUUID() },
        data: { profile: 'person-onboarding-v1', displayName: `Closure writer ${randomUUID().slice(0, 8)}` },
      });
      expect([200, 201], await created.text()).toContain(created.status());
      const state = await page.request.get('/api/main/v1/me/session-agent', { headers: { 'x-session-key': key } });
      const selected = await state.json() as { sessionAgent: { revision: string } };
      const finished = await page.request.post('/identity/select', { maxRedirects: 0,
        form: { agent: (await created.json() as { agent: string }).agent, locale: 'en', next: '/en',
          sessionRevision: selected.sessionAgent.revision } });
      expect(finished.status(), await finished.text()).toBe(303);
      await page.goto('/en');
    }
    const actor = await selectedSessionAgent(page.request, await context.cookies());
    const agent = await command<{ displayName?: string; name?: string }>(page, 'GET', `/agents/${short(actor)}?${subject(actor)}`);
    return { page, actor, principalId: await principal(actor), name: agent.displayName ?? agent.name ?? actor };
  }
  try {
    const owner = await person(auth.member, false);
    const writer = await person(auth.operator, true);
    expect(writer.actor, 'Author and notification recipient are different Persons').not.toBe(owner.actor);
    const grantTo = (person: Person, scope: string, action: string) => grant(person.actor, person.principalId, scope, action);
    await grantTo(owner, 'space:create:root', 'space.create');
    async function realm(label: string): Promise<Realm> {
      const name = `${label} ${randomUUID().slice(0, 8)}`;
      const created = await command<Realm>(owner.page, 'POST', '/spaces', {
        profile: 'space-realm-v2', name, language: 'en', capabilities: ['realm'], actingSubject: owner.actor,
        initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
          whoMaySubmit: 'members', selfJoin: true, rules: [] },
      });
      await command(owner.page, 'POST', `/realms/${short(created.realm)}/management`, { actingSubject: owner.actor });
      const joining = await command<{ membershipGeneration: string; policyRevision: string; termsRevision: string }>(
        writer.page, 'GET', `/realms/${short(created.realm)}/joining?${subject(writer.actor)}`);
      await command(writer.page, 'POST', `/realms/${short(created.realm)}/join`, {
        actingSubject: writer.actor, expectedMembershipGeneration: joining.membershipGeneration,
        expectedPolicyRevision: joining.policyRevision, termsRevision: joining.termsRevision, listed: true,
      });
      return { ...created, name };
    }
    const closed = await realm('Closure harbor');
    const live = await realm('Independent harbor');

    async function work(title: string): Promise<Work> {
      await grantTo(writer, 'work:create:root', 'work.create');
      return { ...await command<Omit<Work, 'title'>>(writer.page, 'POST', '/works', {
        profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title,
        semanticTypes: ['https://schema.org/Book'], actingSubject: writer.actor,
      }), title };
    }
    async function publish(work: Work, document: DocumentSnapshot) {
      await grantTo(writer, `contribution:create:${work.work}`, 'contribution.create');
      const draft = await command<{ contribution: string; draftRevision: string }>(writer.page, 'POST', '/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en', document, actingSubject: writer.actor,
      });
      await grantTo(writer, `contribution:publish:${draft.contribution}`, 'contribution.publish');
      const published = await command<{ publicationDecision: string }>(writer.page, 'POST', '/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: writer.actor,
      });
      await grantTo(writer, `publication:select:${work.mainVersion}`, 'publication.select');
      await command(writer.page, 'POST', '/publication-selections', {
        profile: 'main-default-selection-v1', work: work.work, contribution: draft.contribution,
        publicationDecision: published.publicationDecision, expectedSelectionHead: null,
        context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer', actingSubject: writer.actor,
      });
    }
    async function reply(realm: Realm, work: Work, body: string) {
      const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
      await grantTo(writer, `content:draft:${reply}`, 'content.draft');
      await grantTo(writer, `reply:create:${work.work}`, 'reply.create');
      await grantTo(writer, `reply:place:${realm.realm}`, 'reply.place');
      const draft = await command<{ revisionId: string; revisionDigest: string }>(writer.page, 'POST', '/member-reply-drafts', {
        profile: 'member-reply-draft-v1', reply, variantId, rootTarget: work.work, rootRevision: work.workRevision,
        originRealm: realm.realm, language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: writer.actor,
      });
      await command(writer.page, 'POST', '/realm-replies', { profile: 'realm-reply-identity-v1', reply, variantId,
        revisionId: draft.revisionId, author: writer.actor, rootTarget: work.work, rootRevision: work.workRevision,
        parentReply: null, parentRevision: null, contextRevision: null });
      await command(writer.page, 'POST', '/realm-reply-placements', { profile: 'realm-reply-placement-v1', realm: realm.realm,
        reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
        reviewDecisionId: null, expectedHead: null, actingSubject: writer.actor });
      return reply;
    }

    // Platform designation uses the public grant API; Realm ownership never substitutes for platform authority.
    const admin = await platformAdministratorSession();
    await grantPlatformResource(admin, owner.principalId, 'governance.rule.publish', 'governance:platform');
    await grantPlatformResource(admin, owner.principalId, 'governance.moderate', 'governance:platform');
    const rule = await command<{ ref: string; revision: string; digest: string }>(owner.page, 'POST', '/governance/rules', {
      profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform',
      actingSubject: owner.actor, expectedRevision: null, document: { rule: 'Close only the reviewed Realm record.' },
      idempotencyKey: randomUUID(),
    });
    let decision: { id: string; input: Record<string, unknown>; head: string; caseId: string } | undefined;
    async function restrict() {
      const header = await command<{ revision: string }>(owner.page, 'GET', `/realms/${short(closed.realm)}?${subject(owner.actor)}`);
      const report = await command<{ reportId: string; caseId: string }>(owner.page, 'POST', '/public-reports', {
        profile: 'public-report-v1', actingSubject: owner.actor, target: closed.realm,
        category: 'spam_or_manipulation', contentLanguage: 'en', statement: 'Review this Realm record only.',
      });
      await command(owner.page, 'POST', `/safety-cases/${report.caseId}/claim`, {
        actingSubject: owner.actor, idempotencyKey: randomUUID(),
      });
      const safety = await command<{ generation: string; reports: { evidenceDigest: string }[] }>(owner.page,
        'GET', `/safety-cases/${report.caseId}?${subject(owner.actor)}`);
      const input = { profile: 'moderation-decision-v1', caseId: report.caseId, expectedGeneration: safety.generation,
        actingSubject: owner.actor, outcome: 'restrict', targets: [{ owner: 'graph', resource: closed.realm, component: 'record',
          locator: null, scopeKind: 'component', revision: null, expectedHead: header.revision, effect: 'disclosure' }],
        rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest }, evidenceDigest: safety.reports[0]!.evidenceDigest,
        reversesDecisionId: null, answersStepId: null, rationale: 'Close only this Realm.', disclosure: 'parties',
        reasons: { facts: 'The exact record was reviewed.', scope: 'This Realm record only.', duration: 'Until restored.',
          automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
        idempotencyKey: randomUUID() };
      const result = await command<{ decisionId: string; operation: { status: string } }>(owner.page, 'POST', '/moderation/decisions', input);
      expect(result.operation.status).toBe('completed');
      decision = { id: result.decisionId, input, head: header.revision, caseId: report.caseId };
      const response = await owner.page.request.get(`/api/main/v1/realms/${short(closed.realm)}?${subject(owner.actor)}`);
      expect(response.status(), await response.text()).toBe(404);
    }
    async function restore() {
      if (!decision) throw new Error('Restore needs a completed closure decision');
      await command(owner.page, 'POST', `/safety-cases/${decision.caseId}/claim`, {
        actingSubject: owner.actor, idempotencyKey: randomUUID(),
      });
      const safety = await command<{ generation: string }>(owner.page, 'GET', `/safety-cases/${decision.caseId}?${subject(owner.actor)}`);
      const restored = await command<{ operation: { status: string } }>(owner.page, 'POST', '/moderation/decisions', {
        ...decision.input, expectedGeneration: safety.generation, outcome: 'restore',
        reversesDecisionId: decision.id, idempotencyKey: randomUUID(),
      });
      expect(restored.operation.status).toBe('completed');
    }
    async function image(target: string, context: string) {
      // An original one-pixel PNG, uploaded and screened by the production media owner.
      const bytes = originalPixel();
      await grantTo(writer, `media:owner:${writer.actor}`, 'media.upload');
      await grantTo(writer, `media:owner:${writer.actor}`, 'media.labels');
      await grantTo(writer, `content:publish:${target}`, 'media.use');
      const reservation = await command<{ upload: string; uploadUrl: string; asset: string }>(writer.page, 'POST', '/media/uploads', {
        profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), disclosure: 'public', actingSubject: writer.actor,
      });
      const upload = await writer.page.request.put(`/api/main${reservation.uploadUrl}`, {
        data: bytes, headers: { 'content-type': 'application/octet-stream' },
      });
      expect(upload.status(), await upload.text()).toBe(201);
      const activated = await upload.json() as { representation: string };
      await expect.poll(async () => (await command<{ clearance: string }>(writer.page, 'GET', `/media/uploads/${reservation.upload}`)).clearance,
        { timeout: 30_000 }).toBe('cleared');
      const use = await command<{ use: string }>(writer.page, 'POST', '/media/uses', {
        actingSubject: writer.actor, target, representation: activated.representation, occurrence: randomUUID(), context, conceal: false,
      });
      const metadata = await command<{ items: { controls: { nsfw: { basis: unknown; valueHead: string | null } } }[] }>(writer.page,
        'POST', '/media/metadata', { items: [{ representation: activated.representation, use: use.use }], actingSubject: writer.actor });
      const field = metadata.items[0]!.controls.nsfw;
      await command(writer.page, 'POST', `/media/representations/${activated.representation}/labels`, {
        actingSubject: writer.actor, field: 'nsfw', basis: field.basis, expectedValueHead: field.valueHead,
        value: 'sfw', mode: 'edit', authority: 'author',
      });
      return { representation: activated.representation, use: use.use };
    }
    return { owner, writer, closed, live, work, publish, reply, image, restrict, restore,
      close: () => Promise.all(contexts.map(context => context.close())) };
  } catch (error) { await Promise.all(contexts.map(context => context.close())); throw error; }
}

export function imageDocument(title: string, images: { representation: string; use: string; alt: string }[]) {
  const document = fromPlainText(title, 'blocks');
  return normalizeDocument({ ...document, doc: { ...document.doc, content: [...document.doc.content!, ...images.map(image => ({
    type: 'image', attrs: { id: randomUUID(), src: `/api/main/v1/media/uses/${image.use}`,
      representationId: image.representation, mediaUseId: image.use, alt: image.alt },
  }))] } });
}
