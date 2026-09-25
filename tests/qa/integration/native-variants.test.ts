import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { ReaderVariantPreferenceStore } from '../../../services/main/src/modules/work/native-variants.ts';
import { RealmVariantRecommendationStore }
  from '../../../services/main/src/modules/work/realm-variant-recommendation.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest }
  from '../../../services/main/src/modules/work/select-realm.ts';
import { rejectRealmLocal, realmRejectionDigest }
  from '../../../services/main/src/modules/work/reject-realm.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';

const root = resolve(import.meta.dir, '../../..');

test('WORK02: two same-language native variants keep one Main spine and sparse reader choice', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `native-variants-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const principal = { issuer: 'https://qa-native-reader.test', subject: randomUUID() };
  const principalId = randomUUID();
  const otherPrincipal = { issuer: 'https://qa-native-reader.test', subject: randomUUID() };
  const otherPrincipalId = randomUUID();
  const reader = new ReaderVariantPreferenceStore(accessPool);
  const recommendations = new RealmVariantRecommendationStore(accessPool);
  const access = new AccessAdmissionRegistry(accessPool);
  const app = createMainApp(env.fuseki, { environment: env,
    account: { verify: async () => principal }, access,
    readerPreferences: reader, realmRecommendations: recommendations });
  const otherApp = createMainApp(env.fuseki, { environment: env,
    account: { verify: async () => otherPrincipal }, access,
    readerPreferences: reader, realmRecommendations: recommendations });
  const authorA = ID + randomUUID();
  const authorB = ID + randomUUID();
  const admission = (actor: string, scope: string, action: string,
    requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `work02-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  const published = async (work: string, actor: string, body: string, language = 'zh') => {
    const draftInput = { work, language, body, actingSubject: actor };
    const draft = await activateTextContribution(env, admission(actor,
      `contribution:create:${work}`, 'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('native Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const publication = await publishTextContribution(env, admission(actor,
      `contribution:publish:${draft.contribution}`, 'contribution.publish',
      textPublicationDigest(publishInput)), publishInput);
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('native Contribution publication failed');
    }
    return { contribution: draft.contribution, draft: draft.draftRevision,
      decision: publication.publicationDecision };
  };
  const request = (path: string, method = 'GET', body?: unknown, key?: string) =>
    new Request(`http://main.local${path}`, { method,
      headers: { authorization: 'Bearer qa', ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });

  try {
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [otherPrincipalId, otherPrincipal.issuer, otherPrincipal.subject]);
    const title = `Native variants ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission(authorA, 'work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const first = await published(created.work, authorA, '同语版本甲');
    const second = await published(created.work, authorB, '同语版本乙');
    expect(first.contribution).not.toBe(second.contribution);
    expect(first.draft).not.toBe(second.draft);
    const defaultInput = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: first.contribution,
      publicationDecision: first.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: authorA };
    const selected = await selectMainDefault(env, admission(authorA,
      `publication:select:${created.mainVersion}`, 'publication.select',
      mainSelectionDigest(defaultInput)), defaultInput);
    expect(selected.outcome).toBe('succeeded');
    const mainId = created.mainVersion.slice(ID.length);
    const variantsPath = `/v1/main-versions/${mainId}/native-variants?language=zh`;
    const listed = await app.handle(request(variantsPath));
    expect(listed.status).toBe(200);
    const inventory = await listed.json() as { work: string; mainVersion: string; complete: boolean;
      variants: Array<{ contribution: string; selectedDraft: string; author: string;
        language: string }> };
    expect(inventory).toMatchObject({ work: created.work,
      mainVersion: created.mainVersion, complete: true });
    expect(inventory.variants).toHaveLength(2);
    expect(new Set(inventory.variants.map(item => item.contribution)))
      .toEqual(new Set([first.contribution, second.contribution]));
    expect(inventory.variants.find(item => item.contribution === first.contribution))
      .toMatchObject({ selectedDraft: first.draft, author: authorA, language: 'zh' });
    expect(inventory.variants.find(item => item.contribution === second.contribution))
      .toMatchObject({ selectedDraft: second.draft, author: authorB, language: 'zh' });
    const personalPath = `/v1/me/main-versions/${mainId}/selection`;
    const ordinary = await app.handle(request(personalPath));
    expect(ordinary.status).toBe(200);
    expect(await ordinary.json()).toMatchObject({ work: created.work,
      mainVersion: created.mainVersion, mainSelection: selected.selection,
      reason: 'main-default', preference: null,
      chosen: { contribution: first.contribution, body: '同语版本甲' } });
    const prefPath = `/v1/me/main-versions/${mainId}/variant-preference`;
    const preferenceBody = { profile: 'reader-native-variant-preference-v1',
      contribution: second.contribution, expectedRevision: null };
    const key = `prefer-${randomUUID()}`;
    const saved = await app.handle(request(prefPath, 'PUT', preferenceBody, key));
    expect(saved.status).toBe(201);
    const preference = await saved.json() as { preference: { contribution: string; revision: string };
      replayed: boolean };
    expect(preference.replayed).toBe(false);
    expect(preference.preference.contribution).toBe(second.contribution);
    const replay = await app.handle(request(prefPath, 'PUT', preferenceBody, key));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ preference: preference.preference, replayed: true });
    const conflictingReplay = await app.handle(request(prefPath, 'PUT', {
      ...preferenceBody, contribution: first.contribution,
    }, key));
    expect(conflictingReplay.status).toBe(409);
    expect(await conflictingReplay.json()).toMatchObject({ code: 'idempotency_conflict' });
    const staleWrite = await app.handle(request(prefPath, 'PUT', {
      ...preferenceBody, contribution: first.contribution,
    }, `stale-${randomUUID()}`));
    expect(staleWrite.status).toBe(409);
    expect(await staleWrite.json()).toMatchObject({ code: 'stale_head' });
    expect(await reader.read(principalId, created.mainVersion)).toEqual(preference.preference);
    const preferred = await app.handle(request(personalPath));
    expect(preferred.status).toBe(200);
    expect(await preferred.json()).toMatchObject({ work: created.work,
      mainVersion: created.mainVersion, mainSelection: null,
      reason: 'personal-preference', preference: preference.preference,
      chosen: { contribution: second.contribution, selectedDraft: second.draft,
        author: authorB, language: 'zh', body: '同语版本乙' } });
    const otherOrdinary = await otherApp.handle(request(personalPath));
    expect(otherOrdinary.status).toBe(200);
    expect(await otherOrdinary.json()).toMatchObject({ reason: 'main-default', preference: null,
      chosen: { contribution: first.contribution, body: '同语版本甲' } });
    const otherSaved = await otherApp.handle(request(prefPath, 'PUT', {
      ...preferenceBody, contribution: first.contribution,
    }, `other-prefer-${randomUUID()}`));
    expect(otherSaved.status).toBe(201);
    const otherChoice = await otherSaved.json() as { preference: { contribution: string; revision: string } };
    expect(otherChoice.preference.contribution).toBe(first.contribution);
    const otherSelected = await otherApp.handle(request(personalPath));
    expect(otherSelected.status).toBe(200);
    expect(await otherSelected.json()).toMatchObject({ reason: 'personal-preference',
      preference: otherChoice.preference,
      chosen: { contribution: first.contribution, body: '同语版本甲' } });
    const stillPreferred = await app.handle(request(personalPath));
    expect(stillPreferred.status).toBe(200);
    expect(await stillPreferred.json()).toMatchObject({ reason: 'personal-preference',
      preference: preference.preference,
      chosen: { contribution: second.contribution, body: '同语版本乙' } });
    const publicDefault = await app.handle(request(`/v1/main-versions/${mainId}/selection`));
    expect(publicDefault.status).toBe(200);
    expect(await publicDefault.json()).toMatchObject({ contribution: first.contribution,
      body: '同语版本甲' });

    // A published preference cannot authorize a draft-only third Contribution.
    const unpublishedInput = { work: created.work, language: 'zh', body: '未发布',
      actingSubject: authorB };
    const unpublished = await activateTextContribution(env, admission(authorB,
      `contribution:create:${created.work}`, 'contribution.create',
      textContributionDigest(unpublishedInput)), unpublishedInput);
    if (!unpublished.contribution) throw new Error('unpublished Contribution is absent');
    const rejectedWrite = await app.handle(request(prefPath, 'PUT', {
      profile: 'reader-native-variant-preference-v1',
      contribution: unpublished.contribution, expectedRevision: preference.preference.revision,
    }, `unpublished-${randomUUID()}`));
    expect(rejectedWrite.status).toBe(404);
    expect((await reader.read(principalId, created.mainVersion))?.contribution).toBe(second.contribution);

    // Model a previously saved choice whose publication is now ineligible.
    // The consumer rechecks the graph and falls back without rewriting the row.
    const stale = await reader.set(principalId, { mainVersion: created.mainVersion,
      contribution: unpublished.contribution,
      expectedRevision: preference.preference.revision, idempotencyKey: `stale-${randomUUID()}` });
    expect(stale.preference?.contribution).toBe(unpublished.contribution);
    if (!stale.preference) throw new Error('saved preference disappeared');
    const fallback = await app.handle(request(personalPath));
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ reason: 'preferred-ineligible',
      preference: stale.preference, mainSelection: selected.selection,
      chosen: { contribution: first.contribution, body: '同语版本甲' } });
    const cleared = await app.handle(request(prefPath, 'PUT', {
      profile: 'reader-native-variant-preference-v1', contribution: null,
      expectedRevision: stale.preference.revision,
    }, `clear-${randomUUID()}`));
    expect(cleared.status).toBe(201);
    expect(await cleared.json()).toMatchObject({ preference: null, replayed: false });
    expect(await reader.read(principalId, created.mainVersion)).toBeNull();
    const afterClear = await app.handle(request(personalPath));
    expect(afterClear.status).toBe(200);
    expect(await afterClear.json()).toMatchObject({ reason: 'main-default', preference: null,
      chosen: { contribution: first.contribution, body: '同语版本甲' } });

    const realmInput = { name: `Native recommendations ${randomUUID()}`, actingSubject: authorA };
    const space = await createRealmSpace(env, admission(authorA, 'space:create:root',
      'space.create', spaceCreationDigest(realmInput)), realmInput);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('Realm creation failed');
    const realm = space.realm;
    const realmId = realm.slice(ID.length);
    const managerScope = `publication:adopt:${realm}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [managerScope]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`,
      [authorA]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'publication.adopt', now() + interval '1 hour')`,
    [randomUUID(), principalId, authorA]);
    const grantId = randomUUID();
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'publication.adopt', now() + interval '1 hour')`,
    [grantId, authorA, managerScope]);
    const realmPath = `/v1/me/realms/${realmId}/main-versions/${mainId}/selection`;
    const recommendationPath = `/v1/realms/${realmId}/main-versions/${mainId}/variant-recommendation`;
    expect(await (await app.handle(request(realmPath))).json()).toMatchObject({
      status: 'selected', reason: 'main-default', realm,
      chosen: { contribution: first.contribution } });
    const recommendationBody = { profile: 'realm-native-variant-recommendation-v1',
      contribution: second.contribution, expectedRevision: null, actingSubject: authorA };
    expect((await otherApp.handle(request(recommendationPath, 'PUT', recommendationBody,
      `denied-${randomUUID()}`))).status).toBe(403);
    const recommendationKey = `recommend-${randomUUID()}`;
    const recommended = await app.handle(request(recommendationPath, 'PUT',
      recommendationBody, recommendationKey));
    expect(recommended.status).toBe(201);
    const recommendation = await recommended.json() as { recommendation: {
      contribution: string; revision: string }; replayed: boolean };
    expect(recommendation).toMatchObject({ recommendation: {
      contribution: second.contribution }, replayed: false });
    expect((await app.handle(request(recommendationPath, 'PUT', recommendationBody,
      recommendationKey))).status).toBe(200);
    expect((await app.handle(request(recommendationPath, 'PUT', {
      ...recommendationBody, contribution: first.contribution },
    recommendationKey))).status).toBe(409);
    expect((await app.handle(request(recommendationPath, 'PUT', {
      ...recommendationBody, contribution: first.contribution },
    `stale-${randomUUID()}`))).status).toBe(409);
    const english = await published(created.work, authorB, 'English variant', 'en');
    expect((await app.handle(request(recommendationPath, 'PUT', {
      ...recommendationBody, contribution: english.contribution,
      expectedRevision: recommendation.recommendation.revision,
    }, `wrong-language-${randomUUID()}`))).status).toBe(404);
    expect(await (await app.handle(request(realmPath))).json()).toMatchObject({
      status: 'selected', reason: 'realm-recommendation', recommendation: recommendation.recommendation,
      chosen: { contribution: second.contribution, selectedDraft: second.draft,
        author: authorB, language: 'zh', body: '同语版本乙' } });
    expect(await (await otherApp.handle(request(realmPath))).json()).toMatchObject({
      reason: 'personal-preference', chosen: { contribution: first.contribution } });
    expect(await (await app.handle(request(personalPath))).json()).toMatchObject({
      reason: 'main-default', chosen: { contribution: first.contribution } });
    expect(await (await app.handle(request(`/v1/realms/${realmId}/main-versions/${mainId}/selection`)))
      .json()).toMatchObject({ reason: 'main-fallback', contribution: first.contribution });
    await accessPool.query(`UPDATE access.realm_native_variant_recommendation
      SET contribution = $3 WHERE realm = $1 AND main_version = $2`,
    [realm, created.mainVersion, unpublished.contribution]);
    expect(await (await app.handle(request(realmPath))).json()).toMatchObject({
      reason: 'recommended-ineligible', recommendation: {
        contribution: unpublished.contribution },
      chosen: { contribution: first.contribution } });
    await accessPool.query(`UPDATE access.realm_native_variant_recommendation
      SET contribution = $3 WHERE realm = $1 AND main_version = $2`,
    [realm, created.mainVersion, second.contribution]);
    const adoptionInput = { context: { kind: 'realm-local' as const, id: realm },
      work: created.work, mainVersion: created.mainVersion,
      contribution: first.contribution, publicationDecision: first.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review' as const,
      actingSubject: authorA };
    const adopted = await selectRealmLocal(env, admission(authorA, managerScope,
      'publication.adopt', realmSelectionDigest(adoptionInput)), adoptionInput);
    if (adopted.outcome !== 'succeeded' || !adopted.selection) {
      throw new Error('Realm adoption failed');
    }
    expect(await (await app.handle(request(realmPath))).json()).toMatchObject({
      reason: 'realm-adoption', realmSelection: adopted.selection,
      chosen: { contribution: first.contribution, body: '同语版本甲' } });
    const rejectionInput = { context: adoptionInput.context, work: created.work,
      mainVersion: created.mainVersion, expectedSelectionHead: adopted.selection,
      decisionBasis: 'realm-manager-review' as const, reasonCode: 'not-approved' as const,
      actingSubject: authorA };
    const rejected = await rejectRealmLocal(env, admission(authorA,
      `publication:reject:${realm}`, 'publication.reject',
      realmRejectionDigest(rejectionInput)), rejectionInput);
    if (rejected.outcome !== 'succeeded' || !rejected.rejection) {
      throw new Error('Realm rejection failed');
    }
    expect(await (await app.handle(request(realmPath))).json()).toMatchObject({
      status: 'suppressed', rejection: rejected.rejection });
    expect(await (await otherApp.handle(request(realmPath))).json()).toMatchObject({
      status: 'suppressed', rejection: rejected.rejection });
    const secondRealmInput = { name: `Other Realm ${randomUUID()}`, actingSubject: authorA };
    const secondSpace = await createRealmSpace(env, admission(authorA, 'space:create:root',
      'space.create', spaceCreationDigest(secondRealmInput)), secondRealmInput);
    if (secondSpace.outcome !== 'succeeded' || !secondSpace.realm) {
      throw new Error('second Realm creation failed');
    }
    expect(await (await app.handle(request(`/v1/me/realms/${secondSpace.realm.slice(ID.length)
      }/main-versions/${mainId}/selection`))).json()).toMatchObject({
      status: 'selected', reason: 'main-default',
      chosen: { contribution: first.contribution } });
    const clearedRecommendation = await app.handle(request(recommendationPath, 'PUT', {
      ...recommendationBody, contribution: null,
      expectedRevision: recommendation.recommendation.revision,
    }, `clear-${randomUUID()}`));
    expect(clearedRecommendation.status).toBe(201);
    expect(await clearedRecommendation.json()).toMatchObject({ recommendation: null });
    expect(await recommendations.read(realm, created.mainVersion)).toBeNull();
    await accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [grantId]);
    expect((await app.handle(request(recommendationPath, 'PUT', {
      ...recommendationBody, contribution: null, expectedRevision: null,
    }, `revoked-${randomUUID()}`))).status).toBe(403);
  } finally {
    await accessPool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
