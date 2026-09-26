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

function translationFixture(label: string) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const actor = ID + randomUUID();
  const principal = { issuer: `https://qa-${label}.test`, subject: randomUUID() };
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
  const registerActor = async () => {
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)',
      [actor, 'agent']);
  };
  const send = (app: ReturnType<typeof createMainApp>, body: object, key: string = randomUUID()) =>
    app.handle(new Request('http://main.local/v1/translation-links', {
      method: 'POST', headers: { authorization: 'Bearer qa',
        'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ profile: 'translation-link-v1', ...body }),
    }));
  const createWork = async (title: string) => activateMetadataWork(env, { title,
    admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
  const publish = async (work: string, body: string, language = 'zh') => {
    const draftInput = { work, language, body, actingSubject: actor };
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
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('translated Work publication failed');
    }
    return { contribution: draft.contribution, decision: publication.publicationDecision };
  };
  const close = async () => {
    await accessPool.end();
    await relayPool.end();
    rmSync(directory, { recursive: true, force: true });
  };
  return { env, accessPool, relayPool, actor, principal, admission, grant, registerActor,
    send, createWork, publish, close };
}

test('WORK02: independent translated Works retain exact and unresolved source provenance', async () => {
  const { env, accessPool, relayPool, actor, principal, grant, registerActor, send,
    createWork, publish, close } = translationFixture('translated-work');
  const translatorOfficial = ID + randomUUID();
  const translatorThirdParty = ID + randomUUID();
  try {
    const [a, b, c, d] = await Promise.all(['Source A', 'Official B', 'Third party C',
      'Unlinked D'].map(label => createWork(`${label} ${randomUUID()}`)));
    expect(new Set([a.work, b.work, c.work, d.work]).size).toBe(4);
    expect(new Set([a.mainVersion, b.mainVersion, c.mainVersion, d.mainVersion]).size).toBe(4);
    const bPublication = await publish(b.work, '官方中文正文');
    const cPublication = await publish(c.work, '独立中文正文');
    const bContribution = bPublication.contribution;
    const cContribution = cPublication.contribution;
    expect(bContribution).not.toBe(cContribution);
    await registerActor();
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
    await grant(`publication:select:${b.mainVersion}`, 'publication.select');
    const selectionBody = { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: b.mainVersion }, work: b.work,
      contribution: bContribution, publicationDecision: bPublication.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor };
    const selectionKey = `main-revision-${randomUUID()}`;
    const select = (key: string) => app.handle(new Request(
      'http://main.local/v1/publication-selections', {
        method: 'POST', headers: { authorization: 'Bearer qa',
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(selectionBody),
      }));
    const selectedResponse = await select(selectionKey);
    expect(selectedResponse.status).toBe(201);
    const selected = await selectedResponse.json() as { mainRevision: string;
      selection: string; replayed: boolean; sourcePosition: { sequence: string } };
    expect(selected.replayed).toBe(false);
    expect(selected.mainRevision).not.toBe(b.mainRevision);
    expect(selected.mainRevision).not.toBe(selected.selection);
    const advanced = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(b.mainVersion)} rv:head ${iri(selected.mainRevision)} ;
          rv:selectionHead ${iri(selected.selection)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(selected.mainRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(b.mainVersion)} ; rv:predecessor ${iri(b.mainRevision)} ;
          rv:modelRevision <https://rezics.com/definition/work-metadata-v1> . }
    }`);
    expect(advanced.boolean).toBe(true);
    expect((await read(b.mainVersion, selected.mainRevision)).status).toBe(200);
    expect(await (await read(b.mainVersion, selected.mainRevision)).json())
      .toMatchObject({ complete: true, links: [] });
    expect(await (await read(b.mainVersion, b.mainRevision)).json())
      .toMatchObject({ complete: true, links: [{ link: officialResult.link }] });
    const retrySelection = await select(selectionKey);
    expect(retrySelection.status).toBe(200);
    expect(await retrySelection.json()).toMatchObject({ mainRevision: selected.mainRevision,
      selection: selected.selection, replayed: true });
    const staleSelection = await select(`stale-main-${randomUUID()}`);
    expect(staleSelection.status).toBe(409);
    expect(await staleSelection.json()).toMatchObject({ code: 'stale_head' });
    for (let sequence = BigInt(thirdPartyResult.sourcePosition.sequence) + 1n;
      sequence <= BigInt(selected.sourcePosition.sequence); sequence++) {
      expect((await relayMainOutboxOnce(env.fuseki, relayPool, consumer))?.sequence)
        .toBe(sequence.toString());
    }
    const selectionBatch = await readNextMainOutboxBatch(env.fuseki, env.lineage.dataEpoch,
      (BigInt(selected.sourcePosition.sequence) - 1n).toString());
    const deliveredSelection = await relayPool.query<{ envelope: { type: string;
      data: { receipt: Record<string, unknown> } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE event_id = $1',
      [selectionBatch!.eventIds[0]]);
    expect(deliveredSelection.rows[0]!.envelope).toMatchObject({
      type: 'com.rezics.publication.selection-changed.v1',
      data: { receipt: { mainRevision: selected.mainRevision, selection: selected.selection } },
    });
  } finally {
    await close();
  }
}, 180_000);

test('WORK02: newer fixed releases inherit no translation coverage or official authorization, and metadata localization keeps content language', async () => {
  const { env, accessPool, actor, principal, grant, registerActor, send, createWork, publish,
    close } = translationFixture('translated-release');
  try {
    const [a, b] = await Promise.all([createWork(`English source A ${randomUUID()}`),
      createWork(`Official Chinese B ${randomUUID()}`)]);
    const english = await publish(a.work, 'English source body', 'en');
    const first = await publish(b.work, '第一版官方中文正文');
    const second = await publish(b.work, '第二版中文正文');
    await registerActor();
    const authorization = `translation:authorize:${a.work}:${a.mainRevision}`;
    for (const [scope, action] of [[`publication:select:${b.mainVersion}`, 'publication.select'],
      [`release:seal:${b.mainVersion}`, 'release.seal'], [`translation:link:${b.work}`, 'translation.link'],
      [authorization, 'translation.authorize'], [`work:read:${b.work}`, 'work.read'],
      [`work:edit:${a.work}`, 'work.edit'], [`work:edit:${b.work}`, 'work.edit']] as const) {
      await grant(scope, action);
    }
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access: new AccessAdmissionRegistry(accessPool) });
    const post = (path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
    const links = async (main: string, revision: string) => (await app.handle(new Request(
      `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/translation-links`)))
      .json() as Promise<{ complete: boolean; links: Array<Record<string, unknown>> }>;
    const select = async (published: { contribution: string; decision: string },
      expectedSelectionHead: string | null) => {
      const response = await post('/v1/publication-selections', { profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: b.mainVersion }, work: b.work,
        contribution: published.contribution, publicationDecision: published.decision,
        expectedSelectionHead, selectionBasis: 'main-maintainer', actingSubject: actor });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ mainRevision: string; selection: string }>;
    };
    type Release = { release: string; mainRevision: string; language: string; body: string };
    const seal = async (selected: { mainRevision: string; selection: string }) => {
      const response = await post('/v1/fixed-releases', { profile: 'fixed-native-text-release-v1',
        work: b.work, mainVersion: b.mainVersion, expectedMainRevision: selected.mainRevision,
        expectedSelection: selected.selection, actingSubject: actor });
      expect(response.status).toBe(201);
      return response.json() as Promise<Release & Record<string, unknown>>;
    };
    const readRelease = async (release: string) => {
      const response = await app.handle(new Request(`http://main.local/v1/fixed-releases/${
        release.slice(ID.length)}?actingSubject=${encodeURIComponent(actor)}`,
      { headers: { authorization: 'Bearer qa' } }));
      expect(response.status).toBe(200);
      return response.json() as Promise<Release & Record<string, unknown>>;
    };
    const authorityFields = ['translationLink', 'translationStatus', 'status', 'sourceVersionStatus',
      'authorizingParty', 'authorizationScope', 'authorizationEpoch', 'translator'];

    const firstSelection = await select(first, null);
    const official = { targetWork: b.work, targetMainVersion: b.mainVersion,
      targetMainRevision: firstSelection.mainRevision, sourceWork: a.work,
      sourceMainVersion: a.mainVersion, sourceMainRevision: a.mainRevision,
      status: 'official', contentLanguage: 'zh', translator: ID + randomUUID(), publisher: actor,
      evidence: 'https://publisher.example/authorization/release-one', actingSubject: actor };
    const linked = await send(app, official);
    expect(linked.status).toBe(201);
    const officialLink = await linked.json() as { link: string };
    const firstRelease = await seal(firstSelection);
    expect(firstRelease).toMatchObject({ mainRevision: firstSelection.mainRevision,
      language: 'zh', body: '第一版官方中文正文' });
    for (const field of authorityFields) expect(firstRelease).not.toHaveProperty(field);
    // Coverage is resolved only through the release's exact Main Version revision.
    expect(await links(b.mainVersion, firstRelease.mainRevision)).toMatchObject({ complete: true,
      links: [{ link: officialLink.link, status: 'official', authorizingParty: actor,
        authorizationScope: authorization, contentLanguage: 'zh' }] });

    const secondSelection = await select(second, firstSelection.selection);
    expect(secondSelection.mainRevision).not.toBe(firstSelection.mainRevision);
    const secondRelease = await seal(secondSelection);
    expect(secondRelease.release).not.toBe(firstRelease.release);
    expect(secondRelease).toMatchObject({ mainRevision: secondSelection.mainRevision,
      language: 'zh', body: '第二版中文正文' });
    for (const field of authorityFields) expect(secondRelease).not.toHaveProperty(field);
    expect(await links(b.mainVersion, secondRelease.mainRevision))
      .toEqual(expect.objectContaining({ complete: true, links: [] }));
    // The first release's official authority does not transfer: a newer claim needs a current admission.
    await accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'translation.authorize'`,
    [actor, authorization]);
    const inherited = await send(app, { ...official, targetMainRevision: secondSelection.mainRevision,
      evidence: 'https://publisher.example/authorization/release-two' });
    expect(inherited.status).toBe(403);
    expect((await links(b.mainVersion, secondRelease.mainRevision)).links).toEqual([]);
    const thirdParty = await send(app, { ...official, targetMainRevision: secondSelection.mainRevision,
      sourceMainRevision: null, status: 'third-party',
      evidence: 'https://publisher.example/edition/release-two' });
    expect(thirdParty.status).toBe(201);
    expect(await links(b.mainVersion, secondRelease.mainRevision)).toMatchObject({ complete: true,
      links: [{ status: 'third-party', sourceVersionStatus: 'unresolved', sourceMainRevision: null,
        authorizingParty: null, authorizationScope: null, authorizationEpoch: null }] });
    expect(await links(b.mainVersion, firstRelease.mainRevision)).toMatchObject({
      links: [{ link: officialLink.link, status: 'official', authorizationScope: authorization }] });

    // Localized display metadata is a Work revision; it changes no Main Version or content language.
    for (const [target, title] of [[a, '英文原著 A 的中文显示标题'],
      [b, 'Official Chinese B, English display title']] as const) {
      const edited = await post('/v1/content-edits', { profile: 'metadata-only-v1', work: target.work,
        expectedHead: target.workRevision, title, actingSubject: actor });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ work: target.work, predecessor: target.workRevision });
    }
    const heads = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(a.mainVersion)} rv:head ${iri(a.mainRevision)} .
        ${iri(b.mainVersion)} rv:head ${iri(secondSelection.mainRevision)} .
      }
    }`);
    expect(heads.boolean).toBe(true);
    expect((await listEligibleNativeVariants(env, a.mainVersion, 'zh')).variants).toEqual([]);
    expect((await listEligibleNativeVariants(env, a.mainVersion, 'en')).variants)
      .toMatchObject([{ contribution: english.contribution }]);
    expect((await links(a.mainVersion, a.mainRevision)).links).toEqual([]);
    for (const [release, body] of [[firstRelease, '第一版官方中文正文'],
      [secondRelease, '第二版中文正文']] as const) {
      expect(await readRelease(release.release)).toMatchObject({ release: release.release,
        mainRevision: release.mainRevision, language: 'zh', body });
    }
    expect((await links(b.mainVersion, firstRelease.mainRevision)).links)
      .toMatchObject([{ contentLanguage: 'zh', status: 'official' }]);
  } finally {
    await close();
  }
}, 180_000);
