import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { DATASET, GRAPHS, ID, RV, initializeFreshGraph, iri, lit,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { readTranslationLinks, TranslationBasisRequired }
  from '../../../services/main/src/modules/work/translation-links.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');
const PROFILE = 'https://rezics.com/definition/translation-link-v1';

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync(...scriptCommand(args), { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
}

test('WORK02/OPS03: isolated graph loss restores exact translated Work links from retained events', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const liveRunId = `translation-${randomUUID().slice(0, 12)}`;
  const directory = join(root, '.temp', `translation-restore-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let accessPool: Pool | undefined;
  try {
    rootCommand(['stack:up', '--profile', 'qa', '--run-id', liveRunId], 180_000);
    const liveApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveRunId }), 'apps.env'));
    const liveFuseki = new FusekiClient(liveApps.FUSEKI_URL!,
      liveApps.FUSEKI_MAINTENANCE_TOKEN!, liveApps.FUSEKI_COMMAND_TOKEN!);
    accessPool = new Pool({ connectionString: liveApps.ACCESS_DATABASE_URL, max: 4 });
    const directorySql = join(root, 'services/main/migrations/access');
    for (const file of schemaFiles(root, 'access')) {
      await accessPool.query(await Bun.file(join(directorySql, file)).text());
    }
    const lineage = { dataEpoch: liveApps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const liveEnv: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(liveFuseki, lineage);
    const principal = { issuer: 'https://qa-translation-recovery.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = ID + randomUUID();
    const translatorOfficial = ID + randomUUID();
    const translatorThirdParty = ID + randomUUID();
    const account = { verify: async () => principal };
    const request = new Request('https://main.rezics.test/v1/works', {
      headers: { authorization: 'Bearer recovery' },
    });
    const access = new AccessAdmissionRegistry(accessPool);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [actor, 'agent']);
    const grant = async (scope: string, action: string) => {
      await accessPool!.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [scope]);
      await accessPool!.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool!.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    };
    await grant('work:create:root', 'work.create');
    const source = await createAdmittedMetadataWork(liveEnv, account, access, request,
      { title: 'Retained source A', actingSubject: actor, idempotencyKey: `source-${randomUUID()}` });
    const officialTarget = await createAdmittedMetadataWork(liveEnv, account, access, request,
      { title: 'Retained official B', actingSubject: actor, idempotencyKey: `official-${randomUUID()}` });
    const thirdPartyTarget = await createAdmittedMetadataWork(liveEnv, account, access, request,
      { title: 'Retained third-party C', actingSubject: actor, idempotencyKey: `third-${randomUUID()}` });
    expect(new Set([source.work, officialTarget.work, thirdPartyTarget.work]).size).toBe(3);
    const authorization = `translation:authorize:${source.work}:${source.mainRevision}`;
    const install = async (target: typeof officialTarget, status: 'official' | 'third-party',
      translator: string, evidence: string, sourceRevision: string | null) => {
      const link = ID + randomUUID();
      const exact = sourceRevision !== null;
      const official = status === 'official';
      await liveFuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(link)} a rv:TranslationLink ;
          rv:targetWork ${iri(target.work)} ; rv:targetMainVersion ${iri(target.mainVersion)} ;
          rv:targetMainRevision ${iri(target.mainRevision)} ; rv:sourceWork ${iri(source.work)} ;
          rv:sourceMainVersion ${iri(source.mainVersion)} ;
          ${exact ? `rv:sourceMainRevision ${iri(sourceRevision)} ;` : ''}
          rv:sourceVersionStatus rv:${exact ? 'Exact' : 'Unresolved'} ;
          rv:translationStatus rv:${official ? 'Official' : 'ThirdParty'} ;
          rv:contentLanguage ${lit('zh')} ; rv:translator ${iri(translator)} ;
          rv:publisher ${iri(actor)} ; rv:evidence ${lit(evidence)} ; rv:linkedBy ${iri(actor)}
          ${official ? `; rv:authorizingParty ${iri(actor)} ;
            rv:authorizationScope ${lit(authorization)} ; rv:authorizationEpoch ${lit('1')}` : ''} ;
          rv:modelRevision <${PROFILE}> ; rv:shapeRevision <${PROFILE}> ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(liveEnv.lineage.dataEpoch)} ;
          rv:sequence 1 .
      } }`);
      return link;
    };
    await install(officialTarget, 'official', translatorOfficial,
      'https://publisher.example/retained-official', source.mainRevision);
    await install(thirdPartyTarget, 'third-party', translatorThirdParty,
      'https://publisher.example/retained-third-party', null);
    const originalOfficial = await readTranslationLinks(liveEnv,
      officialTarget.mainVersion, officialTarget.mainRevision);
    const originalThirdParty = await readTranslationLinks(liveEnv,
      thirdPartyTarget.mainVersion, thirdPartyTarget.mainRevision);
    expect(originalOfficial).toMatchObject([{ targetWork: officialTarget.work, sourceWork: source.work,
      sourceMainRevision: source.mainRevision, sourceVersionStatus: 'exact', status: 'official',
      contentLanguage: 'zh', translator: translatorOfficial, authorizationScope: authorization,
      authorizingParty: actor }]);
    expect(originalThirdParty).toMatchObject([{ targetWork: thirdPartyTarget.work,
      sourceMainRevision: null, sourceVersionStatus: 'unresolved', status: 'third-party',
      translator: translatorThirdParty, authorizingParty: null, authorizationScope: null }]);
    await grant(`contribution:create:${officialTarget.work}`, 'contribution.create');
    const draft = await createAdmittedTextContribution(liveEnv, account, access, request,
      { work: officialTarget.work, language: 'zh', body: '重建后的译本正文',
        actingSubject: actor, idempotencyKey: `draft-${randomUUID()}` });
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('retained translation draft is unavailable');
    }
    await grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publicationInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution',
      disclosure: 'public', actingSubject: actor,
      idempotencyKey: `publication-${randomUUID()}` } as const;
    await expect(publishAdmittedTextContribution(liveEnv, account, access, request,
      publicationInput)).rejects.toBeInstanceOf(TranslationBasisRequired);
    const sourceCredit = ID + randomUUID(), sourceCreditRevision = ID + randomUUID();
    await liveFuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(sourceCredit)} a rv:NativeAgentCredit ;
        rv:work ${iri(source.work)} ; rv:agent ${iri(actor)} ; schema:roleName "author" ;
        rv:creditRevision ${iri(sourceCreditRevision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(sourceCreditRevision)} a rv:NativeAgentCreditRevision ;
        rv:component ${iri(sourceCredit)} ; rv:work ${iri(source.work)} ; rv:agent ${iri(actor)} ;
        rv:workRevision ${iri(source.workRevision)} ; schema:roleName "author" . } }`);
    const publication = await publishAdmittedTextContribution(liveEnv, account, access, request,
      publicationInput);
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('retained translation publication is unavailable');
    }
    await grant(`publication:select:${officialTarget.mainVersion}`, 'publication.select');
    const selection = await selectAdmittedMainDefault(liveEnv, account, access, request,
      { context: { kind: 'main-version-default', id: officialTarget.mainVersion },
        work: officialTarget.work, contribution: draft.contribution,
        publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer',
        actingSubject: actor, idempotencyKey: `selection-${randomUUID()}` });
    if (selection.outcome !== 'succeeded' || !selection.mainRevision) {
      throw new Error('retained Main Version revision is unavailable');
    }
    expect(await readTranslationLinks(liveEnv, officialTarget.mainVersion,
      selection.mainRevision)).toEqual([]);
    expect(await readTranslationLinks(liveEnv, officialTarget.mainVersion,
      officialTarget.mainRevision)).toEqual(originalOfficial);
    expect(await readTranslationLinks(liveEnv, thirdPartyTarget.mainVersion,
      thirdPartyTarget.mainRevision)).toEqual(originalThirdParty);
  } finally {
    await accessPool?.end();
    rootCommand(['stack:reset', '--profile', 'qa', '--run-id', liveRunId], 120_000);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
