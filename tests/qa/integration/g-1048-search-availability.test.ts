import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { projectOccurrenceLabelsOnce, occurrenceLabelReadiness }
  from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { activateMetadataWork, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const short = (value: string) => value.slice(-36);
type Composition = { structure: string; revision: string; occurrences: string[] };
type Generation = { state: string; generation: string; sequence: string; population: number };
type Page = { items: Array<{ occurrence: string; ordinal: number }>; complete: boolean;
  count: { kind: string }; search: { status: string } };
async function json<T>(response: Response, expected = 200): Promise<T> {
  if (response.status !== expected) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G1048: public search keeps its active generation through pending, partial, lost-reply and reset label batches', async () => {
  const stack = await startMediaStack('g-1048-search-availability');
  try {
    const editor = await stack.member('search-editor');
    const token = `g1048${randomUUID().replaceAll('-', '')}`;
    const title = `${token} reunion`, semanticTypes = ['https://schema.org/Book'];
    const work = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    const text = await stack.contribution(work.work, editor.actor, 'en', title);
    const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    await selectMainDefault(stack.env, stack.admission(editor.actor, `publication:select:${work.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    await editor.grant(`work:read:${work.work}`, 'work.read');
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, structureObjects: objects,
      readingPositions: new ReadingPositionStore(stack.contentPool),
      account: { verify: async () => editor.principal } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(method === 'POST' ? { authorization: `Bearer ${editor.token}` } : {}),
        'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const generation = async () => json<Generation>(await call('GET', '/v1/search/generations/current'));
    const initial = await generation();
    expect(initial.state).toBe('active');
    const publicSearch = async () => {
      const current = await generation();
      expect(current).toMatchObject({ state: 'active', generation: initial.generation, population: initial.population });
      const catalogue = await json<{ results: Array<{ work: string }> }>(await call('GET',
        `/v1/search/catalogue?${new URLSearchParams({ q: token, limit: '1' })}`));
      expect(catalogue.results.map(item => item.work)).toEqual([work.work]);
    };
    let composition = await json<Composition>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: editor.actor,
    }), 201);
    for (let offset = 0; offset < 130; offset += 16) {
      composition = await json<Composition>(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'book-composition', expectedHead: composition.revision, actingSubject: editor.actor,
        operations: Array.from({ length: Math.min(16, 130 - offset) }, () => ({
          op: 'insert', role: 'chapter', parent: composition.structure, position: 'last',
          target: 'https://schema.org/DigitalDocument', label: { value: '重逢', language: 'yue' },
        })),
      }));
    }
    const chooser = async () => json<Page>(await call('GET', `/v1/reading-positions/${short(work.work)}?q=重逢&limit=1`));
    expect(await chooser()).toMatchObject({ items: [], complete: false,
      search: { status: 'indexing' }, count: { kind: 'at-least' } });
    await publicSearch();

    // A committed batch with a lost reply must retain its durable checkpoint.
    const command = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    stack.fuseki.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      throw new Error(`G1048 injected lost ${result.status} reply`);
    };
    try { await expect(projectOccurrenceLabelsOnce(stack.env)).rejects.toThrow('injected lost committed reply'); }
    finally { stack.fuseki.commandWithReceipt = command; }
    expect(await chooser()).toMatchObject({ complete: false, search: { status: 'indexing' } });
    await publicSearch();

    const drain = async () => {
      let batches = 0;
      while ((await occurrenceLabelReadiness(stack.env)).status === 'indexing') {
        expect(batches++).toBeLessThan(12);
        expect(await projectOccurrenceLabelsOnce(stack.env)).toBe(true);
        const pending = (await occurrenceLabelReadiness(stack.env)).status === 'indexing';
        expect(await chooser()).toMatchObject({ search: { status: pending ? 'indexing' : 'current' },
          ...(pending ? { complete: false, count: { kind: 'at-least' } } : {}) });
        await publicSearch();
      }
      return batches;
    };
    expect(await drain()).toBeGreaterThan(0);
    expect((await chooser()).items).toHaveLength(1);
    expect((await chooser()).search).toEqual({ status: 'current' });

    expect(await projectOccurrenceLabelsOnce(stack.env, { reset: true,
      generation: (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?generation WHERE { GRAPH <urn:rezics:graph:current> {
          <${composition.structure}> rv:selectedGeneration ?generation } } LIMIT 1`))
        .results!.bindings[0]!.generation!.value })).toBe(true);
    expect(await chooser()).toMatchObject({ complete: false, search: { status: 'indexing' } });
    await publicSearch();
    expect(await drain()).toBeGreaterThan(3);
    expect((await chooser()).search).toEqual({ status: 'current' });
    expect(await json(await call('GET', '/health/search-ready'))).toMatchObject({
      status: 'ready', occurrenceLabels: { status: 'current' }, indexGeneration: initial.generation,
    });
  } finally { await stack.stop(); }
}, 120_000);
