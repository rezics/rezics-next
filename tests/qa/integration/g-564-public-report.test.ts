import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { GovernanceStore, sha256 } from '../../../services/main/src/modules/governance/store.ts';
import { PublicReports, mintPartyCredential } from '../../../services/main/src/modules/public-report/store.ts';
import { publicReportOwners } from '../../../services/main/src/modules/public-report/owners.ts';
import { PLATFORM_SCOPE, SPECIALIST_ACTION, addBusinessDays } from '../../../services/main/src/modules/public-report/contract.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { applyContentErasure, ContentErasureStale } from '../../../services/main/src/modules/erasure/content.ts';
import { recordAccountPreservation } from '../../../services/main/src/modules/public-report/preservation.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { completePendingContentErasures, contentErasureDigest, ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { journalErasure, readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { settleAccountErasures } from '../../../services/main/src/modules/erasure/account.ts';
import { mirrorAccountDeletionIntent } from '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

interface Receipt { reportId: string; caseId: string; credential: string; receivedAt: string; replayed: boolean }
interface Step { id: string; kind: string; dueAt: string | null; occurredAt: string; contentLanguage: string | null;
  statement: string | null }
interface Status { receivedAt: string; contentLanguage: string; steps: Step[]; nextCursor: string | null }

