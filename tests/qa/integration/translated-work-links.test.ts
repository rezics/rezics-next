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
import { activateMetadataWork, DATASET, GRAPHS, ID, RV, iri, lit, metadataWorkRequestDigest,
  type WorkActivationEnvironment, type WorkActivationReceipt } from '../../../services/main/src/modules/work/activate.ts';
import { listEligibleNativeVariants, readEligibleNativeVariant }
  from '../../../services/main/src/modules/work/native-variants.ts';

const root = resolve(import.meta.dir, '../../..');
const PROFILE = 'https://rezics.com/definition/translation-link-v1';

function translationFixture(label: string) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const directory = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: WorkActivationEnvironment = { fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
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
  const installLink = async (input: { target: WorkActivationReceipt; revision: string;
    source: WorkActivationReceipt; sourceRevision: string | null; status: 'official' | 'third-party';
    language: string; translator: string; evidence: string; scope: string | null }) => {
    const link = ID + randomUUID();
    const exact = input.sourceRevision !== null;
    const official = input.status === 'official';
    await env.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(link)} a rv:TranslationLink ;
        rv:targetWork ${iri(input.target.work)} ;
        rv:targetMainVersion ${iri(input.target.mainVersion)} ;
        rv:targetMainRevision ${iri(input.revision)} ;
        rv:sourceWork ${iri(input.source.work)} ;
        rv:sourceMainVersion ${iri(input.source.mainVersion)} ;
        ${exact ? `rv:sourceMainRevision ${iri(input.sourceRevision!)} ;` : ''}
        rv:sourceVersionStatus rv:${exact ? 'Exact' : 'Unresolved'} ;
        rv:translationStatus rv:${official ? 'Official' : 'ThirdParty'} ;
        rv:contentLanguage ${lit(input.language)} ;
        rv:translator ${iri(input.translator)} ; rv:publisher ${iri(actor)} ;
        rv:evidence ${lit(input.evidence)} ; rv:linkedBy ${iri(actor)}
        ${official ? `; rv:authorizingParty ${iri(actor)} ;
          rv:authorizationScope ${lit(input.scope!)} ; rv:authorizationEpoch ${lit('1')}` : ''} ;
        rv:modelRevision <${PROFILE}> ; rv:shapeRevision <${PROFILE}> ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence 1 .
    } }`);
    return link;
  };
  const close = async () => {
    await accessPool.end();
    rmSync(directory, { recursive: true, force: true });
  };
  return { env, accessPool, actor, principal, grant, registerActor, createWork, publish,
    installLink, close };
}

test('WORK02: independent translated Works retain exact and unresolved source provenance', async () => {
  const { env, accessPool, actor, principal, grant, registerActor, createWork, publish,
    installLink, close } = translationFixture('translated-work');
  const translatorOfficial = ID + randomUUID();
  const translatorThirdParty = ID + randomUUID();
  try {
    const [a, b, c, d] = await Promise.all(['Source A', 'Official B', 'Third party C',
      'Unlinked D'].map(label => createWork(`${label} ${randomUUID()}`)));
    expect(new Set([a!.work, b!.work, c!.work, d!.work]).size).toBe(4);
    expect(new Set([a!.mainVersion, b!.mainVersion, c!.mainVersion, d!.mainVersion]).size).toBe(4);
    const bPublication = await publish(b!.work, '官方中文正文');
    const cPublication = await publish(c!.work, '独立中文正文');
    await registerActor();
    await grant(`publication:select:${b!.mainVersion}`, 'publication.select');
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access: new AccessAdmissionRegistry(accessPool) });
    const authorization = `translation:authorize:${a!.work}:${a!.mainRevision}`;
    const officialLink = await installLink({ target: b!, revision: b!.mainRevision, source: a!,
      sourceRevision: a!.mainRevision, status: 'official', language: 'zh', translator: translatorOfficial,
      evidence: 'https://publisher.example/authorization/first', scope: authorization });
    await installLink({ target: c!, revision: c!.mainRevision, source: a!, sourceRevision: null,
      status: 'third-party', language: 'zh', translator: translatorThirdParty,
      evidence: 'https://publisher.example/edition/independent', scope: null });
    const retired = await app.handle(new Request('http://main.local/v1/translation-links', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'translation-link-v1', targetWork: d!.work,
        targetMainVersion: d!.mainVersion, targetMainRevision: d!.mainRevision, sourceWork: a!.work,
        sourceMainVersion: a!.mainVersion, sourceMainRevision: a!.mainRevision, status: 'official',
        contentLanguage: 'zh', translator: translatorOfficial, publisher: actor,
        evidence: 'https://publisher.example/retired', actingSubject: actor }),
    }));
    expect(retired.status).toBe(404);
    const read = async (main: string, revision: string) => app.handle(new Request(
      `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/translation-links`));
    const bLinks = await read(b!.mainVersion, b!.mainRevision);
    expect(bLinks.status).toBe(200);
    expect(await bLinks.json()).toMatchObject({ complete: true, links: [{ link: officialLink,
      sourceWork: a!.work, sourceMainRevision: a!.mainRevision, sourceVersionStatus: 'exact',
      status: 'official', authorizingParty: actor, authorizationScope: authorization,
      contentLanguage: 'zh' }] });
    expect(await (await read(c!.mainVersion, c!.mainRevision)).json()).toMatchObject({ complete: true,
      links: [{ sourceWork: a!.work, sourceMainRevision: null, sourceVersionStatus: 'unresolved',
        status: 'third-party', authorizingParty: null, authorizationScope: null }] });
    expect(await (await read(d!.mainVersion, d!.mainRevision)).json()).toMatchObject({ complete: true, links: [] });
    expect(await listEligibleNativeVariants(env, a!.mainVersion)).toMatchObject({ work: a!.work, variants: [] });
    expect((await listEligibleNativeVariants(env, b!.mainVersion, 'zh')).variants)
      .toMatchObject([{ contribution: bPublication.contribution }]);
    expect((await listEligibleNativeVariants(env, c!.mainVersion, 'zh')).variants)
      .toMatchObject([{ contribution: cPublication.contribution }]);
    expect((await readEligibleNativeVariant(env, b!.mainVersion, bPublication.contribution))?.body)
      .toBe('官方中文正文');
    expect((await readEligibleNativeVariant(env, c!.mainVersion, cPublication.contribution))?.body)
      .toBe('独立中文正文');
    const unknownRevision = await read(b!.mainVersion, ID + randomUUID());
    expect(unknownRevision.status).toBe(404);
    const selectedResponse = await app.handle(new Request('http://main.local/v1/publication-selections', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: b!.mainVersion }, work: b!.work,
        contribution: bPublication.contribution, publicationDecision: bPublication.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor }),
    }));
    expect(selectedResponse.status, await selectedResponse.clone().text()).toBe(201);
    const selected = await selectedResponse.json() as { mainRevision: string };
    expect(selected.mainRevision).not.toBe(b!.mainRevision);
    expect(await (await read(b!.mainVersion, selected.mainRevision)).json())
      .toMatchObject({ complete: true, links: [] });
    expect(await (await read(b!.mainVersion, b!.mainRevision)).json())
      .toMatchObject({ complete: true, links: [{ link: officialLink, status: 'official' }] });
  } finally {
    await close();
  }
}, 180_000);

test('WORK02: newer fixed releases inherit no translation coverage or official authorization, and metadata localization keeps content language', async () => {
  const { env, accessPool, actor, principal, grant, registerActor, createWork, publish,
    installLink, close } = translationFixture('translated-release');
  try {
    const [a, b] = await Promise.all([createWork(`English source A ${randomUUID()}`),
      createWork(`Official Chinese B ${randomUUID()}`)]);
    const english = await publish(a!.work, 'English source body', 'en');
    const first = await publish(b!.work, '第一版官方中文正文');
    const second = await publish(b!.work, '第二版中文正文');
    await registerActor();
    const authorization = `translation:authorize:${a!.work}:${a!.mainRevision}`;
    for (const [scope, action] of [[`publication:select:${b!.mainVersion}`, 'publication.select'],
      [`release:seal:${b!.mainVersion}`, 'release.seal'], [`work:read:${b!.work}`, 'work.read'],
      [`work:edit:${a!.work}`, 'work.edit'], [`work:edit:${b!.work}`, 'work.edit']] as const) {
      await grant(scope, action);
    }
    const app = createMainApp(env.fuseki, { environment: env,
      account: { verify: async () => principal }, access: new AccessAdmissionRegistry(accessPool) });
    const post = (path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
    const links = async (main: string, revision: string) => {
      const response = await app.handle(new Request(
        `http://main.local/v1/main-versions/${main.slice(ID.length)}/revisions/${revision.slice(ID.length)}/translation-links`));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ complete: boolean; links: Array<Record<string, unknown>> }>;
    };
    const select = async (published: { contribution: string; decision: string },
      expectedSelectionHead: string | null) => {
      const response = await post('/v1/publication-selections', { profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: b!.mainVersion }, work: b!.work,
        contribution: published.contribution, publicationDecision: published.decision,
        expectedSelectionHead, selectionBasis: 'main-maintainer', actingSubject: actor });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ mainRevision: string; selection: string }>;
    };
    type Release = { release: string; mainRevision: string; language: string; body: string };
    const seal = async (selected: { mainRevision: string; selection: string }) => {
      const response = await post('/v1/fixed-releases', { profile: 'fixed-native-text-release-v1',
        work: b!.work, mainVersion: b!.mainVersion, expectedMainRevision: selected.mainRevision,
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
    const officialLink = await installLink({ target: b!, revision: firstSelection.mainRevision, source: a!,
      sourceRevision: a!.mainRevision, status: 'official', language: 'zh', translator: ID + randomUUID(),
      evidence: 'https://publisher.example/authorization/release-one', scope: authorization });
    const firstRelease = await seal(firstSelection);
    expect(firstRelease).toMatchObject({ mainRevision: firstSelection.mainRevision,
      language: 'zh', body: '第一版官方中文正文' });
    for (const field of authorityFields) expect(firstRelease).not.toHaveProperty(field);
    expect(await links(b!.mainVersion, firstRelease.mainRevision)).toMatchObject({ complete: true,
      links: [{ link: officialLink, status: 'official', authorizingParty: actor,
        authorizationScope: authorization, contentLanguage: 'zh' }] });
    const secondSelection = await select(second, firstSelection.selection);
    expect(secondSelection.mainRevision).not.toBe(firstSelection.mainRevision);
    const secondRelease = await seal(secondSelection);
    expect(secondRelease.release).not.toBe(firstRelease.release);
    expect(secondRelease).toMatchObject({ mainRevision: secondSelection.mainRevision,
      language: 'zh', body: '第二版中文正文' });
    for (const field of authorityFields) expect(secondRelease).not.toHaveProperty(field);
    expect(await links(b!.mainVersion, secondRelease.mainRevision))
      .toEqual(expect.objectContaining({ complete: true, links: [] }));
    const inherited = await post('/v1/translation-links', { profile: 'translation-link-v1',
      targetWork: b!.work, targetMainVersion: b!.mainVersion, targetMainRevision: secondSelection.mainRevision,
      sourceWork: a!.work, sourceMainVersion: a!.mainVersion, sourceMainRevision: a!.mainRevision,
      status: 'official', contentLanguage: 'zh', translator: actor, publisher: actor,
      evidence: 'https://publisher.example/authorization/release-two', actingSubject: actor });
    expect(inherited.status).toBe(404);
    expect((await links(b!.mainVersion, secondRelease.mainRevision)).links).toEqual([]);
    await installLink({ target: b!, revision: secondSelection.mainRevision, source: a!, sourceRevision: null,
      status: 'third-party', language: 'zh', translator: actor,
      evidence: 'https://publisher.example/edition/release-two', scope: null });
    expect(await links(b!.mainVersion, secondRelease.mainRevision)).toMatchObject({ complete: true,
      links: [{ status: 'third-party', sourceVersionStatus: 'unresolved', sourceMainRevision: null,
        authorizingParty: null, authorizationScope: null, authorizationEpoch: null }] });
    expect(await links(b!.mainVersion, firstRelease.mainRevision)).toMatchObject({
      links: [{ link: officialLink, status: 'official', authorizationScope: authorization }] });
    for (const [target, title] of [[a!, '英文原著 A 的中文显示标题'],
      [b!, 'Official Chinese B, English display title']] as const) {
      const edited = await post('/v1/content-edits', { profile: 'metadata-only-v1', work: target.work,
        expectedHead: target.workRevision, title, actingSubject: actor });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ work: target.work, predecessor: target.workRevision });
    }
    const heads = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(a!.mainVersion)} rv:head ${iri(a!.mainRevision)} .
        ${iri(b!.mainVersion)} rv:head ${iri(secondSelection.mainRevision)} .
      }
    }`);
    expect(heads.boolean).toBe(true);
    expect((await listEligibleNativeVariants(env, a!.mainVersion, 'zh')).variants).toEqual([]);
    expect((await listEligibleNativeVariants(env, a!.mainVersion, 'en')).variants)
      .toMatchObject([{ contribution: english.contribution }]);
    expect((await links(a!.mainVersion, a!.mainRevision)).links).toEqual([]);
    for (const [release, body] of [[firstRelease, '第一版官方中文正文'],
      [secondRelease, '第二版中文正文']] as const) {
      expect(await readRelease(release.release)).toMatchObject({ release: release.release,
        mainRevision: release.mainRevision, language: 'zh', body });
    }
    expect((await links(b!.mainVersion, firstRelease.mainRevision)).links)
      .toMatchObject([{ contentLanguage: 'zh', status: 'official' }]);
  } finally {
    await close();
  }
}, 180_000);
