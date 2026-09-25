import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, readNextMainOutboxBatch, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { activateMetadataWork, DATASET, GRAPHS, ID, RV, hash, iri, lit, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { listEligibleNativeVariants, readEligibleNativeVariant }
  from '../../../services/main/src/modules/work/native-variants.ts';

const root = resolve(import.meta.dir, '../../..');

test('WORK02: independent translated Works retain exact and unresolved source provenance', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `translated-work-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const actor = ID + randomUUID();
  const translatorOfficial = ID + randomUUID();
  const translatorThirdParty = ID + randomUUID();
  const principal = { issuer: 'https://qa-translation.test', subject: randomUUID() };
  const principalId = randomUUID();
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId, actingSubject: actor,
      scope, action, idempotencyKey: `work02-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
      dispatchEligible: true, replayed: false };
  };
  const grant = async (scope: string, action: string) => {
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [scope]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), principalId, actor, action]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), actor, scope, action]);
  };
  const send = (app: ReturnType<typeof createMainApp>, body: object, key = randomUUID()) =>
    app.handle(new Request('http://main.local/v1/translation-links', {
      method: 'POST', headers: { authorization: 'Bearer qa',
        'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ profile: 'translation-link-v1', ...body }),
    }));
  const publish = async (work: string, body: string) => {
    const draftInput = { work, language: 'zh', body, actingSubject: actor };
    const draft = await activateTextContribution(env, admission(`contribution:create:${work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('translated Work draft was not retained');
    }
    const publishInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const publication = await publishTextContribution(env, admission(
      `contribution:publish:${draft.contribution}`, 'contribution.publish',
      textPublicationDigest(publishInput)), publishInput);
    if (publication.outcome !== 'succeeded') throw new Error('translated Work publication failed');
    return draft.contribution;
  };
  try {
    const [a, b, c, d] = await Promise.all(['Source A', 'Official B', 'Third party C',
      'Unlinked D'].map(async label => {
      const title = `${label} ${randomUUID()}`;
      return activateMetadataWork(env, { title, admission: admission('work:create:root',
        'work.create', metadataWorkRequestDigest(title)) });
    }));
    expect(new Set([a.work, b.work, c.work, d.work]).size).toBe(4);
    expect(new Set([a.mainVersion, b.mainVersion, c.mainVersion, d.mainVersion]).size).toBe(4);
    const bContribution = await publish(b.work, '官方中文正文');
    const cContribution = await publish(c.work, '独立中文正文');
    expect(bContribution).not.toBe(cContribution);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
    for (const target of [b, c, d]) await grant(`translation:link:${target.work}`, 'translation.link');
    const authorization = `translation:authorize:${a.work}:${a.mainRevision}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [authorization]);
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access: new AccessAdmissionRegistry(accessPool) });
    const official = { targetWork: b.work, targetMainVersion: b.mainVersion,
      targetMainRevision: b.mainRevision, sourceWork: a.work,
      sourceMainVersion: a.mainVersion, sourceMainRevision: a.mainRevision,
      status: 'official', contentLanguage: 'zh', translator: translatorOfficial,
      publisher: actor, evidence: 'https://publisher.example/authorization/first',
      actingSubject: actor };
    // A creator may link a target Work but cannot certify an official source revision.
    const deniedOfficial = await send(app, official);
    expect(deniedOfficial.status).toBe(403);
    expect((await deniedOfficial.json() as { code: string }).code).toBe('authority_denied');
    await grant(authorization, 'translation.authorize');
    const key = `official-${randomUUID()}`;
    const linkedB = await send(app, official, key);
    expect(linkedB.status).toBe(201);
    const officialResult = await linkedB.json() as { link: string; targetWork: string;
      sourceMainRevision: string | null; sourceVersionStatus: string; status: string;
      authorizingParty: string | null; authorizationScope: string | null;
      receipt: string; replayed: boolean; sourcePosition: { sequence: string } };
    expect(officialResult).toMatchObject({ targetWork: b.work, sourceMainRevision: a.mainRevision,
      sourceVersionStatus: 'exact', status: 'official', authorizingParty: actor,
      authorizationScope: authorization, replayed: false });
    const reviewedLink = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(officialResult.link)} a rv:TranslationLink ;
          rv:modelRevision <https://rezics.com/definition/translation-link-v1> ;
          rv:shapeRevision <https://rezics.com/definition/translation-link-v1> ;
          rv:sourceMainRevision ${iri(a.mainRevision)} ;
          rv:translationStatus rv:Official ; rv:authorizationScope ${lit(authorization)} .
      }
    }`);
    expect(reviewedLink.boolean).toBe(true);
    const invalidReceipt = `urn:rezics:receipt:translation-without-profile-${randomUUID()}`;
    const invalidDigest = hash(invalidReceipt);
    const invalidUpdate = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(officialResult.link)} rv:evidence
          "https://publisher.example/unreviewed" . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(invalidReceipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(invalidDigest)} ; rv:outcome rv:Succeeded ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { <urn:rezics:outbox:${hash(invalidReceipt)}>
          a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 0 . }
      } WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(invalidReceipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }`;
    const omittedFocus = await env.fuseki.commandWithReceipt({ receipt: invalidReceipt,
      digest: invalidDigest, update: invalidUpdate, validations: [], deadlineMs: 10_000 });
    expect(omittedFocus.status).toBe('invalid');
    const graphEscape = await fetch(`${Bun.env.FUSEKI_URL!.replace(/\/$/, '')}/command`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Bearer ${Bun.env.FUSEKI_COMMAND_TOKEN}` },
      body: JSON.stringify({ receipt: invalidReceipt, digest: invalidDigest,
        update: invalidUpdate, deadlineMs: 10_000,
        validations: [{ profile: 'work-metadata-v1',
          sha256: profileRegistry['work-metadata-v1'].sha256,
          shape: 'https://rezics.com/definition/work-metadata-v1/main-version-shape',
          focus: [b.mainVersion], graphs: [GRAPHS.current, GRAPHS.receipts] }] }),
    });
    expect(graphEscape.status).toBe(400);
    expect(await graphEscape.json()).toMatchObject({ status: 'bad-request',
      message: 'validation graph not admitted' });
    const noUnreviewedEvidence = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(officialResult.link)} rv:evidence "https://publisher.example/unreviewed" .
      }
    }`);
    expect(noUnreviewedEvidence.boolean).toBe(false);
    const officialBatch = await readNextMainOutboxBatch(env.fuseki, env.lineage.dataEpoch,
      (BigInt(officialResult.sourcePosition.sequence) - 1n).toString());
    expect(officialBatch?.sequence).toBe(officialResult.sourcePosition.sequence);
    expect(officialBatch?.eventIds).toHaveLength(1);
    expect(officialBatch?.eventIds[0]).toMatch(/^urn:rezics:event:/);
    const replay = await send(app, official, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ link: officialResult.link,
      receipt: officialResult.receipt, replayed: true });
    const consumer = `work02:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
    for (let sequence = 1n; sequence < BigInt(officialResult.sourcePosition.sequence); sequence++) {
      expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence)
        .toBe(sequence.toString());
    }
    await expect(relayMainOutboxOnce(env.fuseki, relayPool, consumer, {
      afterDelivery: async () => { throw new Error('simulated lost checkpoint'); },
    })).rejects.toThrow('simulated lost checkpoint');
    expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence)
      .toBe(officialResult.sourcePosition.sequence);
    const deliveredOfficial = await relayPool.query<{ envelope: {
      type: string; data: { receipt: Record<string, unknown> } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE event_id = $1',
      [officialBatch!.eventIds[0]]);
    expect(deliveredOfficial.rows).toHaveLength(1);
    expect(deliveredOfficial.rows[0]!.envelope).toMatchObject({
      type: 'com.rezics.translation.linked.v1',
      data: { receipt: { translationLink: officialResult.link,
        sourceMainRevision: a.mainRevision, sourceVersionStatus: 'exact',
        translationStatus: 'official', authorizationScope: authorization } },
    });
    const conflictingRetry = await send(app, { ...official, translator: translatorThirdParty }, key);
    expect(conflictingRetry.status).toBe(409);
    const secondLink = await send(app, { ...official,
      evidence: 'https://publisher.example/authorization/second' });
    expect(secondLink.status).toBe(409);
    const thirdParty = { targetWork: c.work, targetMainVersion: c.mainVersion,
      targetMainRevision: c.mainRevision, sourceWork: a.work,
      sourceMainVersion: a.mainVersion, sourceMainRevision: null,
      status: 'third-party', contentLanguage: 'zh', translator: translatorThirdParty,
      publisher: actor, evidence: 'https://publisher.example/edition/independent',
      actingSubject: actor };
    const linkedC = await send(app, thirdParty);
    expect(linkedC.status).toBe(201);
    const thirdPartyResult = await linkedC.json() as { sourcePosition: { sequence: string } };
    expect(thirdPartyResult).toMatchObject({ targetWork: c.work,
      sourceMainRevision: null, sourceVersionStatus: 'unresolved', status: 'third-party',
      authorizingParty: null, authorizationScope: null });
    const thirdPartyBatch = await readNextMainOutboxBatch(env.fuseki, env.lineage.dataEpoch,
      (BigInt(thirdPartyResult.sourcePosition.sequence) - 1n).toString());
    expect(thirdPartyBatch?.sequence).toBe(thirdPartyResult.sourcePosition.sequence);
    expect(thirdPartyBatch?.eventIds).toHaveLength(1);
    expect(thirdPartyBatch?.eventIds[0]).toMatch(/^urn:rezics:event:/);
    for (let sequence = BigInt(officialResult.sourcePosition.sequence) + 1n;
      sequence <= BigInt(thirdPartyResult.sourcePosition.sequence); sequence++) {
      expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence)
        .toBe(sequence.toString());
    }
    const deliveredThirdParty = await relayPool.query<{ envelope: {
      type: string; data: { receipt: Record<string, unknown> } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE event_id = $1',
      [thirdPartyBatch!.eventIds[0]]);
    expect(deliveredThirdParty.rows).toHaveLength(1);
    expect(deliveredThirdParty.rows[0]!.envelope).toMatchObject({
      type: 'com.rezics.translation.linked.v1',
      data: { receipt: { sourceMainRevision: null, sourceVersionStatus: 'unresolved',
        translationStatus: 'third-party', authorizingParty: null,
        authorizationScope: null } },
    });
    const badOfficial = await send(app, { ...thirdParty, targetWork: d.work,
      targetMainVersion: d.mainVersion, targetMainRevision: d.mainRevision,
      status: 'official' });
    expect(badOfficial.status).toBe(400);
    const unknownSource = await send(app, { ...thirdParty, targetWork: d.work,
      targetMainVersion: d.mainVersion, targetMainRevision: d.mainRevision,
      sourceMainRevision: ID + randomUUID() });
    expect(unknownSource.status).toBe(404);
    expect((await unknownSource.json() as { code: string }).code)
      .toBe('translation_version_unavailable');
    await accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'translation.link'`,
    [actor, `translation:link:${d.work}`]);
    const deniedTarget = await send(app, { ...thirdParty, targetWork: d.work,
      targetMainVersion: d.mainVersion, targetMainRevision: d.mainRevision });
    expect(deniedTarget.status).toBe(403);
    const read = async (main: string, revision: string) => app.handle(new Request(
      `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/translation-links`));
    const bLinks = await read(b.mainVersion, b.mainRevision);
    expect(bLinks.status).toBe(200);
    expect(await bLinks.json()).toMatchObject({ complete: true,
      links: [{ link: officialResult.link, sourceWork: a.work,
        sourceMainRevision: a.mainRevision, status: 'official' }] });
    const cLinks = await read(c.mainVersion, c.mainRevision);
    expect(cLinks.status).toBe(200);
    expect(await cLinks.json()).toMatchObject({ complete: true,
      links: [{ sourceWork: a.work, sourceMainRevision: null, status: 'third-party' }] });
    const sourceInventory = await listEligibleNativeVariants(env, a.mainVersion);
    expect(sourceInventory).toMatchObject({ work: a.work, variants: [] });
    expect((await listEligibleNativeVariants(env, b.mainVersion, 'zh')).variants)
      .toMatchObject([{ contribution: bContribution }]);
    expect((await listEligibleNativeVariants(env, c.mainVersion, 'zh')).variants)
      .toMatchObject([{ contribution: cContribution }]);
    expect((await readEligibleNativeVariant(env, b.mainVersion, bContribution))?.body)
      .toBe('官方中文正文');
    expect((await readEligibleNativeVariant(env, c.mainVersion, cContribution))?.body)
      .toBe('独立中文正文');
    const copiedBodies = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        VALUES ?target { ${iri(a.work)} ${iri(b.work)} ${iri(c.work)} }
        ?target (rv:body|rv:searchBody|rv:translationBody) ?body .
      }
    }`);
    expect(copiedBodies.boolean).toBe(false);
    const unknownRevision = await read(b.mainVersion, ID + randomUUID());
    expect(unknownRevision.status).toBe(404);
    const retained = await read(b.mainVersion, b.mainRevision);
    expect(await retained.json()).toMatchObject({ links: [{ link: officialResult.link,
      status: 'official' }] });
  } finally {
    await accessPool.end();
    await relayPool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