test('G-564: public API intake, private correspondence, legal deadlines, urgent evidence and preservation', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run with the QA integration tier');
  const preparation = Date.now();
  const directory = `.temp/g-564-${randomUUID()}`;
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content', 'relay']);
  const apps = { ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account,
    ACCESS_DATABASE_URL: databases.urls.access, CONTENT_DATABASE_URL: databases.urls.content } as Record<string, string>;
  const preservationPool = new Pool({ connectionString: databases.urls.access });
  const relayPool = new Pool({ connectionString: databases.urls.relay });
  const f = await authorCreditFixture(apps, directory,
    'openid work:create work:read work:edit space:create agent:create governance:report governance:decide access:manage',
    async (issuer, subject) => {
      const fence = await new AccessAdmissionRegistry(preservationPool).strongDeactivateAccountSubject(issuer, subject);
      if (fence) await mirrorAccountDeletionIntent(preservationPool, relayPool, fence.principalId, fence.enforcementEpoch);
      await retainAccountSubjectDeletion(relayPool, issuer, subject);
    });
  const accountPool = new Pool({ connectionString: databases.urls.account });
  try {
    const core = new ContentCore(f.pool);
    const deps: MainWorkDependencies = { environment: f.env, access: f.access, account: f.account.verifier,
      content: core, contentAuthoring: core, agentProvisioning: new AgentProvisioning(f.accessPool, f.env) };
    deps.publicReports = new PublicReports(f.accessPool, publicReportOwners(deps, f.pool, core));
    deps.erasures = new ErasureService(relayPool, f.pool, f.accessPool);
    deps.governance = { store: new GovernanceStore(f.accessPool,
      ownerEvidenceCapture({ graph: { env: f.env, canReadWork: async () => true } }),
      ownerTargetHeads({ graph: f.env, content: f.pool }), { current: async () => null }) };
    const app = createMainApp(f.env.fuseki, deps);
    const call = (method: string, path: string, body?: unknown, options: { key?: string; secret?: string; token?: string } = {}) =>
      app.handle(new Request(`http://main.test${path}`, { method, headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.secret ? { 'x-rezics-case-credential': options.secret } : {}),
        ...(method === 'POST' ? { 'idempotency-key': options.key ?? randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(response: Response, status: number): Promise<T> => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    const work = await json<{ work: string; workRevision: string; mainVersion: string; mainRevision: string }>(await call('POST', '/v1/works', {
      profile: 'metadata-only-v1', language: 'en', title: `Reported resource ${randomUUID()}`,
      semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor }, { token: f.account.tokenA }), 201);
    await f.grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'Published reported text',
      actingSubject: f.actor }, { token: f.account.tokenA }), 201);
    await f.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await f.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const publication = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: f.actor }, { token: f.account.tokenA }), 201);
    await f.grant(`publication:select:${work.mainVersion}`, 'publication.select');
    await json(await call('POST', '/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion }, expectedSelectionHead: null,
      work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      selectionBasis: 'main-maintainer', actingSubject: f.actor }, { token: f.account.tokenA }), 201);
    const base = { profile: 'public-report-v1', target: work.work, category: 'harassment',
      statement: 'Reported context in Kiswahili', contentLanguage: 'sw-KE' };
    const key = randomUUID();
    const first = await json<Receipt>(await call('POST', '/v1/public-reports', base, { key }), 201);
    const replay = await json<Receipt>(await call('POST', '/v1/public-reports', base, { key }), 200);
    expect(replay).toMatchObject({ reportId: first.reportId, caseId: first.caseId, replayed: true });
    expect(replay.credential).not.toBe(first.credential);
    expect((await f.accessPool.query('SELECT id FROM access.governance_report WHERE public_receipt_hash = $1',
      [sha256(key)])).rows).toHaveLength(1);
    expect((await f.accessPool.query('SELECT secret_hash FROM access.governance_case_credential WHERE report_id = $1',
      [first.reportId])).rows.map(row => row.secret_hash).sort())
      .toEqual([sha256(first.credential), sha256(replay.credential)].sort());
    expect((await call('POST', '/v1/public-reports', { ...base, statement: 'Different report' }, { key })).status).toBe(409);
    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([call('POST', '/v1/public-reports', base, { key: concurrentKey }),
      call('POST', '/v1/public-reports', base, { key: concurrentKey })]);
    expect(concurrent.map(item => item.status).sort()).toEqual([200, 201]);
    const status = (receipt: Receipt, secret = receipt.credential) => call('GET', `/v1/public-reports/${receipt.caseId}`,
      undefined, { secret }).then(response => json<Status>(response, 200));
    expect((await status(first)).contentLanguage).toBe('sw-KE');
    await json<Receipt>(await call('POST', '/v1/public-reports', { ...base, target: draft.contribution }), 201);
    const wrong = await call('GET', `/v1/public-reports/${first.caseId}`, undefined, { secret: 'a'.repeat(43) });
    const missing = await call('GET', `/v1/public-reports/${randomUUID()}`, undefined, { secret: 'a'.repeat(43) });
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get('cache-control')).toBe('no-store');
    expect(await wrong.json()).toEqual(await missing.json());
    const message = { kind: 'message', statement: 'Ufafanuzi wa taarifa', contentLanguage: 'sw-KE' };
    const correspond = (receipt: Receipt, body: unknown, secret = receipt.credential, key = randomUUID()) =>
      call('POST', `/v1/public-reports/${receipt.caseId}/correspondence`, body, { secret, key });
    await json(await correspond(first, message), 200);
    expect((await status(first)).steps.some(step => step.statement === message.statement && step.contentLanguage === 'sw-KE')).toBe(true);
    const signed = await json<Receipt>(await call('POST', '/v1/public-reports', base, { token: f.account.tokenA }), 201);
    const own = await json<{ reports: Array<{ reportId: string }> }>(await call('GET', '/v1/public-reports/mine',
      undefined, { token: f.account.tokenA }), 200);
    expect(own.reports.map(report => report.reportId)).toContain(signed.reportId);
    expect(own.reports.map(report => report.reportId)).not.toContain(first.reportId);

    const ncii = await json<Receipt>(await call('POST', '/v1/public-reports', { ...base, category: 'ncii',
      contactEmail: 'safe@example.test', ncii: { signature: 'Depicted person', depictedPersonOrAuthorized: true,
        goodFaithWithoutConsent: true, supportingInformation: 'Publication was without consent' } }), 201);
    const before = await status(ncii);
    const deadline = before.steps.find(step => step.kind === 'removal_deadline')!;
    expect(Date.parse(deadline.dueAt!) - Date.parse(ncii.receivedAt)).toBe(48 * 3600_000);
    await json(await correspond(ncii, message), 200);
    const after = await status(ncii);
    expect(after.receivedAt).toBe(before.receivedAt);
    expect(after.steps.find(step => step.kind === 'removal_deadline')).toEqual(deadline);
    await expect(f.accessPool.query('UPDATE access.governance_report SET received_at = now() WHERE id = $1',
      [ncii.reportId])).rejects.toThrow();
    await expect(f.accessPool.query('UPDATE access.governance_process_step SET due_at = now() WHERE id = $1',
      [deadline.id])).rejects.toThrow();
    const unsupported = await call('POST', '/v1/public-reports', { ...base, category: 'arbitrary' });
    expect(unsupported.status).toBe(400);
    const incomplete = await call('POST', '/v1/public-reports', { ...base, category: 'copyright' });
    expect(incomplete.status).toBe(400);
    const copyright = await json<Receipt>(await call('POST', '/v1/public-reports', { ...base, category: 'copyright',
      contactEmail: 'rights@example.test', copyright: { signature: 'Claimant', claimantName: 'Claimant',
        claimantAddress: '123 Test Street', claimantPhone: '+1 555 555 5555', claimedWork: 'Original text',
        materialLocation: work.work, goodFaith: true, accurateAndAuthorizedUnderPerjury: true } }), 201);
    expect((await f.accessPool.query('SELECT process FROM access.rights_complaint WHERE report_id = $1',
      [copyright.reportId])).rows).toEqual([{ process: 'dmca_512' }]);
    const client = await f.accessPool.connect();
    let affected: string;
    try { affected = await mintPartyCredential(client, copyright.caseId, copyright.reportId); }
    finally { client.release(); }
    const counter = { kind: 'counter_notice', statement: 'The removed text was misidentified', contentLanguage: 'fa',
      counterNotice: { signature: 'Uploader', materialLocation: work.work, goodFaithMistakeUnderPerjury: true,
        name: 'Uploader', address: '123 Test Street', phone: '+1 555 555 5555', courtJurisdiction: 'District of Delaware',
        consentToJurisdiction: true, acceptService: true } };
    expect((await correspond(copyright, counter)).status).toBe(404);
    const counterKey = randomUUID();
    await json(await correspond(copyright, counter, affected, counterKey), 200);
    await json(await correspond(copyright, counter, affected, counterKey), 200);
    const counterStatus = await status(copyright, affected);
    const earliest = counterStatus.steps.find(step => step.kind === 'restoration_not_before')!;
    const latest = counterStatus.steps.find(step => step.kind === 'restoration_not_after')!;
    expect(earliest.dueAt).toBe(addBusinessDays(new Date(earliest.occurredAt), 10).toISOString());
    expect(latest.dueAt).toBe(addBusinessDays(new Date(latest.occurredAt), 14).toISOString());
    expect([0, 6]).not.toContain(new Date(earliest.dueAt!).getUTCDay());
    expect(counterStatus.steps.filter(step => step.kind === 'counter_notice')).toHaveLength(1);
    expect((await status(copyright)).steps.some(step => step.kind === 'counter_notice')).toBe(false);
    await json(await correspond(copyright, { kind: 'appeal', statement: 'Please review', contentLanguage: 'x-private' }, affected), 200);

    // Urgent anchors are never returned to general deciders or Realm moderators.
    await f.grant(PLATFORM_SCOPE, 'governance.moderate');
    const reportRead = () => call('GET', `/v1/reports/${ncii.reportId}?actingSubject=${encodeURIComponent(f.actor)}`,
      undefined, { token: f.account.tokenA });
    expect((await reportRead()).status).toBe(404);
    const legacyKey = randomUUID();
    const legacyBody = { profile: 'content-report-v1', actingSubject: f.actor,
      authority: { kind: 'platform', scopeId: PLATFORM_SCOPE }, context: 'urn:rezics:context:global',
      target: { owner: 'graph', resource: work.work, component: 'title' }, disclosure: 'private',
      reasonCode: 'harassment', statement: 'Legacy intake also keeps urgent anchors private',
      evidence: [{ owner: 'graph', resource: work.work, component: 'title', revision: work.workRevision, locator: null }],
      idempotencyKey: legacyKey };
    const legacy = await json<{ evidence: unknown[] }>(await call('POST', '/v1/reports', legacyBody,
      { token: f.account.tokenA, key: legacyKey }), 201);
    expect(legacy.evidence).toEqual([]);
    const legacyReplay = await json<typeof legacy>(await call('POST', '/v1/reports', legacyBody,
      { token: f.account.tokenA, key: legacyKey }), 200);
    expect(legacyReplay.evidence).toEqual([]);
    await f.grant(PLATFORM_SCOPE, SPECIALIST_ACTION);
    const specialist = await json<{ evidence: Array<{ revision: string }> }>(await reportRead(), 200);
    expect(specialist.evidence[0]!.revision).toBe(work.workRevision);

    const person = await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Reported author' }, { token: f.account.tokenA }), 201);
    await json<Receipt>(await call('POST', '/v1/public-reports', { ...base, target: person.agent }), 201);
    await f.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: `Reported Realm ${randomUUID()}`, capabilities: ['realm'], actingSubject: f.actor },
    { token: f.account.tokenA }), 201);
    await json<Receipt>(await call('POST', '/v1/public-reports', { ...base, target: realm.realm }), 201);
    await f.grant(`governance:realm:${realm.realm}`, 'governance.moderate');
    await json<Receipt>(await call('POST', '/v1/public-reports', { ...base, target: realm.realm,
      category: 'realm_rules', realm: realm.realm }), 201);
    const moderator = `https://rezics.com/id/${randomUUID()}`;
    await f.accessPool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [moderator]);
    await f.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'governance.moderate',now() + interval '1 hour')`, [randomUUID(), f.otherPrincipal, moderator]);
    await f.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'governance.moderate',now() + interval '1 hour')`,
    [randomUUID(), moderator, `governance:realm:${realm.realm}`]);
    expect((await call('GET', `/v1/reports/${ncii.reportId}?actingSubject=${encodeURIComponent(moderator)}`,
      undefined, { token: f.account.tokenB })).status).toBe(404);

    for (let index = 0; index < 51; index++) await json(await correspond(first,
      { ...message, statement: `Private clarification ${index}` }), 200);
    const bounded = await status(first);
    expect(bounded.steps).toHaveLength(50);
    expect(bounded.nextCursor).not.toBeNull();
    const continuation = await json<Status>(await call('GET',
      `/v1/public-reports/${first.caseId}?cursor=${bounded.nextCursor}`, undefined, { secret: first.credential }), 200);
    expect(continuation.steps).toHaveLength(3);
    expect(continuation.nextCursor).toBeNull();

    const mediaStore = new MediaStore(f.pool, core);
    const bytesDigest = sha256('media bytes');
    const media = await mediaStore.reserveUpload({ admissionId: randomUUID(), principalId: f.principalId,
      actingSubject: f.actor, authorityEpoch: '0', requestDigest: sha256(randomUUID()) },
    { asset: null, mediaType: 'image/png', byteLength: 32, sha256: bytesDigest, disclosure: 'public' });
    await mediaStore.settleUpload(media.upload, { status: 'activated', sha256: bytesDigest,
      byteLength: 32, mediaType: 'image/png', width: 1, height: 1 });
    const activated = await mediaStore.recordAssetRevision(media.upload);
    const resource = `https://rezics.com/id/${media.asset}`;
    await json<Receipt>(await call('POST', '/v1/public-reports', { ...base,
      target: `https://rezics.com/media/assets/${media.asset}` }), 201);
    const child = await json<Receipt>(await call('POST', '/v1/public-reports', { ...base,
      target: resource, category: 'child_exploitation' }), 201);
    expect((await f.accessPool.query('SELECT author_subject, account_subject FROM access.governance_preservation_hold WHERE case_id = $1',
      [child.caseId])).rows).toEqual([{ author_subject: f.actor, account_subject: f.account.a.id }]);
    await expect(applyContentErasure(f.pool, { erasureId: randomUUID(), erasureEpoch: '1', resourceId: resource,
      revisionIds: [activated.revision], preservationAccess: f.accessPool })).rejects.toBeInstanceOf(ContentErasureStale);
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id = $1', [activated.revision])).rows)
      .toEqual([{ availability: 'available' }]);
    await f.grant(`erasure:${resource}`, 'erasure.request');
    const eraseKey = randomUUID();
    const erasureBody = { profile: 'content-revision-erasure-v1', actingSubject: f.actor,
      resourceId: resource, revisionIds: [activated.revision] };
    // Recovery must honour the intake hold before any HTTP erasure initializes a service.
    const principal = await f.account.verifier.verify(new Request('http://main.test/v1/erasures',
      { headers: { authorization: `Bearer ${f.account.tokenA}` } }), ['access:manage']);
    const digest = contentErasureDigest({ actingSubject: f.actor, resourceId: resource, revisionIds: [activated.revision] });
    const admission = await f.access.register({ principal, actingSubject: f.actor, scope: `erasure:${resource}`,
      action: 'erasure.request', idempotencyKey: eraseKey, requestDigest: digest });
    await f.access.claim(admission.id, digest);
    const pending = await journalErasure(relayPool, { operationId: `erasure:${admission.id}`, requestDigest: digest,
      kind: 'revision', principalId: admission.principalId, admissionId: admission.id,
      authorityEpoch: admission.authorityEpoch, targets: [{ kind: 'content_revision', ref: activated.revision }] });
    expect(await completePendingContentErasures(deps.erasures, f.env, f.access)).toEqual({ completed: 1, failed: [] });
    expect((await readErasure(relayPool, pending.erasureId)).stage).toBe('blocked');
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id = $1', [activated.revision])).rows)
      .toEqual([{ availability: 'available' }]);
    const held = await json<{ erasureId: string; stage: string; blockedReason: string; replayed: boolean }>(
      await call('POST', '/v1/erasures', erasureBody, { key: eraseKey, token: f.account.tokenA }), 200);
    expect(held.stage).toBe('blocked');
    expect(held.blockedReason).toBe('Erasure is deferred');
    expect((await f.accessPool.query('SELECT reason FROM access.governance_erasure_postponement WHERE operation_id = $1',
      [held.erasureId])).rows).toEqual([{ reason: 'child_exploitation' }]);
    const heldReplay = await json<typeof held>(await call('POST', '/v1/erasures', erasureBody,
      { key: eraseKey, token: f.account.tokenA }), 200);
    expect(heldReplay).toMatchObject({ erasureId: held.erasureId, stage: 'blocked', replayed: true,
      blockedReason: held.blockedReason });
    // Every deferred erasure has the same public explanation, including retained inventories.
    await relayPool.query("UPDATE relay.erasure SET blocked_reason = 'internal unrelated deferred reason' WHERE id = $1",
      [held.erasureId]);
    const unrelated = await json<typeof held>(await call('GET', `/v1/erasures/${held.erasureId}`,
      undefined, { token: f.account.tokenA }), 200);
    expect({ ...unrelated, replayed: true }).toEqual(heldReplay);
    expect(await json<typeof held>(await call('POST', '/v1/erasures', erasureBody,
      { key: eraseKey, token: f.account.tokenA }), 200)).toEqual(heldReplay);
    await recordAccountPreservation(f.accessPool, f.account.issuer, f.account.a.id, 'account-erasure-test');
    expect((await f.accessPool.query('SELECT reason FROM access.governance_erasure_postponement WHERE operation_id = $1',
      ['account-erasure-test'])).rows).toEqual([{ reason: 'child_exploitation' }]);

    // Account rejects this still-valid token after a suspension, while intake continues.
    await accountPool.query(`UPDATE rezics_account_security SET suspended_at = now(), generation = generation + 1
      WHERE user_id = $1`, [f.account.a.id]);
    const suspended = await json<Receipt>(await call('POST', '/v1/public-reports', base, { token: f.account.tokenA }), 201);
    expect((await f.accessPool.query('SELECT principal_id FROM access.governance_report WHERE id = $1',
      [suspended.reportId])).rows).toEqual([{ principal_id: null }]);

    // Existing disabled governance choices cannot suppress mandatory case notices.
    await f.accessPool.query(`INSERT INTO access.notification_preference (principal_id, purpose, topic, channel, state, revision)
      VALUES ($1, 'governance', 'moderation-outcome', 'inbox', 'disabled', 1)`, [f.principalId]);
    const notice = await new NotificationStore(f.accessPool).enqueue({ sourceOwner: 'access', sourceEvent: randomUUID(),
      purpose: 'governance', topic: 'moderation-outcome', subject: { owner: 'access', ref: child.caseId, revision: null },
      recipients: [f.principalId], disclosureBasis: 'private-case-party' });
    expect(notice).toHaveLength(1);
    await accountPool.query(`UPDATE rezics_account_security SET suspended_at = NULL, generation = generation + 1
      WHERE user_id = $1`, [f.account.a.id]);
    const accountBase = f.account.issuer.replace(/\/api\/auth$/, '');
    const deletion = await fetch(`${f.account.issuer}/delete-user`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: accountBase, cookie: f.account.a.cookie },
      body: JSON.stringify({ password: f.account.a.password }) });
    expect(deletion.status, await deletion.text()).toBe(200);
    expect((await accountPool.query('SELECT id FROM "user" WHERE id = $1', [f.account.a.id])).rowCount).toBe(0);
    expect(await settleAccountErasures(relayPool, f.accessPool, accountPool)).toBe(1);
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id = $1', [activated.revision])).rows)
      .toEqual([{ availability: 'available' }]);
    const erasedAccount = (await relayPool.query<{ id: string }>(
      "SELECT id FROM relay.erasure WHERE kind = 'account' AND account_subject = $1", [f.account.a.id])).rows[0]!;
    expect((await f.accessPool.query('SELECT reason FROM access.governance_erasure_postponement WHERE operation_id = $1',
      [erasedAccount.id])).rows).toEqual([{ reason: 'child_exploitation' }]);
    expect(Date.now() - preparation).toBeLessThan(600_000);
  } finally {
    await accountPool.end();
    await preservationPool.end();
    await relayPool.end();
    await f.close();
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
