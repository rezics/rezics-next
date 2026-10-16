import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions } from '../../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../../support/persona-fixture-authority.ts';

const short = (id: string) => id.slice(-36);
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

test('anonymous phrase search withholds the private Work target withheld by Structure', async () => {
  const sessions = await personaSessions('public');
  try {
    const owner = sessions.owner, visitor = sessions.visitor;
    const actingSubject = owner.actingSubject!;
    const create = (title: string, type: string) => answer<{ work: string; mainVersion: string }>(
      owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
        semanticTypes: [type], actingSubject,
      }), 201);
    const anthology = await create('Public anthology', 'https://schema.org/TVSeries');
    const secret = await create(`Private production notes ${randomUUID()}`, 'https://schema.org/DigitalDocument');
    await grantPersonaFixtureAuthority(owner, [
      { scope: `work:edit:${anthology.work}`, action: 'work.edit' },
      { scope: `work:read:${anthology.work}`, action: 'work.read' },
      { scope: `work:publish:${anthology.work}`, action: 'work.publish' },
      { scope: `work:read:${secret.work}`, action: 'work.read' },
      { scope: `contribution:create:${anthology.work}`, action: 'contribution.create' },
      { scope: `publication:select:${anthology.mainVersion}`, action: 'publication.select' },
      ...['draft', 'publish', 'search-eligibility'].map(action => ({
        scope: `content:${action}:${secret.work}`, action: `content.${action}`,
      })),
    ]);
    const introduction = await answer<{ contribution: string; draftRevision: string }>(owner.main(
      'POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: anthology.work, language: 'en',
        body: 'Public anthology introduction.', actingSubject,
      }), 201);
    await grantPersonaFixtureAuthority(owner, [
      { scope: `contribution:publish:${introduction.contribution}`, action: 'contribution.publish' },
    ]);
    const publication = await answer<{ publicationDecision: string }>(owner.main(
      'POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: introduction.contribution,
        expectedDraftHead: introduction.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
      }), 201);
    await answer(owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: anthology.mainVersion },
      work: anthology.work, contribution: introduction.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject,
    }), 201);
    const structure = await answer<{ structure: string; revision: string }>(owner.main(
      'POST', '/v1/compositions', {
        profile: 'section-list-v1', work: anthology.work,
        mainVersion: anthology.mainVersion, actingSubject,
      }), 201);
    const phrase = `hidden railway ${randomUUID().slice(0, 8)}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await answer<{ revisionId: string; byteDigest: string;
      sourcePosition: { dataEpoch: string } }>(owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: secret.work, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null, body: phrase, actingSubject,
    }), 201);
    const content = await answer<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: randomUUID(),
      resourceId: secret.work, variantId, revisionId: draft.revisionId,
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      expectedPublicationHead: null, actingSubject,
    }), 201);
    await answer(owner.main('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: secret.work, variantId,
      publicationDecision: content.decision, expectedEligibilityHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
    }), 201);

    const changed = await answer<{ revision: string }>(owner.main('POST',
      `/v1/compositions/${short(structure.structure)}/changes`, {
        profile: 'section-list-v1', expectedHead: structure.revision, actingSubject,
        operations: [{ op: 'insert', role: 'entry', parent: structure.structure,
          position: 'last', target: secret.work, qualifier: { note: 'Private reference' },
          selection: { mode: 'fixed-revision', revision: draft.revisionId,
            selector: { grain: 'content', variantId, revision: draft.revisionId } } }],
      }));
    const current = await answer<{ revision: string }>(owner.main('GET',
      `/v1/works/${short(anthology.work)}?actingSubject=${encodeURIComponent(actingSubject)}`));
    await answer(owner.main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: anthology.work,
      actingSubject, expectedWorkHead: current.revision, expectedMainVersion: anthology.mainVersion,
      structure: structure.structure, expectedStructureHead: changed.revision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
    }), 201);

    expect((await visitor.main('GET', `/v1/works/${short(secret.work)}`)).status).toBe(404);
    const outline = await answer<{ occurrences: unknown[] }>(visitor.main(
      'GET', `/v1/compositions/${short(structure.structure)}`));
    expect(outline.occurrences).toEqual([]);

    const query = () => visitor.main('POST', '/v1/queries/page', {
      profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10,
    });
    const deadline = Date.now() + 60_000;
    let response = await query();
    while (response.status === 503 && Date.now() < deadline) {
      await response.body?.cancel();
      await Bun.sleep(250);
      response = await query();
    }
    const page = await answer<{ results: unknown[] }>(Promise.resolve(response));
    expect(JSON.stringify(page.results),
      'Anonymous search disclosed a private Work target that the Work and Structure APIs withhold')
      .not.toContain(secret.work);
  } finally {
    await sessions.close();
  }
}, 240_000);
