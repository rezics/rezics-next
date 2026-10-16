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

test('anonymous search withholds an occurrence from an unpublished section list', async () => {
  const sessions = await personaSessions('public');
  try {
    const owner = sessions.owner, visitor = sessions.visitor;
    const actingSubject = owner.actingSubject!;
    const publishWork = async (title: string, type: string) => {
      const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
        semanticTypes: [type], actingSubject,
      }), 201);
      await grantPersonaFixtureAuthority(owner, [
        { scope: `work:edit:${work.work}`, action: 'work.edit' },
        { scope: `work:read:${work.work}`, action: 'work.read' },
        { scope: `contribution:create:${work.work}`, action: 'contribution.create' },
        { scope: `publication:select:${work.mainVersion}`, action: 'publication.select' },
      ]);
      const text = await answer<{ contribution: string; draftRevision: string }>(owner.main(
        'POST', '/v1/contributions', {
          profile: 'text-contribution-v1', work: work.work, language: 'en',
          body: 'Public introduction.', actingSubject,
        }), 201);
      await grantPersonaFixtureAuthority(owner, [
        { scope: `contribution:publish:${text.contribution}`, action: 'contribution.publish' },
      ]);
      const publication = await answer<{ publicationDecision: string }>(owner.main(
        'POST', '/v1/contribution-publications', {
          profile: 'text-publication-v1', contribution: text.contribution,
          expectedDraftHead: text.draftRevision, expectedPublicationHead: null,
          rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
        }), 201);
      await answer(owner.main('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work, contribution: text.contribution,
        publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer', actingSubject,
      }), 201);
      return work;
    };
    const anthology = await publishWork('Public anthology', 'https://schema.org/TVSeries');
    const source = await publishWork('Public production notes', 'https://schema.org/DigitalDocument');
    const structure = await answer<{ structure: string; revision: string }>(owner.main(
      'POST', '/v1/compositions', {
        profile: 'section-list-v1', work: anthology.work,
        mainVersion: anthology.mainVersion, actingSubject,
      }), 201);
    const changed = await answer<{ occurrences: string[] }>(owner.main(
      'POST', `/v1/compositions/${short(structure.structure)}/changes`, {
        profile: 'section-list-v1', expectedHead: structure.revision, actingSubject,
        operations: [{ op: 'insert', role: 'entry', parent: structure.structure,
          position: 'last', target: source.work, qualifier: { note: 'Unpublished editorial placement' } }],
      }));
    await grantPersonaFixtureAuthority(owner, ['draft', 'publish', 'search-eligibility'].map(action => ({
      scope: `content:${action}:${source.work}`, action: `content.${action}`,
    })));
    const phrase = `orbital railway ${randomUUID().slice(0, 8)}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = await answer<{ revisionId: string; byteDigest: string;
      sourcePosition: { dataEpoch: string } }>(owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: source.work, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null, body: phrase, actingSubject,
    }), 201);
    const content = await answer<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: randomUUID(),
      resourceId: source.work, variantId, revisionId: draft.revisionId,
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      expectedPublicationHead: null, actingSubject,
    }), 201);
    await answer(owner.main('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: source.work, variantId,
      publicationDecision: content.decision, expectedEligibilityHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
    }), 201);

    await answer(visitor.main('GET', `/v1/works/${short(anthology.work)}`));
    await answer(visitor.main('GET', `/v1/works/${short(source.work)}`));
    expect((await visitor.main('GET', `/v1/compositions/${short(structure.structure)}`)).status).toBe(404);
    expect(changed.occurrences).toHaveLength(1);
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
    const page = await answer<{ results: Array<{ matchedPlacements?: Array<{ occurrence: string }> }> }>(
      Promise.resolve(response));
    expect(page.results.flatMap(hit => hit.matchedPlacements?.map(place => place.occurrence) ?? []),
      'Anonymous search disclosed an occurrence whose unpublished Structure the same visitor cannot read')
      .not.toContain(changed.occurrences[0]!);
  } finally {
    await sessions.close();
  }
}, 240_000);
