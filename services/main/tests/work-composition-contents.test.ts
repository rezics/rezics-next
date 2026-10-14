import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { activateMetadataWork, metadataWorkRequestDigest, GRAPHS, RV, iri } from '../src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../src/modules/work/select-main.ts';
import { readCompositionHeader } from '../src/modules/structure/graph.ts';
import { upgradeStoredMembership } from '../src/modules/structure/membership-normalize.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
type Page = { work: string; version: string; composition: string; compositionRevision: string;
  items: { occurrence: string; parent: string; role: string; target: string | null;
    label: { value: string; language: string } | null; division: string | null;
    number: number | null; childCount: number | null; selectedRevision: string | null;
    progress: unknown; availability: string; displayLabel?: string; inclusion?: string }[];
  nextCursor: string | null; count: { value: number; kind: string; total: null } };

test('Engine Work composition: Anime and Manga acknowledged headers disclose ordered Work parts', async () => {
  const stack = await startMediaStack('work-composition-contents');
  const evidence: unknown[] = [];
  try {
    await upgradeStoredMembership(stack.env);
    const owner = await stack.member('composition-contents-owner');
    const stranger = await stack.member('composition-contents-stranger');
    const target = await stack.publicWork(owner.actor);
    const hidden = await stack.privateWork(owner.actor);
    const create = async (kind: string) => {
      const title = `Composition ${kind} ${randomUUID()}`;
      const types = [kind];
      const work = await activateMetadataWork(stack.env, { title, semanticTypes: types,
        admission: stack.admission(owner.actor, 'work:create:root', 'work.create',
          metadataWorkRequestDigest(title, types)) });
      if (!work.work || !work.mainVersion) throw new Error('Work creation failed');
      const publication = await stack.contribution(work.work, owner.actor, 'en', 'Original credited fixture text');
      const input = { context: { kind: 'main-version-default' as const, id: work.mainVersion },
        work: work.work, contribution: publication.contribution, publicationDecision: publication.decision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: owner.actor };
      const selection = await selectMainDefault(stack.env, stack.admission(owner.actor,
        `publication:select:${work.mainVersion}`, 'publication.select', mainSelectionDigest(input)), input);
      expect(selection.outcome).toBe('succeeded');
      await owner.grant(`work:edit:${work.work}`, 'work.edit');
      const made = await json<{ structure: string; revision: string }>(await owner.send('POST', '/v1/compositions', {
        profile: 'work-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: owner.actor }), 201);
      const acknowledgedAt = new Date().toISOString();
      const header = await readCompositionHeader(stack.env, made.structure);
      expect(header).toMatchObject({ profile: 'work-composition', work: work.work,
        mainVersion: work.mainVersion, head: made.revision });
      const path = `/v1/works/${short(work.work)}/contents`;
      const traceparent = `00-${randomUUID().replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 16)}-01`;
      const response = await stack.main.handle(new Request(`http://main.local${path}`, { headers: { traceparent } }));
      const answer = await response.json();
      evidence.push({ kind, publication, selection, acknowledgedAt, header,
        readAt: new Date().toISOString(), request: { method: 'GET', path, traceparent }, status: response.status,
        answer, dataEpoch: stack.env.lineage?.dataEpoch, run: Bun.env.REZICS_QA_RUN_ID });
      return { work: work.work, main: work.mainVersion, made, path, response, answer };
    };
    // Manga's retained fixture describes a Book but writes WorkComposition, exactly as here.
    const anime = await create('https://schema.org/TVSeries');
    const manga = await create('https://schema.org/Book');
    for (const prepared of [anime, manga]) {
      expect(prepared.response.status, JSON.stringify(evidence)).toBe(200);
      expect(prepared.answer).toMatchObject({ items: [], nextCursor: null,
        count: { value: 0, kind: 'exact-page', total: null } });
      expect((await owner.read(prepared.path)).status).toBe(200);
      expect((await stranger.read(prepared.path)).status).toBe(200);
      const group = await json<{ revision: string; occurrences: string[] }>(await owner.send('POST',
        `/v1/compositions/${short(prepared.made.structure)}/changes`, {
          profile: 'work-composition', expectedHead: prepared.made.revision, actingSubject: owner.actor,
          operations: [{ op: 'insert', parent: prepared.made.structure, position: 'last', role: 'group',
            label: { value: 'Authored group', language: 'en' } }] }));
      await owner.grant(`work:read:${hidden.work}`, 'work.read');
      const changed = await json<{ revision: string; occurrences: string[] }>(await owner.send('POST',
        `/v1/compositions/${short(prepared.made.structure)}/changes`, {
          profile: 'work-composition', expectedHead: group.revision, actingSubject: owner.actor,
          operations: [target.work, hidden.work, target.work].map((work, index) => ({ op: 'insert',
            parent: group.occurrences[0], position: 'last', role: 'part', target: work,
            label: { value: `Authored part ${index}`, language: 'en' },
            displayLabel: `Part ${index}`, inclusion: index === 2 ? 'optional' : 'required' })) }));
      const root = await json<Page>(await stack.call('GET', prepared.path));
      expect(root.items).toMatchObject([{ occurrence: group.occurrences[0], parent: prepared.made.structure,
        role: 'group', label: { value: 'Authored group', language: 'en' }, number: null,
        division: null, childCount: null, selectedRevision: null, progress: null, availability: 'available' }]);
      const path = `${prepared.path}?parent=${encodeURIComponent(group.occurrences[0]!)}&limit=1`;
      const before = stack.fuseki.queries;
      const first = await json<Page>(await stack.call('GET', path));
      expect(stack.fuseki.queries - before).toBeLessThanOrEqual(64);
      expect(first).toMatchObject({ work: prepared.work, version: prepared.main,
        composition: prepared.made.structure, compositionRevision: changed.revision,
        count: { value: 1, kind: 'exact-page', total: null }, items: [{
          occurrence: changed.occurrences[0], parent: group.occurrences[0], role: 'part', target: target.work,
          label: { value: 'Authored part 0', language: 'en' }, displayLabel: 'Part 0', inclusion: 'required',
          division: null, number: null, childCount: null, selectedRevision: null, progress: null,
          availability: 'available' }] });
      expect(first.nextCursor).not.toBeNull();
      const last = await json<Page>(await stack.call('GET', `${path}&cursor=${encodeURIComponent(first.nextCursor!)}`));
      expect(last).toMatchObject({ nextCursor: null, count: { value: 1, total: null },
        items: [{ occurrence: changed.occurrences[2], role: 'part', target: target.work, inclusion: 'optional' }] });
      expect((await stranger.read(`${path}&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(400);
      const own = await json<Page>(await owner.read(`${prepared.path}?parent=${encodeURIComponent(group.occurrences[0]!)}&limit=20`));
      expect(own.items.map(item => item.occurrence)).toEqual(changed.occurrences);
      expect(own.items.every(item => item.availability === 'available' && item.selectedRevision === null)).toBe(true);
      expect((await stack.call('GET', `/v1/chapters/${short(changed.occurrences[0]!)}`)).status).toBe(404);
      expect((await stack.call('GET', `${prepared.path}?parent=${encodeURIComponent(randomUUID())}`)).status).toBe(400);
      await json(await owner.send('POST', `/v1/compositions/${short(prepared.made.structure)}/changes`, {
        profile: 'work-composition', expectedHead: changed.revision, actingSubject: owner.actor,
        operations: [{ op: 'insert', parent: prepared.made.structure, position: 'last', role: 'group' }] }));
      expect((await stack.call('GET', `${path}&cursor=${encodeURIComponent(first.nextCursor!)}`)).status).toBe(409);
    }
    // Independent identity/header regressions must not be masked by profile acceptance.
    const duplicate = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(duplicate)} a rv:Structure ; rv:structureOf ${iri(manga.main)} . } }`);
    expect((await stack.call('GET', manga.path)).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(duplicate)} a rv:Structure ; rv:structureOf ${iri(manga.main)} . } }`);
    const header = await readCompositionHeader(stack.env, manga.made.structure);
    if (!header) throw new Error('Acknowledged header disappeared');
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(header.structure)} rv:selectedGeneration ${iri(header.generation)} . } }`);
    expect((await stack.call('GET', manga.path)).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(header.structure)} rv:selectedGeneration ${iri(header.generation)} . } }`);
    expect((await stack.call('GET', manga.path)).status).toBe(200);
  } finally {
    mkdirSync('.temp/composition-contents', { recursive: true });
    writeFileSync('.temp/composition-contents/acknowledged-reads.json', JSON.stringify(evidence, null, 2));
    await stack.stop();
  }
}, 180_000);
