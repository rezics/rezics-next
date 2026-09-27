import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
interface Page<T> { items: T[]; nextCursor: string | null }

test('Zone modules page public adoptions and completed serials with decision evidence', async () => {
  const stack = await startMediaStack('realm-module');
  try {
    const editor = await stack.member('module-editor');
    const first = await stack.publicWork(editor.actor, ['en'], 'First serial');
    const second = await stack.publicWork(editor.actor, ['en'], 'Second serial');
    const hidden = await stack.privateWork(editor.actor, 'Hidden serial');
    await editor.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Serials', capabilities: ['realm'], actingSubject: editor.actor,
    }), 201);
    const base = `/v1/realms/${short(realm.realm)}/modules`;
    await editor.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
    for (const item of [first, second]) await json(await editor.send('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm.realm },
      work: item.work, mainVersion: item.mainVersion, contribution: item.variants[0]!.contribution,
      publicationDecision: item.variants[0]!.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: editor.actor,
    }), 201);
    await editor.grant(`work:edit:${first.work}`, 'work.edit');
    const saved = await json<{ revision: string }>(await editor.send('PUT',
      `/v1/works/${short(first.work)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: editor.actor,
        state: { kind: 'header', originalTitle: null, completionStatus: 'completed',
          localized: [{ language: 'en', title: null, description: null, mainVersionLabel: null,
            tagline: 'A final page closes the journey' }] },
      }));
    const adopted = await json<Page<{ id: string; evidence: string }>>(
      await stack.call('GET', `${base}/new-adoptions?limit=1`));
    expect(adopted.items).toHaveLength(1);
    expect(adopted.nextCursor).toBeString();
    const rest = await json<Page<{ id: string }>>(
      await stack.call('GET', `${base}/new-adoptions?limit=1&cursor=${adopted.nextCursor}`));
    expect(new Set([...adopted.items, ...rest.items].map(item => item.id)))
      .toEqual(new Set([first.work, second.work]));
    expect(rest.nextCursor).toBeNull();
    const completed = await json<Page<{ id: string; evidence: string;
      tagline: { value: string }; completionStatus: string }>>(
      await stack.call('GET', `${base}/recently-completed`));
    expect(completed.items).toMatchObject([{ id: first.work, evidence: saved.revision,
      tagline: { value: 'A final page closes the journey' }, completionStatus: 'completed' }]);
    expect([...adopted.items, ...rest.items, ...completed.items].map(item => item.id)).not.toContain(hidden.work);
    await json(await editor.send('PUT', `/v1/works/${short(first.work)}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: saved.revision, actingSubject: editor.actor,
      state: { kind: 'header', originalTitle: null, completionStatus: null,
        localized: [{ language: 'en', title: null, description: null, mainVersionLabel: null,
          tagline: 'A final page closes the journey' }] },
    }));
    expect((await json<Page<unknown>>(await stack.call('GET', `${base}/recently-completed`))).items).toEqual([]);
    expect((await stack.call('GET', `${base}/new-adoptions?cursor=broken`)).status).toBe(400);
    const chapter = `https://rezics.com/id/${randomUUID()}`;
    const publication = `https://rezics.com/id/${randomUUID()}`;
    const eligibility = `https://rezics.com/id/${randomUUID()}`;
    const contentRevision = `urn:rezics:content:revision:${randomUUID()}`;
    const structure = `https://rezics.com/id/${randomUUID()}`;
    const generation = `urn:rezics:generation:${randomUUID()}`;
    const placement = `urn:rezics:placement:${randomUUID()}`;
    const variant = `urn:rezics:variant:${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(structure)} a rv:Structure ; rv:structureOf ${iri(first.mainVersion)} ;
            rv:selectedGeneration ${iri(generation)} .
          ${iri(generation)} rv:generationState rv:Active .
          ${iri(placement)} a rv:OccurrencePlacement ; rv:generation ${iri(generation)} ;
            rv:occurrenceRole rv:ChapterRole ; schema:item ${iri(chapter)} .
          ${iri(variant)} a rv:ContentVariant ; rv:resource ${iri(chapter)} ;
            rv:contentPublicationHead ${iri(publication)} ;
            rv:publicSearchEligibilityHead ${iri(eligibility)} . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(publication)} a rv:ContentPublicationDecision, rv:RevisionAnchor ;
            rv:resource ${iri(chapter)} ; rv:component ${iri(variant)} ;
            rv:contentRevision ${iri(contentRevision)} ; rv:contentLanguage "en" ;
            rv:dataEpoch "${stack.env.lineage.dataEpoch}" ; rv:sequence 1 .
          ${iri(eligibility)} a rv:ContentSearchEligibilityDecision ;
            rv:publicationDecision ${iri(publication)} ; rv:disclosure rv:Public . } }`);
    const chapters = await json<Page<{ chapter: string; publication: string; work: { id: string } }>>(
      await stack.call('GET', `${base}/latest-chapters`));
    expect(chapters.items).toMatchObject([{ chapter, publication, work: { id: first.work } }]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(contentRevision)} a rv:ErasedRevision . } }`);
    expect((await json<Page<unknown>>(await stack.call('GET', `${base}/latest-chapters`))).items).toEqual([]);
    const decisions = await json<{ summary: { adoption: number; basis: string };
      items: Array<{ id: string; kind: string }> }>(
      await stack.call('GET', `${base}/recent-decisions`));
    expect(decisions.summary).toMatchObject({ adoption: 2, basis: 'exact-page' });
    const exact = await json<{ id: string; kind: string }>(await stack.call('GET',
      `/v1/realms/${short(realm.realm)}/decisions/${short(decisions.items[0]!.id)}`));
    expect(exact).toMatchObject({ id: decisions.items[0]!.id, kind: 'adoption' });
  } finally { await stack.stop(); }
}, 120_000);
