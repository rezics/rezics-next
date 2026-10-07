import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { realmVisibilityFixture } from './realm-visibility-fixture.ts';
import { createMainApp } from '../src/app.ts';
import { AccessRealmManagement } from '../src/modules/access/realm-management.ts';
import { withRealmPermit } from '../src/modules/access/realm-management-policy.ts';
import { pendingRealmPolicies, settleRealmPolicy } from '../src/modules/access/realm-management-recovery.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { RealmAdminDenied, RealmAdminStale, RealmAdminUnavailable } from '../src/modules/realm-admin/contract.ts';
import { deliverRealmPolicy, policyHead, readRealmPolicy, type RealmPolicyDelivery } from '../src/modules/space/policy.ts';
import { spaceCreationReceiptIri } from '../src/modules/space/create.ts';
import { RealmSelectionUnavailable, selectRealmLocal, type SelectRealmLocalInput } from '../src/modules/work/select-realm.ts';
import { DATASET, GRAPHS, RV, hash, iri } from '../src/modules/work/activate.ts';

test('Realm publication receipts survive lost Access acknowledgement and preserve legacy delivery bytes under current authority', async () => {
  const s = await startMediaStack('realm-policy-revision');
  try {
    const creator = await s.member('controller');
    const steward = await s.member('steward');
    await creator.grant('space:create:root', 'space.create');
    await creator.grant(`agent:control:${creator.actor}`, 'agent.control');
    const admin = new AccessRealmManagement(s.accessPool);
    const app = createMainApp(s.fuseki, { environment: s.env, access: s.access, realmAdmin: admin,
      account: { verify: async () => creator.principal } });
    const settings = { visibility: 'public' as const, reviewRequired: false, reviewMode: 'open' as const,
      whoMaySubmit: 'granted' as const, selfJoin: false, rules: [] };
    const creationKey = randomUUID();
    const body = { profile: 'space-realm-v2', name: `Receipt Realm ${randomUUID()}`,
      handle: `receipt-${randomUUID().slice(0, 8)}`, capabilities: ['realm'],
      actingSubject: creator.actor, initialSettings: settings };
    const create = () => app.handle(new Request('http://main.test/v1/spaces', { method: 'POST',
      headers: { authorization: `Bearer ${creator.token}`, 'content-type': 'application/json',
        'idempotency-key': creationKey }, body: JSON.stringify(body) }));
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await response.json() as { realm: string; space: string };
    const realm = created.realm, scope = `governance:realm:${realm}`;
    const initial = spaceCreationReceiptIri(created.space.slice(-36));
    const permit = () => withRealmPermit(s.accessPool, creator.principal, creator.actor, realm, 'submission', async p => p);
    expect((await readRealmPolicy(s.env, realm))?.revision).toBe(initial);
    expect((await permit()).revision).toBe(initial);
    expect((await create()).status).toBe(200);
    const input = { actingSubject: creator.actor, expectedGeneration: '1', expectedRulesRevision: '1',
      reason: 'Publish member policy', settings: { ...settings, reviewMode: 'trusted-members' as const } };
    const key = randomUUID();
    const changed = await admin.changeSettings(creator.principal, realm, input, key, s.env);
    const head = policyHead(changed.receiptId);
    expect(head).toMatch(/^urn:rezics:receipt:[0-9a-f]{64}$/);
    expect((await readRealmPolicy(s.env, realm))?.revision).toBe(head);
    expect((await permit()).revision).toBe(head);
    expect((await s.accessPool.query('SELECT policy_head FROM access.realm_policy_delivery WHERE realm=$1', [realm]))
      .rows[0]!.policy_head).toBe(head);
    const sequence = async () => (await s.fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`, 1024)).results!.bindings[0]!.n!.value;
    const position = await sequence();
    expect(await admin.changeSettings(creator.principal, realm, input, key, s.env)).toMatchObject({ ...changed, replayed: true });
    expect(await sequence()).toBe(position);

    // A failure recording the Access acknowledgement leaves the committed
    // graph receipt recoverable and every fresh permit unavailable.
    await s.accessPool.query(`CREATE FUNCTION access.fail_policy_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected acknowledgement loss'; END $$;
      CREATE TRIGGER fail_policy_ack BEFORE UPDATE OF delivered ON access.realm_policy_delivery
        FOR EACH ROW WHEN (NEW.delivered) EXECUTE FUNCTION access.fail_policy_ack()`);
    const nextInput = { ...input, expectedGeneration: changed.generation, expectedRulesRevision: '2',
      settings: { ...settings } };
    const nextKey = randomUUID();
    try {
      await expect(admin.changeSettings(creator.principal, realm, nextInput, nextKey, s.env))
        .rejects.toBeInstanceOf(RealmAdminUnavailable);
      await expect(permit()).rejects.toBeInstanceOf(AdmissionUnavailable);
    } finally {
      await s.accessPool.query('DROP TRIGGER fail_policy_ack ON access.realm_policy_delivery; DROP FUNCTION access.fail_policy_ack()');
    }
    const pending = (await pendingRealmPolicies(s.accessPool)).items.find(item => item.realm === realm)!;
    expect(pending.policy_head).toBe(policyHead(pending.receipt_id));
    expect((await readRealmPolicy(s.env, realm))?.revision).toBe(pending.policy_head);
    const afterCommit = await sequence();
    const settled = await Promise.all([settleRealmPolicy(s.accessPool, realm, s.env), settleRealmPolicy(s.accessPool, realm, s.env)]);
    expect(settled.sort()).toEqual([false, true]);
    expect(await sequence()).toBe(afterCommit);
    expect(await admin.changeSettings(creator.principal, realm, nextInput, nextKey, s.env))
      .toMatchObject({ receiptId: pending.receipt_id, generation: '3', replayed: true });
    expect((await permit()).revision).toBe(pending.policy_head ?? null);

    // Seed an old ordinary publication using its original intent bytes. The
    // migration's NULL column must retain that receipt for permits and recovery.
    const { policy_head: _newHead, ...legacy } = pending;
    const legacyHead = `urn:rezics:realm-policy:${legacy.receipt_id}`;
    await deliverRealmPolicy(s.env, legacy);
    await s.accessPool.query('UPDATE access.realm_policy_delivery SET policy_head=NULL WHERE realm=$1', [realm]);
    expect((await readRealmPolicy(s.env, realm))?.revision).toBe(legacyHead);
    expect((await permit()).revision).toBe(legacyHead);
    const receiptQuery = `PREFIX rv: <${RV}> SELECT ?p ?o WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(legacyHead)} ?p ?o } } ORDER BY ?p ?o`;
    const legacyBytes = await s.fuseki.query(receiptQuery, 8192);
    expect((await s.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(legacyHead)} rv:requestDigest "${hash(JSON.stringify(legacy))}" } }`, 1024)).boolean).toBe(true);
    const legacyPosition = await sequence();
    await s.accessPool.query('UPDATE access.realm_policy_delivery SET delivered=false WHERE realm=$1', [realm]);
    await expect(permit()).rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(await settleRealmPolicy(s.accessPool, realm, s.env)).toBe(true);
    expect(await sequence()).toBe(legacyPosition);
    expect(await s.fuseki.query(receiptQuery, 8192)).toEqual(legacyBytes);
    expect((await permit()).revision).toBe(legacyHead);

    // Replays still require live stewardship and a current represented Agent.
    await s.accessPool.query(`UPDATE access.permission_grant SET active=false,generation=generation+1
      WHERE recipient_subject=$1 AND scope_id=$2 AND action='realm.settings.manage'`, [creator.actor, scope]);
    await expect(admin.changeSettings(creator.principal, realm, nextInput, nextKey, s.env))
      .rejects.toBeInstanceOf(RealmAdminDenied);
    for (const action of ['realm.settings.manage', 'governance.rule.publish']) await steward.grant(scope, action);
    const stewardInput = { ...nextInput, actingSubject: steward.actor, expectedGeneration: '3', expectedRulesRevision: '3' };
    const stewardKey = randomUUID();
    const stewardWrite = await admin.changeSettings(steward.principal, realm, stewardInput, stewardKey, s.env);
    expect((await readRealmPolicy(s.env, realm))?.revision).toBe(policyHead(stewardWrite.receiptId));
    await expect(admin.changeSettings(steward.principal, realm, stewardInput, randomUUID(), s.env))
      .rejects.toBeInstanceOf(RealmAdminStale);
    const spaceWrite = await admin.changeSpaceSettings(steward.principal, created.space, {
      actingSubject: steward.actor, expectedGeneration: stewardWrite.generation, reason: 'Unlist Realm',
      settings: { visibility: 'public', listing: 'unlisted', history: 'everything', admission: 'invitation' },
    }, randomUUID(), s.env);
    expect((await readRealmPolicy(s.env, realm))?.revision).toBe(policyHead(spaceWrite.receiptId));
    await s.accessPool.query('UPDATE access.representation SET active=false,generation=generation+1 WHERE principal_id=$1', [steward.principalId]);
    await expect(admin.changeSettings(steward.principal, realm, stewardInput, stewardKey, s.env))
      .rejects.toBeInstanceOf(RealmAdminDenied);
    expect(await s.fuseki.query(receiptQuery, 8192)).toEqual(legacyBytes);
  } finally { await s.stop(); }
}, 180_000);

