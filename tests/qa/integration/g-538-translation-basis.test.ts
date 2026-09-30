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

test('G-538: translation publication basis guards Works and chapters in both orders, retries and concurrent commands', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the QA integration tier');
  }
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'content']);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  const directory = `.temp/g-538-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const rights = new RightsStore(contentPool, accessPool);
    const graph = new RacingGraph(Bun.env.FUSEKI_URL);
    const env = { fuseki: graph,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: directory };
    const principal = { issuer: 'https://qa-g-538.test', subject: randomUUID() };
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
      const title = `G-538 ${randomUUID()}`;
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
        evidence: { source: 'G-538 current public-domain fixture' }, obligations: [], expectedAssessment: null,
        idempotencyKey: randomUUID() });
    }
    async function publication(target: WorkActivationReceipt, actor: string, publicDomain = false) {
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const accepted = publicDomain ? await assessment(target.work, actor) : undefined;
      const draft = await success<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
        await send('/v1/content-drafts', { profile: publicDomain ? 'content-public-domain-text-v1' : 'content-text-v1',
          resourceId: target.work, variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr', expectedHead: null, body: `G-538 translation ${randomUUID()}`, actingSubject: actor,
          ...(accepted ? { assessmentId: accepted.assessmentId, source: { provider: 'project-gutenberg',
            identifier: 'ebook/1342', url: 'https://www.gutenberg.org/ebooks/1342',
            byteDigest: 'a'.repeat(64), retrievedAt: new Date().toISOString() } } : {}) }));
      const published = await success<{ decision: string }>(await send('/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: `g-538-${randomUUID()}`, revisionId: draft.revisionId,
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
        translator, publisher: actor, evidence: 'https://example.test/g-538/translation', actingSubject: actor };
    }
    const source = await work(author);
    await success(await send('/v1/content-search-eligibility', await publication(source, author)));

    // Link first: even verified original-author draft provenance cannot publish the translation.
    const linkedFirst = await work(translator);
    await success(await send('/v1/translation-links', link(linkedFirst, source)));
    const blocked = await publication(linkedFirst, translator);
    const blockedKey = randomUUID();
    await denied(await send('/v1/content-search-eligibility', blocked, blockedKey));
    await denied(await send('/v1/content-search-eligibility', blocked, blockedKey));

    // Publish first: reject exact and unresolved links, and preserve the public decision.
    const publishedFirst = await work(translator);
    const published = await publication(publishedFirst, translator);
    await success(await send('/v1/content-search-eligibility', published));
    const linkKey = randomUUID();
    await denied(await send('/v1/translation-links', link(publishedFirst, source), linkKey));
    await denied(await send('/v1/translation-links', link(publishedFirst, source), linkKey));
    await denied(await send('/v1/translation-links', { ...link(publishedFirst, source), sourceMainRevision: null }));
    const state = await graph.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
      ?link a rv:TranslationLink ; rv:targetWork ${iri(publishedFirst.work)} . } }`);
    expect(state.boolean).toBe(false);

    // Studio publishes per chapter; a book-level link covers nested chapters too.
    for (const first of ['link', 'publication']) {
      for (const depth of [1, 2]) {
        const book = await work(translator);
        let part = book;
        for (let level = 0; level < depth; level++) part = await chapter(part, translator);
        const eligibility = await publication(part, translator);
        if (first === 'link') {
          await success(await send('/v1/translation-links', link(book, source)));
          await denied(await send('/v1/content-search-eligibility', eligibility));
        } else {
          await success(await send('/v1/content-search-eligibility', eligibility));
          await denied(await send('/v1/translation-links', link(book, source)));
        }
      }
    }

    // Link certifiers cannot substitute their own source authorship for the Content author's.
    await grant(author, `translation:authorize:${source.work}:${source.mainRevision}`, 'translation.authorize');
    await grant(author, `translation:link:${publishedFirst.work}`, 'translation.link');
    await denied(await send('/v1/translation-links', { ...link(publishedFirst, source, author), status: 'official' }));

    // The author may translate their own Work in either order.
    for (const first of ['link', 'publication']) {
      for (const withChapter of [false, true]) {
        const own = await work(author);
        const target = withChapter ? await chapter(own, author) : own;
        const eligibility = await publication(target, author);
        if (first === 'publication') await success(await send('/v1/content-search-eligibility', eligibility));
        await success(await send('/v1/translation-links', link(own, source, author)));
        if (first === 'link') await success(await send('/v1/content-search-eligibility', eligibility));
      }
    }

    // A current public-domain source permits the translator's original contribution
    // in either order, on the book itself or its chapter. The translation is not PD.
    const pdSource = await work(author);
    const pdEligibility = await publication(pdSource, author, true);
    const pdDecision = await success<{ decision: string }>(await send('/v1/content-search-eligibility', pdEligibility));
    const linkedToPd: WorkActivationReceipt[] = [];
    for (const first of ['link', 'publication']) {
      for (const withChapter of [false, true]) {
        const book = await work(translator);
        const target = withChapter ? await chapter(book, translator) : book;
        const eligibility = await publication(target, translator);
        if (first === 'publication') await success(await send('/v1/content-search-eligibility', eligibility));
        await success(await send('/v1/translation-links', link(book, pdSource)));
        if (first === 'link') await success(await send('/v1/content-search-eligibility', eligibility));
        // A second variant on the linked translation follows the same source basis.
        await success(await send('/v1/content-search-eligibility', await publication(target, translator)));
        linkedToPd.push(target);
      }
    }

    // Every inherited source must be eligible; one PD source cannot waive another.
    const mixedBook = await work(translator);
    const mixedChapter = await chapter(mixedBook, translator);
    await success(await send('/v1/translation-links', link(mixedBook, pdSource)));
    await success(await send('/v1/translation-links', link(mixedChapter, source)));
    await denied(await send('/v1/content-search-eligibility', await publication(mixedChapter, translator)));

    // Multiple PD sources are pinned independently, including inherited links.
    const secondPdSource = await work(author);
    await success(await send('/v1/content-search-eligibility', await publication(secondPdSource, author, true)));
    const multiPdBook = await work(translator);
    const multiPdChapter = await chapter(multiPdBook, translator);
    await success(await send('/v1/translation-links', link(multiPdBook, pdSource)));
    await success(await send('/v1/translation-links', link(multiPdChapter, secondPdSource)));
    await success(await send('/v1/content-search-eligibility', await publication(multiPdChapter, translator)));

    // Pin the source graph decision used by preflight, so replacing its head
    // before the eligibility transaction cannot retain a stale PD exemption.
    const pinTarget = await work(translator);
    await success(await send('/v1/translation-links', link(pinTarget, pdSource)));
    const pinEligibility = await publication(pinTarget, translator);
    let pinnedUpdate = '';
    graph.beforeCommand = async envelope => {
      pinnedUpdate = envelope.update;
      await graph.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(pdEligibility.variantId)} rv:publicSearchEligibilityHead ${iri(pdDecision.decision)} . } }`);
    };
    await denied(await send('/v1/content-search-eligibility', pinEligibility));
    expect(pinnedUpdate).toContain(iri(pdDecision.decision));
    expect(pinnedUpdate).toContain(`urn:rezics:rights:assessment:${pdEligibility.assessmentId}`);
    await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(pdEligibility.variantId)} rv:publicSearchEligibilityHead ${iri(pdDecision.decision)} . } }`);

    // A withdrawn source assessment blocks both a new link and further publication
    // on translations whose links already exist, including chapter variants.
    const pdAssessmentId = pdEligibility.assessmentId;
    if (!pdAssessmentId) throw new Error('Public-domain source assessment is missing');
    await rights.assess(principal, { actingSubject: author, material: publicDomainWorkMaterial(pdSource.work),
      expressionKind: 'expression', ...PUBLIC_DOMAIN_TEXT_USE, basis: 'public_domain', outcome: 'not_supported',
      licenseInstrument: null, exceptionKind: null, rationale: null, extent: {},
      evidence: { source: 'G-538 withdrawal fixture' }, obligations: [], expectedAssessment: pdAssessmentId,
      idempotencyKey: randomUUID() });
    const staleSourceTranslation = await work(translator);
    await success(await send('/v1/content-search-eligibility', await publication(staleSourceTranslation, translator)));
    await denied(await send('/v1/translation-links', link(staleSourceTranslation, pdSource)));
    for (const target of linkedToPd) {
      await denied(await send('/v1/content-search-eligibility', await publication(target, translator)));
    }

    // Removing either transaction guard makes one of these requests return 201.
    for (const withChapter of [true, false]) {
      const racePublish = await work(translator);
      const publishTarget = withChapter ? await chapter(racePublish, translator) : racePublish;
      const raceEligibility = await publication(publishTarget, translator);
      graph.beforeCommand = async envelope => {
        expect(envelope.update).toContain('rv:ContentSearchEligibilityDecision');
        await success(await send('/v1/translation-links', link(racePublish, source)));
      };
      await denied(await send('/v1/content-search-eligibility', raceEligibility));
      const raceLink = await work(translator);
      const linkTarget = withChapter ? await chapter(raceLink, translator) : raceLink;
      const racePublic = await publication(linkTarget, translator);
      graph.beforeCommand = async envelope => {
        expect(envelope.update).toContain('a rv:TranslationLink');
        await success(await send('/v1/content-search-eligibility', racePublic));
      };
      await denied(await send('/v1/translation-links', link(raceLink, source)));
    }
  } finally {
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
