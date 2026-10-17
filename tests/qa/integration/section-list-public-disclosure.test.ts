import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaNames, personaSessions, type PersonaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';

const short = (id: string) => id.slice(-36);
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}
type Work = { work: string; mainVersion: string };
type Structure = { structure: string; revision: string; occurrences: string[] };
type Draft = { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } };
type Entry = { target: string; note: string; variantId: string; draft: Draft };
type Occurrence = { occurrence: string; target: string; qualifier: { values: { note: string } } };

let sessions: PersonaSessions;
let list: Work, structure: Structure, entries: Entry[], occurrences: string[];
const phrase = `sidereal tramway ${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner, actingSubject = owner.actingSubject!;
  const work = async (title: string): Promise<Work> => {
    const created = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
      semanticTypes: ['https://schema.org/Book'], actingSubject,
    }), 201);
    await grantPersonaFixtureAuthority(owner, [
      { scope: `work:edit:${created.work}`, action: 'work.edit' },
      { scope: `work:read:${created.work}`, action: 'work.read' },
      { scope: `work:publish:${created.work}`, action: 'work.publish' },
    ]);
    return created;
  };
  const publicWork = await work('Public section target');
  await grantPersonaFixtureAuthority(owner, [
    { scope: `contribution:create:${publicWork.work}`, action: 'contribution.create' },
    { scope: `publication:select:${publicWork.mainVersion}`, action: 'publication.select' },
  ]);
  const introduction = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: publicWork.work, language: 'en', body: 'Public introduction.', actingSubject,
  }), 201);
  await grantPersonaFixtureAuthority(owner, [
    { scope: `contribution:publish:${introduction.contribution}`, action: 'contribution.publish' },
  ]);
  const introductionPublication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: introduction.contribution,
    expectedDraftHead: introduction.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
  }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: publicWork.mainVersion },
    work: publicWork.work, contribution: introduction.contribution,
    publicationDecision: introductionPublication.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer', actingSubject,
  }), 201);
  const privateWork = await work('Private section target');
  const book = await work('Private Post host');
  let chapters = await answer<Structure>(owner.main('POST', '/v1/compositions', {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject,
  }), 201);
  const post = async (title: string) => {
    const created = await answer<{ post: string; variantId: string; compositionRevision: string }>(owner.main('POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1', title,
        language: 'en', direction: 'ltr', parent: chapters.structure, position: 'last',
        expectedCompositionHead: chapters.revision, actingSubject }));
    chapters = { ...chapters, revision: created.compositionRevision };
    return created;
  };
  const publicPost = await post('Public Post target');
  const privatePost = await post('Private Post target');
  const unpublishedPost = await post('Unpublished Post target');
  const entry = async (target: string, note: string, publication: 'public' | 'private' | 'draft',
    variantId = `urn:rezics:variant:${randomUUID()}`): Promise<Entry> => {
    await grantPersonaFixtureAuthority(owner, ['draft', 'publish', 'search-eligibility'].map(action => ({
      scope: `content:${action}:${target}`, action: `content.${action}`,
    })));
    const draft = await answer<Draft>(owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: target, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null, body: phrase, actingSubject,
    }), 201);
    if (publication !== 'draft') {
      const published = await answer<{ decision: string }>(owner.main('POST', '/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: randomUUID(), resourceId: target, variantId,
        revisionId: draft.revisionId, expectedDigest: draft.byteDigest,
        expectedContentEpoch: draft.sourcePosition.dataEpoch, expectedPublicationHead: null, actingSubject,
      }), 201);
      if (publication === 'public') await answer(owner.main('POST', '/v1/content-search-eligibility', {
        profile: 'content-search-eligibility-v1', resourceId: target, variantId,
        publicationDecision: published.decision, expectedEligibilityHead: null,
        rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
      }), 201);
    }
    return { target, note, variantId, draft };
  };
  // Public Content eligibility alone must not disclose a private Work identity.
  entries = [
    await entry(publicWork.work, 'Public Work note', 'public'),
    await entry(privateWork.work, 'PRIVATE Work note', 'public'),
    await entry(publicPost.post, 'Public Post note', 'public', publicPost.variantId),
    await entry(privatePost.post, 'PRIVATE Post note', 'private', privatePost.variantId),
    await entry(unpublishedPost.post, 'UNPUBLISHED Post note', 'draft', unpublishedPost.variantId),
  ];
  list = await work('Published mixed section list');
  structure = await answer<Structure>(owner.main('POST', '/v1/compositions', {
    profile: 'section-list-v1', work: list.work, mainVersion: list.mainVersion, actingSubject,
  }), 201);
  const changed = await answer<Structure>(owner.main('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
    profile: 'section-list-v1', expectedHead: structure.revision, actingSubject,
    operations: entries.map(item => ({ op: 'insert', role: 'entry', parent: structure.structure,
      position: 'last', target: item.target, qualifier: { note: item.note },
      selection: { mode: 'fixed-revision', revision: item.draft.revisionId,
        selector: { grain: 'content', variantId: item.variantId, revision: item.draft.revisionId } } })),
  }));
  occurrences = changed.occurrences;
  const current = await answer<{ revision: string }>(owner.main('GET',
    `/v1/works/${short(list.work)}?actingSubject=${encodeURIComponent(actingSubject)}`));
  await answer(owner.main('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: list.work,
    expectedWorkHead: current.revision, expectedMainVersion: list.mainVersion,
    structure: structure.structure, expectedStructureHead: changed.revision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
  }), 201);
}, 240_000);
afterAll(async () => { await sessions?.close(); });

for (const name of personaNames) {
  test(`${name} reads ${name === 'owner' ? 'public and explicitly granted' : 'only public'} section-list targets and their notes`, async () => {
    const person = sessions[name];
    const query = person.actingSubject ? `?actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const admitted = name === 'owner' ? entries : [entries[0]!, entries[2]!];
    const page = await answer<{ occurrences: Occurrence[] }>(person.main('GET',
      `/v1/compositions/${short(structure.structure)}${query}`));
    expect(page.occurrences.map(item => item.target)).toEqual(admitted.map(item => item.target));
    expect(page.occurrences.map(item => item.qualifier.values.note)).toEqual(admitted.map(item => item.note));
    const contents = await answer<{ items: Array<{ target: string }> }>(person.main('GET',
      `/v1/works/${short(list.work)}/contents${query}`));
    expect(contents.items.map(item => item.target)).toEqual(admitted.map(item => item.target));
    for (const [index, item] of entries.entries()) {
      const allowed = admitted.includes(item);
      const response = await person.main('GET',
        `/v1/compositions/${short(structure.structure)}/occurrences/${short(occurrences[index]!)}${query}`);
      const occurrence = await answer<{ occurrences: Occurrence[] }>(Promise.resolve(response), allowed ? 200 : 404);
      if (allowed) expect(occurrence.occurrences).toMatchObject([
        { target: item.target, qualifier: { values: { note: item.note } } },
      ]);
      else expect(JSON.stringify(occurrence)).not.toContain(item.note);
    }
  }, 120_000);

  test(`${name} searches public section-list entries while private and unpublished targets stay withheld`, async () => {
    // Public phrase search carries preferences, without private acting authority.
    const page = await answer<{ results: Array<{ matchedPlacements?: Array<{ work: string; occurrence: string }> }> }>(
      sessions[name].main('POST', '/v1/queries/page', {
        profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 20,
      }));
    const placements = page.results.flatMap(hit => hit.matchedPlacements ?? [])
      .filter(place => place.work === list.work);
    expect(placements.map(place => place.occurrence).sort()).toEqual([occurrences[0]!, occurrences[2]!].sort());
    for (const index of [1, 3, 4]) expect(JSON.stringify(page)).not.toContain(entries[index]!.note);
  }, 120_000);
}
