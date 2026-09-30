import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { PUBLIC_DOMAIN_TEXT_USE, publicDomainWorkMaterial, RightsStore }
  from '../../../services/main/src/modules/rights/store.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, RV,
  type WorkActivationReceipt } from '../../../services/main/src/modules/work/activate.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

/** One command interception makes the other operation commit after preflight
 * but before the graph transaction, proving the WHERE guard rather than timing. */
class RacingGraph extends FusekiClient {
  beforeCommand: ((envelope: CommandEnvelope) => Promise<void>) | undefined;
  override async commandWithReceipt(envelope: CommandEnvelope) {
    const hook = this.beforeCommand;
    this.beforeCommand = undefined;
    if (hook) await hook(envelope);
    return super.commandWithReceipt(envelope);
  }
}

test('G-591: text contribution publication requires the source basis, including inherited links, retries and races', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the QA integration tier');
  }
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'content']);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  const directory = `.temp/g-591-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const rights = new RightsStore(contentPool, accessPool);
    const graph = new RacingGraph(Bun.env.FUSEKI_URL);
    const env = { fuseki: graph,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: directory };
    const principal = { issuer: 'https://qa-g-591.test', subject: randomUUID() };
    const principalId = randomUUID();
    const author = id(), translator = id();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [principalId, principal.issuer, principal.subject]);
    for (const actor of [author, translator]) {
      await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [actor]);
    }
    const access = new AccessAdmissionRegistry(accessPool);
    const app = createMainApp(graph, { environment: env,
      account: { verify: async () => principal }, access,
      content, contentAuthoring: content, rights: { store: rights } });
    const send = (path: string, body: object, key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify(body) }));
    async function success<T>(response: Response): Promise<T> {
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json() as Promise<T>;
    }
    async function denied(response: Response) {
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'translation_basis_required' });
    }
    async function grant(actor: string, scope: string, action: string) {
      await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    }
    async function work(actor: string): Promise<WorkActivationReceipt> {
      const title = `G-591 ${randomUUID()}`;
      const result = await activateMetadataWork(env, { title, admission: {
        id: randomUUID(), actingSubject: actor, scope: 'work:create:root', action: 'work.create',
        idempotencyKey: randomUUID(), requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
      // Use the installed NativeAgentCredit representation, never a bare schema:author.
      const credit = id(), revision = id();
      await graph.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:NativeAgentCredit ;
          rv:work ${iri(result.work)} ; rv:agent ${iri(actor)} ; schema:roleName "author" ;
          rv:creditRevision ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:NativeAgentCreditRevision ;
          rv:component ${iri(credit)} ; rv:work ${iri(result.work)} ; rv:agent ${iri(actor)} ;
          schema:roleName "author" . } }`);
      for (const [prefix, action] of [['work:read', 'work.read'], ['content:draft', 'content.draft'], ['content:publish', 'content.publish'],
        ['content:search-eligibility', 'content.search-eligibility'], ['translation:link', 'translation.link']]) {
        await grant(actor, `${prefix}:${result.work}`, action!);
      }
      return result;
    }
    async function chapter(book: WorkActivationReceipt, actor: string): Promise<WorkActivationReceipt> {
      const part = await work(actor);
      await graph.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(part.work)} <https://schema.org/isPartOf> ${iri(book.work)} . } }`);
      return part;
    }
    async function assessment(workId: string, actor: string) {
      await grant(actor, 'rights:assess', 'rights.assess');
      return rights.assess(principal, { actingSubject: actor, material: publicDomainWorkMaterial(workId),
        expressionKind: 'expression', ...PUBLIC_DOMAIN_TEXT_USE, basis: 'public_domain', outcome: 'supported',
        licenseInstrument: null, exceptionKind: null, rationale: null, extent: {},
        evidence: { source: 'G-591 current public-domain fixture' }, obligations: [], expectedAssessment: null,
        idempotencyKey: randomUUID() });
    }
    async function publication(target: WorkActivationReceipt, actor: string, publicDomain = false) {
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const accepted = publicDomain ? await assessment(target.work, actor) : undefined;
      const draft = await success<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
        await send('/v1/content-drafts', { profile: publicDomain ? 'content-public-domain-text-v1' : 'content-text-v1',
          resourceId: target.work, variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr', expectedHead: null, body: `G-591 translation ${randomUUID()}`, actingSubject: actor,
          ...(accepted ? { assessmentId: accepted.assessmentId, source: { provider: 'project-gutenberg',
            identifier: 'ebook/1342', url: 'https://www.gutenberg.org/ebooks/1342',
            byteDigest: 'a'.repeat(64), retrievedAt: new Date().toISOString() } } : {}) }));
      const published = await success<{ decision: string }>(await send('/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: `g-591-${randomUUID()}`, revisionId: draft.revisionId,
        expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
        resourceId: target.work, variantId, expectedPublicationHead: null, actingSubject: actor }));
      return { profile: publicDomain ? 'content-search-eligibility-v2' : 'content-search-eligibility-v1',
        resourceId: target.work, variantId, publicationDecision: published.decision,
        expectedEligibilityHead: null, actingSubject: actor, disclosure: 'public',
        rightsBasis: publicDomain ? 'public-domain' : 'original-contribution',
        ...(accepted ? { assessmentId: accepted.assessmentId } : {}) };
    }
    function link(target: WorkActivationReceipt, source: WorkActivationReceipt, actor = translator) {
      return { profile: 'translation-link-v1', targetWork: target.work, targetMainVersion: target.mainVersion,
        targetMainRevision: target.mainRevision, sourceWork: source.work, sourceMainVersion: source.mainVersion,
        sourceMainRevision: source.mainRevision, status: 'third-party', contentLanguage: 'en',
        translator, publisher: actor, evidence: 'https://example.test/g-591/translation', actingSubject: actor };
    }
    async function contribution(target: WorkActivationReceipt, actor: string) {
      const input = { work: target.work, language: 'zh', body: '译文正文', actingSubject: actor };
      const draft = await activateTextContribution(env, {
        id: randomUUID(), actingSubject: actor, scope: `contribution:create:${target.work}`,
        action: 'contribution.create', idempotencyKey: randomUUID(), requestDigest: textContributionDigest(input),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'claimed', dispatchEligible: true, replayed: false,
      }, input);
      if (!draft.contribution || !draft.draftRevision) throw new Error('Missing contribution draft');
      await grant(actor, `contribution:read:${draft.contribution}`, 'contribution.read');
      await grant(actor, `contribution:publish:${draft.contribution}`, 'contribution.publish');
      return { profile: 'text-publication-v1', contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor };
    }
    async function remainsPrivate(contribution: string) {
      expect((await graph.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(contribution)} rv:publicationHead ?head . } }`)).boolean).toBe(false);
    }
    const source = await work(author);
    await success(await send('/v1/content-search-eligibility', await publication(source, author)));
    // A translator's authorship of the target does not confer rights to the source.
    for (const withChapter of [false, true]) {
      const book = await work(translator);
      const target = withChapter ? await chapter(book, translator) : book;
      await success(await send('/v1/translation-links', link(book, source)));
      const input = await contribution(target, translator);
      const key = randomUUID();
      await denied(await send('/v1/contribution-publications', input, key));
      await denied(await send('/v1/contribution-publications', input, key));
      await remainsPrivate(input.contribution);
    }
    // The same author can translate their own work; replay uses the terminal receipt.
    const own = await work(author);
    await success(await send('/v1/translation-links', link(own, source, author)));
    const ownText = await contribution(own, author);
    const ownKey = randomUUID();
    const published = await success<{ publicationDecision: string }>(await send('/v1/contribution-publications', ownText, ownKey));
    const replay = await send('/v1/contribution-publications', ownText, ownKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ publicationDecision: published.publicationDecision, replayed: true });
    const stale = await send('/v1/contribution-publications', ownText);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_head' });

    const pdSource = await work(author);
    const pdEligibility = await publication(pdSource, author, true);
    const pdDecision = await success<{ decision: string }>(await send('/v1/content-search-eligibility', pdEligibility));
    const pdTarget = await work(translator);
    await success(await send('/v1/translation-links', link(pdTarget, pdSource)));
    await success(await send('/v1/contribution-publications', await contribution(pdTarget, translator)));
    const pdBook = await work(translator);
    const pdChapter = await chapter(pdBook, translator);
    await success(await send('/v1/translation-links', link(pdBook, pdSource)));
    await success(await send('/v1/contribution-publications', await contribution(pdChapter, translator)));

    // A link added after preflight is checked inside the contribution transaction.
    const raced = await work(translator);
    const raceText = await contribution(raced, translator);
    graph.beforeCommand = async envelope => {
      expect(envelope.update).toContain('a rv:PublicationDecision');
      await success(await send('/v1/translation-links', link(raced, source)));
    };
    await denied(await send('/v1/contribution-publications', raceText));
    await remainsPrivate(raceText.contribution);

    // Replacing the PD graph head invalidates the exact source basis pinned by preflight.
    const pinned = await work(translator);
    await success(await send('/v1/translation-links', link(pinned, pdSource)));
    const pinText = await contribution(pinned, translator);
    graph.beforeCommand = async envelope => {
      expect(envelope.update).toContain(iri(pdDecision.decision));
      expect(envelope.update).toContain(`urn:rezics:rights:assessment:${pdEligibility.assessmentId}`);
      await graph.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(pdEligibility.variantId)} rv:publicSearchEligibilityHead ${iri(pdDecision.decision)} . } }`);
    };
    await denied(await send('/v1/contribution-publications', pinText));
    await remainsPrivate(pinText.contribution);
    await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(pdEligibility.variantId)} rv:publicSearchEligibilityHead ${iri(pdDecision.decision)} . } }`);
    // Losing a response after the graph commit still replays the publication receipt.
    const recoveryTarget = await work(author);
    await success(await send('/v1/translation-links', link(recoveryTarget, source, author)));
    const recoveryText = await contribution(recoveryTarget, author);
    const command = graph.commandWithReceipt.bind(graph);
    graph.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      if (envelope.update.includes('a rv:PublicationDecision')) throw new Error('lost response after commit');
      return result;
    };
    await success(await send('/v1/contribution-publications', recoveryText));
    graph.commandWithReceipt = command;
  } finally {
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
