import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';
import { VerificationCorrectionPublisher, verificationCorrectionSubjectReader }
  from '../../../services/main/src/modules/verification/correction-delivery.ts';
import { NotificationStore } from '../../../services/main/src/modules/notification/store.ts';
import { NotificationDispatcher } from '../../../services/main/src/modules/notification/dispatcher.ts';
import { FakeDeliveryProvider } from '../support/fake-delivery.ts';
import { startFakePaymentProvider } from '../support/fake-payment.ts';
import { CommerceStore, HttpPaymentProvider } from '../../../services/main/src/modules/commerce/store.ts';
import { ratingAccount } from '../support/rating-account.ts';

const id = () => `https://rezics.com/id/${Bun.randomUUIDv7()}`;
const short = (value: string) => value.split('/').at(-1)!;

test('FACT01/FACT02/FACT03/FACT04/FACT06: claim verification preserves origin, history and correction', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const apps = Bun.env as Record<string, string>;
  const account = await ratingAccount(apps, 'openid work:read subscription:manage notification:manage claim:create claim:read claim:evidence claim:lineage claim:reliability claim:assess claim:challenge');
  const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  const paymentSecret = 'claim-funding-test-secret';
  const paymentProvider = startFakePaymentProvider(paymentSecret);
  try {
    await migrateContent(contentPool);
    const nativeFuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    let loseGraphResponse = false;
    const fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const result = await target.commandWithReceipt(envelope);
        if (loseGraphResponse && envelope.update.includes('ClaimCreatedEvent')) {
          loseGraphResponse = false;
          throw new Error('lost graph acknowledgement after commit');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as FusekiClient;
    const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    const verification = new VerificationStore(contentPool);
    const notificationStore = new NotificationStore(accessPool);
    const deliveryProvider = new FakeDeliveryProvider();
    const dispatcher = new NotificationDispatcher(accessPool, deliveryProvider,
      { resolve: async () => ({ status: 'unavailable' }) }, { retryMs: 0 });
    dispatcher.registerSubjectReader('verification-correction-subscription-v1',
      verificationCorrectionSubjectReader(verification));
    const publisher = new VerificationCorrectionPublisher(verification, notificationStore);
    const commerce = new CommerceStore(accessPool, new HttpPaymentProvider(paymentProvider.url),
      reference => reference === 'claim:payment-callback' ? paymentSecret : undefined);
    const principal = randomUUID();
    const actor = id();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principal, account.issuer, account.a.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    const env = { fuseki, lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
      objectDirectory: '.temp' };
    const platformUse = async (recipient: string, subject: string) => {
      for (const group of ['wiki-agents', 'commerce', 'update-subscriptions']) {
        const grant = randomUUID();
        await accessPool.query(`INSERT INTO access.principal_permission_grant
          (id, issuer_subject, principal_id, scope_id, action, valid_until)
          VALUES ($1, $2, $3, 'platform:access', $4, 'infinity')`,
        [grant, subject, recipient, `platform:use:${group}`]);
        await accessPool.query(`INSERT INTO access.platform_grant_episode
          (id, principal_grant_id, issuer_subject, permission, scope_id, assigned_by_principal, receipt)
          VALUES ($1, $1, $2, $3, 'platform:access', $4, $5)`,
        [grant, subject, `platform:use:${group}`, recipient,
          `urn:rezics:access-receipt:${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`]);
      }
    };
    await platformUse(principal, actor);
    const app = createMainApp(fuseki, { environment: env, account: account.verifier, access,
      platformAccess: new AccessExposure(accessPool),
      verification, notifications: { store: notificationStore, dispatcher,
        providerSecrets: { fake: 'claim-test-provider-secret' } }, commerce });
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = account.tokenA) =>
      app.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const intent = { profile: 'claim-create-v1', referent: id(),
      interpretationContext: 'urn:rezics:context:verification-test',
      propositionPredicate: 'https://schema.org/datePublished',
      value: { kind: 'literal', lexical: '2026-09-27', datatype: 'date' },
      valuePrecision: 'exact', valueQualifiers: [], validFrom: null, validUntil: null,
      editionScope: null, actingSubject: actor };
    await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('verification:claim:global')");
    expect((await call('POST', '/v1/claims', intent, `token-${randomUUID()}`, account.noScope)).status).toBe(401);
    expect((await call('POST', '/v1/claims', intent, `denied-${randomUUID()}`)).status).toBe(403);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3,
      'verification.claim-create', now() + interval '1 hour')`, [randomUUID(), principal, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES
      ($1, $2, $2, 'verification:claim:global', 'verification.claim-create', now() + interval '1 hour')`,
    [randomUUID(), actor]);
    const key = `claim-${randomUUID()}`;
    loseGraphResponse = true;
    const createdResponse = await call('POST', '/v1/claims', intent, key);
    const created = await createdResponse.json() as { claim?: { claim: string; revision: string };
      operationId?: string; sourcePosition: { dataEpoch: string; sequence: string } };
    if (createdResponse.status !== 201) console.error('claim create', createdResponse.status, created);
    expect(createdResponse.status).toBe(201);
    expect(loseGraphResponse).toBe(false);
    expect(created.claim?.claim.startsWith('https://rezics.com/id/')).toBe(true);
    const replayResponse = await call('POST', '/v1/claims', intent, key);
    const replay = await replayResponse.json() as typeof created;
    expect(replayResponse.status).toBe(200);
    expect(replay.claim?.revision).toBe(created.claim?.revision);
    expect((await call('POST', '/v1/claims', { ...intent, value: { ...intent.value,
      lexical: '2026-09-28' } }, key)).status).toBe(409);
    const readResponse = await call('GET', `/v1/claims/${short(created.claim!.claim)}`);
    const read = await readResponse.json() as { claim: { revision: string; value: unknown } };
    expect(readResponse.status).toBe(200);
    expect(read.claim.revision).toBe(created.claim!.revision);
    expect(read.claim.value).toEqual(intent.value);

    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3, $4,
        now() + interval '1 hour')`, [randomUUID(), principal, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until) VALUES
        ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    await grant('verification:assess:global', 'verification.claim-assess');
    const records = [randomUUID(), randomUUID(), randomUUID()];
    const record = records[0]!;
    const observations = [randomUUID(), randomUUID(), randomUUID()];
    for (const sourceRecord of records) {
      await contentPool.query(`INSERT INTO source.record (id, provider, namespace, external_id)
        VALUES ($1, 'fixture', 'verification', $2)`, [sourceRecord, sourceRecord]);
    }
    for (const [index, observation] of observations.entries()) {
      await contentPool.query(`INSERT INTO source.observation
        (id, record_id, principal_id, media_type, retention, coverage, rights_evidence)
        VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
      [observation, records[index], principal]);
    }
    const originResponse = await call('POST', '/v1/verification/origins', {
      profile: 'verification-origin-v1', kind: 'publication', locator: 'https://original.example/release' });
    const originBody = await originResponse.json() as { origin?: string };
    if (originResponse.status !== 201) console.error('origin', originResponse.status, originBody);
    expect(originResponse.status).toBe(201);
    const origin = short(originBody.origin!);
    const firstLineage = await call('POST', `/v1/sources/observations/${observations[0]}/lineage`, {
      profile: 'verification-lineage-edge-v1', relation: 'publishes-origin', target: { origin },
      basis: 'declared-by-source', method: null });
    expect(firstLineage.status).toBe(201);
    const copied = await call('POST', `/v1/sources/observations/${observations[1]}/lineage`, {
      profile: 'verification-lineage-edge-v1', relation: 'copy-of', target: { observation: observations[0] },
      basis: 'detected', method: 'https://rezics.com/definition/fixture-copy-detector-v1' });
    expect(copied.status).toBe(201);
    const derived = await call('POST', `/v1/sources/observations/${observations[2]}/derivation`, {
      profile: 'verification-derivation-v1', kind: 'ai-generation',
      method: 'https://rezics.com/definition/fixture-ai-method-v1', model: 'fixture-model-1',
      toolVersion: '1', profileRevision: null, limitations: 'Generated from the copied observation.',
      inputs: [{ observation: observations[1] }] });
    expect(derived.status).toBe(201);
    const retainedDerivation = await contentPool.query<{ kind: string; method: string; model: string;
      input_observation_id: string }>(`SELECT d.kind, d.method, d.model, i.input_observation_id
      FROM verification.derivation d JOIN verification.derivation_input i ON i.derivation_id = d.id
      WHERE d.output_observation_id = $1`, [observations[2]]);
    expect(retainedDerivation.rows).toEqual([{ kind: 'ai-generation',
      method: 'https://rezics.com/definition/fixture-ai-method-v1', model: 'fixture-model-1',
      input_observation_id: observations[1] }]);
    const evidenceResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/evidence`, {
      profile: 'claim-evidence-v1', claimRevision: created.claim!.revision, expectedHead: null,
      items: observations.map(observation => ({ stance: 'supports', observation, selector: {},
        availability: 'available' })) });
    const evidenceBody = await evidenceResponse.json() as { evidence?: { revision: string } };
    if (evidenceResponse.status !== 201) console.error('evidence', evidenceResponse.status, evidenceBody);
    expect(evidenceResponse.status).toBe(201);
    const assessIntent = { profile: 'claim-assessment-v1', claimRevision: created.claim!.revision,
      evidenceSetRevision: evidenceBody.evidence!.revision, sourceAssessments: [], method: 'automated',
      judgment: null, evaluationContext: intent.interpretationContext, adoptedRevision: null,
      scorePerMillion: null, calibration: null, limitations: 'One copied origin; no independent corroboration.',
      expectedSummary: null, resolvesChallenges: [], actingSubject: actor };
    const assessedResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, assessIntent);
    const assessed = await assessedResponse.json() as { assessment?: { assessment: string };
      analysis?: { origins: string[] }; activation?: { status: string } };
    if (assessedResponse.status !== 201) console.error('assessment', assessedResponse.status, assessed);
    expect(assessedResponse.status).toBe(201);
    expect(assessed.analysis?.origins).toHaveLength(1);
    expect(assessed.assessment).toMatchObject({ dependence: 'established', independentOrigins: 1,
      support: 'insufficient' });
    expect(assessed.activation?.status).toBe('activated');

    await grant('verification:reliability:global', 'verification.reliability-assess');
    const reliabilityIntent = { profile: 'source-reliability-assessment-v1',
      source: `https://rezics.com/id/${record}`, domainDefinition: intent.propositionPredicate,
      evaluationContext: intent.interpretationContext, expectedHead: null,
      result: 'ReliableForDomain', method: 'https://rezics.com/definition/fixture-source-review-v1',
      methodRevision: 'https://rezics.com/definition/fixture-source-review-v1',
      calibration: null, applicableFrom: null, applicableUntil: null, inputDigest: 'a'.repeat(64),
      inputCount: 1, limitations: 'Only release-date announcements were checked.',
      rationale: 'The original announcement was directly inspected.', assessorKind: 'human',
      actingSubject: actor };
    const reliabilityResponse = await call('POST', '/v1/source-reliability-assessments', reliabilityIntent);
    const reliability = await reliabilityResponse.json() as { scope?: string; assessment?: string };
    if (reliabilityResponse.status !== 201) console.error('reliability', reliabilityResponse.status, reliability);
    expect(reliabilityResponse.status).toBe(201);
    const reassessedResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, {
      ...assessIntent, sourceAssessments: [reliability.assessment!],
      expectedSummary: (assessed.activation as { generation: string }).generation });
    const reassessed = await reassessedResponse.json() as { assessment?: { assessment: string; support: string; independentOrigins: number };
      activation?: { status: string; generation: string } };
    if (reassessedResponse.status !== 201) console.error('reassessed', reassessedResponse.status, reassessed);
    expect(reassessedResponse.status).toBe(201);
    expect(reassessed.assessment).toMatchObject({ support: 'supported', independentOrigins: 1 });
    expect(reassessed.activation?.status).toBe('activated');
    const qualityPath = `/v1/claims/${short(created.claim!.claim)}?context=${encodeURIComponent(intent.interpretationContext)}`;
    const currentQuality = await (await call('GET', qualityPath)).json() as { quality: { freshness: string } };
    expect(currentQuality.quality.freshness).toBe('current');
    const correctedResponse = await call('POST', '/v1/source-reliability-assessments', {
      ...reliabilityIntent, expectedHead: reliability.assessment,
      result: 'UntestedForDomain', rationale: 'The source changed its published announcement.' });
    const corrected = await correctedResponse.json() as { assessment?: string };
    if (correctedResponse.status !== 201) console.error('corrected reliability', correctedResponse.status, corrected);
    expect(correctedResponse.status).toBe(201);
    const staleQuality = await (await call('GET', qualityPath)).json() as { quality: { freshness: string;
      staleDependencies: { kind: string }[] } };
    expect(staleQuality.quality.freshness).not.toBe('current');
    expect(staleQuality.quality.staleDependencies.map(item => item.kind)).toContain('source-assessment');
    const work = await new VerificationStore(contentPool).processInvalidations('claim-qa', { pageSize: 1, maxPages: 8 });
    expect(work.pages).toBeGreaterThan(0);
    const exact = await call('GET', `/v1/claims/${short(created.claim!.claim)}/assessments/${short(reassessed.assessment!.assessment)}`);
    expect(exact.status).toBe(200);
    const ownerExact = await exact.json() as { evidence?: { revision: string }; evidenceAvailability: string };
    expect(ownerExact.evidence?.revision).toBe(evidenceBody.evidence!.revision);
    expect(ownerExact.evidenceAvailability).toBe('available');

    const updatedResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, {
      ...assessIntent, sourceAssessments: [corrected.assessment!],
      expectedSummary: reassessed.activation!.generation });
    const updated = await updatedResponse.json() as { assessment?: { support: string };
      activation?: { status: string; generation: string } };
    if (updatedResponse.status !== 201) console.error('updated assessment', updatedResponse.status, updated);
    expect(updatedResponse.status).toBe(201);
    expect(updated.assessment?.support).toBe('insufficient');
    expect(updated.activation?.status).toBe('activated');

    const challenger = randomUUID();
    const challengerActor = id();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [challenger, account.issuer, account.b.id]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [challengerActor]);
    await platformUse(challenger, challengerActor);
    const counterObservation = randomUUID();
    await contentPool.query(`INSERT INTO source.observation
      (id, record_id, principal_id, media_type, retention, coverage, rights_evidence)
      VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
    [counterObservation, record, challenger]);
    const challengePath = `/v1/claims/${short(created.claim!.claim)}/challenges`;
    const challengeIntent = { profile: 'claim-challenge-v1', claimRevision: created.claim!.revision,
      adoptedRevision: null, context: intent.interpretationContext,
      reason: 'The cited announcement was corrected.', counterevidence: [{ stance: 'contradicts',
        observation: counterObservation, selector: { field: 'releaseDate' }, availability: 'available' }],
      actingSubject: challengerActor };
    expect((await call('POST', challengePath, { ...challengeIntent, verdict: 'false' },
      randomUUID(), account.tokenB)).status).toBe(400);
    const challengeResponse = await call('POST', challengePath, challengeIntent, randomUUID(), account.tokenB);
    const challenge = await challengeResponse.json() as { challenge?: { challenge: string; state: string } };
    if (challengeResponse.status !== 201) console.error('challenge', challengeResponse.status, challenge);
    expect(challengeResponse.status).toBe(201);
    expect(challenge.challenge?.state).toBe('pending');
    // FACT06: the challenger also holds a real paid Commerce benefit. Payment
    // grants product access; it does not confer claim-review authority.
    const offering = randomUUID();
    const commerceSeed = await accessPool.connect();
    try {
      await commerceSeed.query('BEGIN');
    await commerceSeed.query(`INSERT INTO commerce.payment_provider (id, kind, callback_key_reference)
      VALUES ('fake', 'fake', 'claim:payment-callback')`);
    await commerceSeed.query(`INSERT INTO commerce.offering (id, seller, beneficiary_kind, head_revision)
      VALUES ($1, $2, 'person', 1)`, [offering, actor]);
    await commerceSeed.query(`INSERT INTO commerce.offering_revision
      (offering_id, revision, lifecycle, definition_digest) VALUES ($1, 1, 'open', repeat('a', 64))`, [offering]);
    await commerceSeed.query(`INSERT INTO commerce.plan_group (offering_id, group_key, semantics)
      VALUES ($1, 'pro', 'replaceable')`, [offering]);
    await commerceSeed.query(`INSERT INTO commerce.plan (offering_id, offering_revision, plan_key, group_key, rank)
      VALUES ($1, 1, 'basic', 'pro', 1)`, [offering]);
    await commerceSeed.query(`INSERT INTO commerce.price (offering_id, offering_revision, plan_key, price_key,
      currency, amount_minor, billing_period) VALUES ($1, 1, 'basic', 'monthly', 'USD', 500, 'P1M')`, [offering]);
    await commerceSeed.query(`INSERT INTO commerce.plan_benefit (offering_id, offering_revision, plan_key,
      benefit_key, level, quota_unit, quota_amount) VALUES ($1, 1, 'basic', 'pro.read', 1, NULL, NULL)`, [offering]);
      await commerceSeed.query('COMMIT');
    } finally { commerceSeed.release(); }
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1, $2, $3,
      'commerce.subscribe', now() + interval '1 hour')`, [randomUUID(), challenger, challengerActor]);
    const quoteResponse = await call('POST', '/v1/subscriptions/quotes', {
      profile: 'subscription-quote-v1', beneficiary: challengerActor,
      offeringId: offering, offeringRevision: '1', operation: 'purchase',
      planKey: 'basic', priceKey: 'monthly' }, randomUUID(), account.tokenB);
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json() as { quoteId: string; quoteDigest: string };
    const purchaseResponse = await call('POST', '/v1/subscriptions/changes', {
      profile: 'subscription-change-v1', quoteId: quote.quoteId, quoteDigest: quote.quoteDigest },
    randomUUID(), account.tokenB);
    expect(purchaseResponse.status).toBe(200);
    const purchase = await purchaseResponse.json() as { settlement: { providerReference: string } };
    const settlement = paymentProvider.settle(purchase.settlement.providerReference, 'succeeded');
    expect((await app.handle(new Request('http://main.local/v1/subscriptions/settlements', {
      method: 'POST', headers: { 'content-type': 'text/plain',
        'rezics-provider-signature': settlement.signature, authorization: `Bearer ${account.tokenB}` }, body: settlement.body }))).status).toBe(200);
    const benefitResponse = await call('GET',
      `/v1/subscriptions/benefits?beneficiary=${encodeURIComponent(challengerActor)}`,
      undefined, randomUUID(), account.tokenB);
    expect(benefitResponse.status).toBe(200);
    expect((await benefitResponse.json() as { benefits: { benefitKey: string }[] }).benefits
      .map(item => item.benefitKey)).toContain('pro.read');
    const recipientEndpoint = await call('PUT', '/v1/me/notification-endpoints/push', {
      profile: 'notification-endpoint-v1', deviceId: 'claim-correction-phone',
      address: 'push-claim-correction', lockScreenDisclosure: true }, randomUUID(), account.tokenB);
    expect(recipientEndpoint.status).toBe(200);
    const subscriptionResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/correction-subscriptions`, {
        profile: 'verification-correction-subscription-v1', context: intent.interpretationContext,
        expectedHead: null, state: 'subscribed' }, randomUUID(), account.tokenB);
    expect(subscriptionResponse.status).toBe(201);
    const subscription = await subscriptionResponse.json() as { subscription: string };
    const pendingQuality = await (await call('GET', qualityPath)).json() as { quality: { freshness: string } };
    expect(pendingQuality.quality.freshness).not.toBe('current');
    expect((await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, {
      ...assessIntent, sourceAssessments: [corrected.assessment!], method: 'human-review',
      judgment: 'material-conflict', expectedSummary: updated.activation!.generation,
      resolvesChallenges: [short(challenge.challenge!.challenge)], actingSubject: challengerActor },
    randomUUID(), account.tokenB)).status).toBe(403);
    const judgedResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, {
      ...assessIntent, sourceAssessments: [corrected.assessment!], method: 'human-review',
      judgment: 'material-conflict', expectedSummary: updated.activation!.generation,
      resolvesChallenges: [short(challenge.challenge!.challenge)] });
    const judged = await judgedResponse.json() as { assessment?: { assessment: string; support: string };
      activation?: { status: string; generation: string; dispute: string } };
    if (judgedResponse.status !== 201) console.error('judged assessment', judgedResponse.status, judged);
    expect(judgedResponse.status).toBe(201);
    expect(judged.assessment?.support).toBe('material-conflict');
    expect(judged.activation).toMatchObject({ status: 'activated', dispute: 'disputed' });
    const challengeRead = await (await call('GET', challengePath)).json() as { challenges: { state: string }[] };
    expect(challengeRead.challenges).toHaveLength(1);
    expect(challengeRead.challenges[0]?.state).toBe('resolved');
    const correctionsResponse = await call('GET', `/v1/claims/${short(created.claim!.claim)}/corrections?context=${encodeURIComponent(intent.interpretationContext)}`);
    const corrections = await correctionsResponse.json() as { corrections: { support: string; dispute: string }[] };
    expect(correctionsResponse.status).toBe(200);
    expect(corrections.corrections.at(-1)).toMatchObject({ support: 'material-conflict', dispute: 'disputed' });
    // Lose the producer acknowledgement after Access commits its item. The
    // Content cursor stays put; replay deduplicates by source event/recipient.
    const lostPublisher = new VerificationCorrectionPublisher(verification, {
      enqueue: async event => {
        await notificationStore.enqueue(event);
        throw new Error('lost Access enqueue acknowledgement');
      },
    });
    await expect(lostPublisher.runOnce('claim-qa')).rejects.toThrow('lost Access enqueue acknowledgement');
    const published = await publisher.runOnce('claim-qa');
    expect(published.pages).toBeGreaterThanOrEqual(1);
    const correctionItems = await accessPool.query<{ count: string }>(`SELECT count(*)::text
      FROM access.notification_item WHERE source_owner = 'content' AND source_event = $1 AND principal_id = $2`,
    [corrections.corrections.at(-1)!.generation, challenger]);
    expect(correctionItems.rows[0]?.count).toBe('1');
    const display = await accessPool.query<{ kind: string }>(`SELECT c.kind
      FROM access.notification_display_context c JOIN access.notification_item i ON i.id = c.item_id
      WHERE i.source_owner = 'content' AND i.source_event = $1 AND i.principal_id = $2`,
    [corrections.corrections.at(-1)!.generation, challenger]);
    expect(display.rows[0]?.kind).toBe('claim_correction');
    const delivered = await dispatcher.runOnce();
    expect(delivered.delivered).toBeGreaterThanOrEqual(1);
    const publishedPayloads = [...deliveryProvider.accepted.values()].map(value => value.payload);
    expect(publishedPayloads).toContainEqual(expect.objectContaining({ support: 'material-conflict',
      dispute: 'disputed' }));
    expect(JSON.stringify(publishedPayloads)).not.toContain(counterObservation);
    expect(JSON.stringify(publishedPayloads)).not.toContain(challenger);
    expect((await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, {
      ...assessIntent, sourceAssessments: [corrected.assessment!], method: 'human-review',
      judgment: 'supported', expectedSummary: judged.activation!.generation,
      funding: 'paid-index-publisher' })).status).toBe(400);
    const notice = await contentPool.query<{ generation_id: string }>(`SELECT generation_id
      FROM verification.correction_notice WHERE target = $1 AND context = $2
      ORDER BY created_at DESC LIMIT 1`, [created.claim!.claim, intent.interpretationContext]);
    expect(notice.rows).toHaveLength(1);
    await expect(contentPool.query('DELETE FROM verification.correction_notice WHERE generation_id = $1',
      [notice.rows[0]!.generation_id])).rejects.toMatchObject({ code: '23514' });
    const recipientCorrections = await call('GET',
      `/v1/claims/${short(created.claim!.claim)}/corrections?context=${encodeURIComponent(intent.interpretationContext)}`,
      undefined, randomUUID(), account.tokenB);
    expect(recipientCorrections.status).toBe(200);
    const disclosed = await recipientCorrections.text();
    expect(disclosed).toContain('material-conflict');
    expect(disclosed).not.toContain(counterObservation);
    expect(disclosed).not.toContain(challenger);
    const otherAssessment = await call('GET',
      `/v1/claims/${short(created.claim!.claim)}/assessments/${short(reassessed.assessment!.assessment)}`,
      undefined, randomUUID(), account.tokenB);
    expect(otherAssessment.status).toBe(200);
    const privateEvidence = await otherAssessment.json() as { evidence: unknown; evidenceAvailability: string };
    expect(privateEvidence.evidence).toBeNull();
    expect(privateEvidence.evidenceAvailability).toBe('inaccessible');
    expect((await call('GET', `/v1/claims/${short(created.claim!.claim)}/evidence/${short(evidenceBody.evidence!.revision)}`,
      undefined, randomUUID(), account.tokenB)).status).toBe(404);

    const staleWorkerResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/assessments`, {
      ...assessIntent, sourceAssessments: [corrected.assessment!],
      expectedSummary: updated.activation!.generation });
    const staleWorker = await staleWorkerResponse.json() as { activation?: { status: string } };
    expect(staleWorkerResponse.status).toBe(201);
    expect(staleWorker.activation?.status).toBe('stale-summary');
    const afterStaleWorker = await (await call('GET', qualityPath)).json() as { quality: { generation: string } };
    expect(afterStaleWorker.quality.generation).toBe(judged.activation?.generation);

    const missingResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/evidence`, {
      profile: 'claim-evidence-v1', claimRevision: created.claim!.revision,
      expectedHead: short(evidenceBody.evidence!.revision), items: [{ stance: 'supports',
        observation: observations[0], selector: {}, availability: 'withdrawn' }] });
    const missing = await missingResponse.json() as { evidence?: { revision: string } };
    if (missingResponse.status !== 201) console.error('missing support', missingResponse.status, missing);
    expect(missingResponse.status).toBe(201);
    const afterMissing = await (await call('GET', qualityPath)).json() as { quality: {
      freshness: string; review: string; assessment: string } };
    expect(afterMissing.quality.freshness).not.toBe('current');
    expect(afterMissing.quality.review).toBe('reviewed');
    expect(afterMissing.quality.assessment).toBe(judged.assessment?.assessment);
    const missingAssessmentResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...assessIntent, evidenceSetRevision: missing.evidence!.revision,
        sourceAssessments: [corrected.assessment!], expectedSummary: judged.activation!.generation });
    const missingAssessment = await missingAssessmentResponse.json() as { assessment?: { support: string };
      activation?: { status: string; dispute: string; generation: string } };
    if (missingAssessmentResponse.status !== 201) console.error('missing assessment',
      missingAssessmentResponse.status, missingAssessment);
    expect(missingAssessmentResponse.status).toBe(201);
    expect(missingAssessment.assessment?.support).toBe('insufficient');
    expect(missingAssessment.activation).toMatchObject({ status: 'activated', dispute: 'resolved' });
    expect((await publisher.runOnce('claim-qa')).newItems).toBeGreaterThanOrEqual(1);
    const unsubscribeResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/correction-subscriptions`, {
        profile: 'verification-correction-subscription-v1', context: intent.interpretationContext,
        expectedHead: short(subscription.subscription), state: 'unsubscribed' }, randomUUID(), account.tokenB);
    expect(unsubscribeResponse.status).toBe(201);
    const deliveredBefore = deliveryProvider.accepted.size;
    expect((await dispatcher.runOnce()).cancelled).toBeGreaterThanOrEqual(1);
    expect(deliveryProvider.accepted.size).toBe(deliveredBefore);
    const oldExact = await call('GET',
      `/v1/claims/${short(created.claim!.claim)}/assessments/${short(reassessed.assessment!.assessment)}`);
    const oldAssessment = await oldExact.json() as { assessment?: { support: string } };
    expect(oldExact.status).toBe(200);
    expect(oldAssessment.assessment?.support).toBe('supported');

    const unknownObservation = randomUUID();
    await contentPool.query(`INSERT INTO source.observation
      (id, record_id, principal_id, media_type, retention, coverage, rights_evidence)
      VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
    [unknownObservation, record, principal]);
    const unknownEvidenceIntent = { profile: 'claim-evidence-v1', claimRevision: created.claim!.revision,
      expectedHead: short(missing.evidence!.revision), items: [{ stance: 'supports',
        observation: unknownObservation, selector: {}, availability: 'available' }] };
    expect((await call('POST', `/v1/claims/${short(created.claim!.claim)}/evidence`, {
      ...unknownEvidenceIntent, items: Array.from({ length: 33 }, () => unknownEvidenceIntent.items[0]) })).status)
      .toBe(400);
    const unknownEvidenceResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/evidence`,
      unknownEvidenceIntent);
    const unknownEvidence = await unknownEvidenceResponse.json() as { evidence?: { revision: string } };
    expect(unknownEvidenceResponse.status).toBe(201);
    const unknownAssessmentResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...assessIntent, evidenceSetRevision: unknownEvidence.evidence!.revision,
        expectedSummary: missingAssessment.activation!.generation });
    const unknownAssessment = await unknownAssessmentResponse.json() as { assessment?: {
      dependence: string; independentOrigins: number | null; support: string };
      activation?: { generation: string } };
    expect(unknownAssessmentResponse.status).toBe(201);
    expect(unknownAssessment.assessment).toMatchObject({ dependence: 'unknown',
      independentOrigins: null, support: 'insufficient' });
    const cycle = async (observation: string, target: string) => {
      const response = await call('POST', `/v1/sources/observations/${observation}/lineage`, {
        profile: 'verification-lineage-edge-v1', relation: 'copy-of', target: { observation: target },
        basis: 'reviewer-asserted', method: 'https://rezics.com/definition/fixture-lineage-review-v1' });
      expect(response.status).toBe(201);
    };
    await cycle(unknownObservation, observations[0]!);
    await cycle(observations[0]!, unknownObservation);
    const circularResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...assessIntent, evidenceSetRevision: unknownEvidence.evidence!.revision,
        expectedSummary: unknownAssessment.activation!.generation });
    const circular = await circularResponse.json() as { assessment?: {
      dependence: string; support: string; coverage: string };
      activation?: { generation: string } };
    expect(circularResponse.status).toBe(201);
    expect(circular.assessment).toMatchObject({ dependence: 'circular',
      support: 'abstained', coverage: 'incomplete' });

    const longChain = Array.from({ length: 41 }, () => randomUUID());
    for (const observation of longChain) {
      await contentPool.query(`INSERT INTO source.observation
        (id, record_id, principal_id, media_type, retention, coverage, rights_evidence)
        VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
      [observation, record, principal]);
    }
    for (let index = 0; index < longChain.length - 1; index++) {
      const response = await call('POST', `/v1/sources/observations/${longChain[index]}/lineage`, {
        profile: 'verification-lineage-edge-v1', relation: 'copy-of',
        target: { observation: longChain[index + 1] }, basis: 'detected',
        method: 'https://rezics.com/definition/fixture-copy-detector-v1' });
      expect(response.status).toBe(201);
    }
    const longEvidenceResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/evidence`, {
      profile: 'claim-evidence-v1', claimRevision: created.claim!.revision,
      expectedHead: short(unknownEvidence.evidence!.revision), items: [{ stance: 'supports',
        observation: longChain[0], selector: {}, availability: 'available' }] });
    const longEvidence = await longEvidenceResponse.json() as { evidence?: { revision: string } };
    expect(longEvidenceResponse.status).toBe(201);
    const longIntent = { ...assessIntent, evidenceSetRevision: longEvidence.evidence!.revision,
      expectedSummary: circular.activation!.generation };
    const longKey = randomUUID();
    const partialResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, longIntent, longKey);
    expect(partialResponse.status).toBe(202);
    const partial = await partialResponse.json() as { status: string; assessment: null; analysis: {
      dependence: string; support: string; coverage: string; lineageNodes: number; lineageContinuation: string } };
    expect(partial).toMatchObject({ status: 'analysis-partial', assessment: null,
      analysis: { dependence: 'over-budget', support: 'abstained', coverage: 'incomplete', lineageNodes: 40 } });
    const partialReplay = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, longIntent, longKey);
    expect(partialReplay.status).toBe(202);
    expect(await partialReplay.json()).toMatchObject({ replayed: true,
      analysis: { lineageContinuation: partial.analysis.lineageContinuation } });
    const completedResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...longIntent, lineageContinuation: partial.analysis.lineageContinuation }, longKey);
    expect(completedResponse.status).toBe(200);
    const completed = await completedResponse.json() as { assessment: { assessment: string }; analysis: { lineageNodes: number } };
    expect(completed).toMatchObject({ assessment: { dependence: 'unknown', support: 'insufficient', coverage: 'complete' },
      analysis: { lineageComplete: true, lineageContinuation: null, lineageNodes: 41 } });
    // A successful receipt replays its completed proof even without the last cursor.
    const completedReplay = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, longIntent, longKey);
    expect(completedReplay.status).toBe(200);
    expect(await completedReplay.json()).toMatchObject({ assessment: { assessment: completed.assessment.assessment },
      analysis: { lineageComplete: true, lineageNodes: 41 } });

    // FACT03: a rating's applicable interval is checked against the exact
    // observation time, while its domain/context remain independent of support.
    const focusedObservation = randomUUID();
    await contentPool.query(`INSERT INTO source.observation
      (id, record_id, principal_id, media_type, retention, coverage, rights_evidence)
      VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
    [focusedObservation, record, principal]);
    expect((await call('POST', `/v1/sources/observations/${focusedObservation}/lineage`, {
      profile: 'verification-lineage-edge-v1', relation: 'publishes-origin', target: { origin },
      basis: 'declared-by-source', method: null })).status).toBe(201);
    const focusedEvidenceResponse = await call('POST', `/v1/claims/${short(created.claim!.claim)}/evidence`, {
      profile: 'claim-evidence-v1', claimRevision: created.claim!.revision,
      expectedHead: short(longEvidence.evidence!.revision), items: [{ stance: 'supports',
        observation: focusedObservation, selector: {}, availability: 'available' }] });
    expect(focusedEvidenceResponse.status).toBe(201);
    const focusedEvidence = await focusedEvidenceResponse.json() as { evidence: { revision: string } };
    const pastResponse = await call('POST', '/v1/source-reliability-assessments', {
      ...reliabilityIntent, expectedHead: corrected.assessment, result: 'ReliableForDomain',
      applicableUntil: '2020-01-01T00:00:00.000Z' });
    expect(pastResponse.status).toBe(201);
    const past = await pastResponse.json() as { assessment: string };
    const generationNow = async () => (await (await call('GET', qualityPath)).json() as {
      quality: { generation: string } }).quality.generation;
    const pastAssessmentResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...assessIntent, evidenceSetRevision: focusedEvidence.evidence.revision,
        sourceAssessments: [past.assessment], expectedSummary: await generationNow() });
    expect(pastAssessmentResponse.status).toBe(201);
    const pastAssessment = await pastAssessmentResponse.json() as { assessment: { support: string } };
    expect(pastAssessment.assessment.support).toBe('insufficient');
    const currentResponse = await call('POST', '/v1/source-reliability-assessments', {
      ...reliabilityIntent, expectedHead: past.assessment, result: 'ReliableForDomain',
      applicableFrom: '2020-01-01T00:00:00.000Z' });
    expect(currentResponse.status).toBe(201);
    const current = await currentResponse.json() as { assessment: string };
    const currentAssessmentResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...assessIntent, evidenceSetRevision: focusedEvidence.evidence.revision,
        sourceAssessments: [current.assessment], expectedSummary: await generationNow() });
    expect(currentAssessmentResponse.status).toBe(201);
    const currentAssessment = await currentAssessmentResponse.json() as { assessment: { assessment: string;
      support: string } };
    expect(currentAssessment.assessment.support).toBe('supported');

    // FACT04: the source author withdraws the observation after assessment.
    // Foreground freshness catches the changed head before queue fan-out.
    const dispositionPath = `/v1/sources/observations/${focusedObservation}/disposition`;
    const dispositionIntent = { profile: 'verification-observation-disposition-v1',
      expectedHead: null, state: 'withdrawn', reason: 'Original announcement was withdrawn.' };
    expect((await call('POST', dispositionPath, dispositionIntent, randomUUID(), account.tokenB)).status).toBe(404);
    const dispositionKey = randomUUID();
    const disposedResponse = await call('POST', dispositionPath, dispositionIntent, dispositionKey);
    expect(disposedResponse.status).toBe(201);
    expect((await call('POST', dispositionPath, dispositionIntent, dispositionKey)).status).toBe(200);
    expect((await call('POST', dispositionPath, { ...dispositionIntent, state: 'available' },
      dispositionKey)).status).toBe(409);
    expect((await call('POST', dispositionPath, dispositionIntent)).status).toBe(409);
    const dispositionQuality = await (await call('GET', qualityPath)).json() as { quality: {
      freshness: string; staleDependencies: { kind: string }[] } };
    expect(dispositionQuality.quality.freshness).not.toBe('current');
    expect(dispositionQuality.quality.staleDependencies.map(item => item.kind)).toContain('lineage-walk');
    const reassessedWithdrawalResponse = await call('POST',
      `/v1/claims/${short(created.claim!.claim)}/assessments`, {
        ...assessIntent, evidenceSetRevision: focusedEvidence.evidence.revision,
        sourceAssessments: [current.assessment], expectedSummary: await generationNow() });
    expect(reassessedWithdrawalResponse.status).toBe(201);
    const reassessedWithdrawal = await reassessedWithdrawalResponse.json() as { assessment: { support: string } };
    expect(reassessedWithdrawal.assessment.support).toBe('insufficient');
    const retainedSupported = await call('GET',
      `/v1/claims/${short(created.claim!.claim)}/assessments/${short(currentAssessment.assessment.assessment)}`);
    expect((await retainedSupported.json() as { assessment: { support: string } }).assessment.support).toBe('supported');

    // Start at this claim's retained position. Earlier files may already have
    // filled the shared QA graph with more than one page of unrelated batches.
    expect(created.sourcePosition.dataEpoch).toBe(apps.MAIN_DATA_EPOCH);
    let cursor = (BigInt(created.sourcePosition.sequence) - 1n).toString();
    const eventTypes: string[] = [];
    for (let page = 0; page < 24; page++) {
      const batch = await readNextMainOutboxBatch(fuseki, created.sourcePosition.dataEpoch, cursor);
      if (!batch) break;
      for (const eventId of batch.eventIds) {
        eventTypes.push((await readMainOutboxEnvelope(fuseki, batch, eventId)).type);
      }
      cursor = batch.sequence;
    }
    expect(eventTypes).toContain('com.rezics.verification.claim-created.v1');
    expect(eventTypes).toContain('com.rezics.verification.reliability-assessed.v1');
    expect(eventTypes).toContain('com.rezics.verification.claim-assessed.v1');
  } finally {
    await paymentProvider.stop();
    await account.close();
    await Promise.all([accessPool.end(), contentPool.end()]);
  }
}, 180_000);