test('native policy selection retains legacy pins, adopts canonical receipt pins and denies stale policy authority', async () => {
  const h = await realmVisibilityFixture();
  try {
    const publication = await h.policy('public', 'open');
    const head = policyHead(publication.body.receiptId);
    expect((await readRealmPolicy(h.env, h.realm))?.revision).toBe(head);
    const first = await h.submit();
    expect(first.result.body.submission.state, JSON.stringify(first.result)).toBe('accepted');
    const pin = async (selection: string) => (await h.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(selection)} rv:realmPolicyHead ?head } }`, 1024))
      .results!.bindings[0]!.head!.value;
    expect(await pin(first.result.body.submission.selection)).toBe(head);

    const legacy = (await h.accessPool.query<RealmPolicyDelivery>(`SELECT realm,receipt_id,generation::text,
      visibility,review_mode,listing,history,admission FROM access.realm_policy_delivery WHERE realm=$1`, [h.realm])).rows[0]!;
    await deliverRealmPolicy(h.env, legacy);
    await h.accessPool.query('UPDATE access.realm_policy_delivery SET policy_head=NULL WHERE realm=$1', [h.realm]);
    const legacyHead = `urn:rezics:realm-policy:${legacy.receipt_id}`;
    const old = await h.submit();
    expect(old.result.body.submission.state, JSON.stringify(old.result)).toBe('accepted');
    expect(await pin(old.result.body.submission.selection)).toBe(legacyHead);
    const candidate = await h.contribution('Stale policy selection', h.actor);
    const input: SelectRealmLocalInput = { context: { kind: 'realm-local', id: h.realm }, work: h.work.work,
      mainVersion: h.work.mainVersion, contribution: candidate.contribution,
      publicationDecision: candidate.publicationDecision, expectedSelectionHead: old.result.body.submission.selection,
      selectionBasis: 'realm-policy', policy: { revision: legacyHead, mode: 'open' }, actingSubject: h.actor };
    const intent = { principal: h.principal, actingSubject: h.actor, action: 'submission.submit',
      scope: `submission:submit:${h.realm}`, idempotencyKey: randomUUID(), requestDigest: hash(JSON.stringify(input)) };
    const registered = await h.access.register(intent);
    const claimed = await h.access.claim(registered.id, registered.requestDigest, h.principal);
    await h.policy('public', 'trusted-members');
    // Submission remains authorized by its native grant; adoption must still
    // reject the prior policy pin after the Realm publishes a new receipt.
    await expect(selectRealmLocal(h.env, claimed, input)).rejects.toBeInstanceOf(RealmSelectionUnavailable);
    expect(await pin(old.result.body.submission.selection)).toBe(legacyHead);
    expect(await pin(first.result.body.submission.selection)).toBe(head);
    const fresh = await h.submit();
    expect(fresh.result.body.submission.state, JSON.stringify(fresh.result)).toBe('accepted');
    expect(await pin(fresh.result.body.submission.selection)).toBe((await readRealmPolicy(h.env, h.realm))!.revision!);
  } finally { await h.close(); }
}, 180_000);
