import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { GovernanceStore, GLOBAL_CONTEXT } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { activateMetadataWork, GRAPHS, iri, metadataWorkRequestDigest, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';
import { claimFixture, fixtureReasons } from './g-565-decision-support.ts';

const short = (ref: string) => ref.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Chapter Post search gates each live Book use and restores hits without reprojecting Content', async () => {
  const stack = await startMediaStack('post-search-disclosure', { contentProjection: true });
  try {
    await stack.contentCursor.initialize(stack.contentConsumer);
    const actor = await stack.member('chapter-author');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    const book = async () => {
      const title = `Chapter search Book ${randomUUID()}`;
      const catalogue = { grain: 'new-creative-scope' as const, candidateReceipt: randomUUID() };
      const work = await activateMetadataWork(stack.env, { title, catalogue,
        semanticTypes: ['https://schema.org/Book'],
        admission: stack.admission(actor.actor, 'work:create:root', 'work.create',
          metadataWorkRequestDigest(title, ['https://schema.org/Book'], 'und', { catalogue })) });
      const opening = await stack.contribution(work.work, actor.actor, 'en', 'Book opening');
      const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion },
        work: work.work, contribution: opening.contribution, publicationDecision: opening.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor.actor };
      await selectMainDefault(stack.env, stack.admission(actor.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await actor.grant(`work:edit:${work.work}`, 'work.edit');
      await actor.grant(`work:read:${work.work}`, 'work.read');
      const composition = await json<{ structure: string; revision: string }>(await actor.send('POST',
        '/v1/compositions', { profile: 'book-composition', work: work.work,
          mainVersion: work.mainVersion, actingSubject: actor.actor }), 201);
      return { ...work, composition };
    };
    const first = await book(), second = await book();
    const chapter = await json<{ post: string; compositionRevision: string }>(await actor.send('POST',
      `/v1/works/${short(first.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'Chapter',
        language: 'en', direction: 'ltr', parent: first.composition.structure, position: 'last',
        expectedCompositionHead: first.composition.revision, actingSubject: actor.actor }));
    for (const [scope, action] of [[`work:read:${chapter.post}`, 'work.read'],
      [`content:draft:${chapter.post}`, 'content.draft'], [`content:publish:${chapter.post}`, 'content.publish'],
      [`content:search-eligibility:${chapter.post}`, 'content.search-eligibility']] as const) {
      await actor.grant(scope, action);
    }
    await json(await actor.send('POST', `/v1/compositions/${short(second.composition.structure)}/changes`, {
      profile: 'book-composition', expectedHead: second.composition.revision, actingSubject: actor.actor,
      operations: [{ op: 'insert', role: 'chapter', parent: second.composition.structure,
        position: 'last', target: chapter.post }],
    }));
    const phrase = `chapterdisclosure${randomUUID().replaceAll('-', '')}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      await actor.send('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: chapter.post,
        variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead: null, body: phrase, actingSubject: actor.actor }), 201);
    const publication = await json<{ decision: string }>(await actor.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: randomUUID(), revisionId: draft.revisionId,
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      resourceId: chapter.post, variantId, expectedPublicationHead: null, actingSubject: actor.actor,
    }), 201);
    await json(await actor.send('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: chapter.post, variantId,
      publicationDecision: publication.decision, expectedEligibilityHead: null, actingSubject: actor.actor,
      rightsBasis: 'original-contribution', disclosure: 'public',
    }), 201);
    for (let i = 0; i < 20; i++) {
      if (!await relayContentProjectionOnce(stack.env, stack.content, stack.contentCursor, stack.contentConsumer)) break;
      if (i === 19) throw new Error('Content projection exceeded its preparation budget');
    }
    const rules = new GovernanceRules(stack.accessPool);
    const governance = new GovernanceStore(stack.accessPool, ownerEvidenceCapture({
      graph: { env: stack.env, canReadWork: async () => true },
    }), ownerTargetHeads({ graph: stack.env }), rules,
    ownerModerationEffects(new ContentModeration(stack.contentPool), stack.env));
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async () => actor.principal },
      content: stack.content, contentProjection: { content: stack.content,
        cursor: stack.contentCursor, consumer: stack.contentConsumer }, governance: { store: governance, rules } });
    const query = async (profile: 'public-content-phrase-v1' | 'public-main-phrase-v1') =>
      json<{ total: number; results: { resource?: string; work?: string;
        matchedChapter?: { post: string; book: string } }[] }>(await app.handle(new Request('http://main.local/v1/queries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile, phrase, language: 'en' }),
      })));
    const check = async (books: string[]) => {
      const content = await query('public-content-phrase-v1');
      expect(content.total).toBe(books.length);
      expect(content.results.map(row => row.resource)).toEqual(books.map(() => chapter.post));
      const main = await query('public-main-phrase-v1');
      expect(main.total).toBe(books.length);
      expect(main.results.map(row => row.work).sort()).toEqual([...books].sort());
      expect(main.results.every(row => row.matchedChapter?.post === chapter.post
        && row.matchedChapter.book === row.work)).toBe(true);
    };
    await check([first.work, second.work]);
    const scope = `governance:platform:${randomUUID()}`;
    await actor.grant(scope, 'governance.moderate');
    await actor.grant(scope, 'governance.rule.publish');
    await actor.grant('governance:platform', 'governance.moderate');
    const rule = await rules.publish(actor.principal, { ref: `urn:rezics:rule:${randomUUID()}`, scopeId: scope,
      actingSubject: actor.actor, expectedRevision: null, document: { purpose: 'chapter-search-disclosure' },
      idempotencyKey: randomUUID() });
    const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    for (const component of ['title', 'name'] as const) {
      const target = { owner: 'graph' as const, resource: first.work, component, revision: head };
      const report = await governance.submitReport(actor.principal, { kind: 'content_report', actingSubject: actor.actor,
        authority: { kind: 'platform', scopeId: scope }, context: GLOBAL_CONTEXT, target, disclosure: 'parties',
        reasonCode: 'policy', statement: 'Chapter search fence', evidence: [{ ...target, locator: null }], idempotencyKey: randomUUID() });
      await claimFixture(stack.accessPool, report.caseId, actor.principalId, actor.actor);
      const input = { caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: actor.actor,
        outcome: 'restrict' as const, evidenceDigest: report.evidenceDigest,
        rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
        targets: [{ ...target, locator: null, scopeKind: 'exact_revision' as const,
          expectedHead: head, effect: 'disclosure' as const }], reversesDecisionId: null, answersStepId: null,
        rationale: 'Chapter search fence', disclosure: 'parties' as const, reasons: fixtureReasons, idempotencyKey: randomUUID() };
      const decision = await governance.decide(actor.principal, input);
      expect(decision.operation.status).toBe('completed');
      await check([second.work]);
      await claimFixture(stack.accessPool, report.caseId, actor.principalId, actor.actor);
      const restored = await governance.decide(actor.principal, { ...input, outcome: 'reverse',
        expectedGeneration: decision.caseGeneration, reversesDecisionId: decision.decisionId, idempotencyKey: randomUUID() });
      expect(restored.operation.status).toBe('completed');
      await check([first.work, second.work]);
    }
    for (const work of [first.work, second.work]) {
      await stack.accessPool.query('UPDATE access.scope_gate SET open=false WHERE id=$1', [`work:read:${work}`]);
    }
    await check([]);
    for (const work of [first.work, second.work]) {
      await stack.accessPool.query('UPDATE access.scope_gate SET open=true WHERE id=$1', [`work:read:${work}`]);
    }
    // Fault injection: graph-hidden Books must not cause OPTIONAL to erase the
    // parent and expose the same text as a standalone Content hit.
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} rv:protectionHead <urn:rezics:protection:chapter-search> .
      ${iri(second.work)} rv:protectionHead <urn:rezics:protection:chapter-search> . } }`);
    await check([]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} rv:protectionHead <urn:rezics:protection:chapter-search> .
      ${iri(second.work)} rv:protectionHead <urn:rezics:protection:chapter-search> . } }`);
    await check([first.work, second.work]);
  } finally { await stack.stop(); }
}, 240_000);
