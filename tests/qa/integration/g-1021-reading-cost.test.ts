import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { StructureStageStore } from '../../../services/main/src/modules/structure/stage.ts';
import { backfillOccurrenceLabels } from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { integrationOrderPrelude } from '../support/integration-order.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startMediaStack } from './media-support.ts';

type Page = { items: Array<{ occurrence: string; ordinal: number }>; nextCursor: string | null;
  complete: boolean; resolved: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
type Stage = { id: string; holder: string; fence: string; revision: string };
const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

// One real stack, identical three-volume topology and fixed page size at every
// scale. HTTP/graph/object counters measure store exchanges and bytes, not native
// TDB operators. The immutable-tree unit test separately observes visited pages.
test('G1021: chooser pages, numbered and CJK seeks, and saved positions at 100, 1000 and 10000 chapters', async () => {
  await integrationOrderPrelude('g-1021-reading-cost');
  const stack = await startMediaStack('g-1021-reading-cost');
  try {
    const member = await stack.member('reading-cost-editor');
    // Stage routes are catalogue-import. The running Main reads that grant through its exposure.
    await grantRecordedPlatformUse(stack.accessPool, member.principalId, ['catalogue-import']);
    const originalObjects = stack.objects('semantic/structure/'); await originalObjects.initialize();
    let objectReads = 0, objectBytes = 0;
    const objects = { put: originalObjects.put.bind(originalObjects), get: async (digest: string) => {
      const bytes = await originalObjects.get(digest); objectReads++; objectBytes += bytes.length; return bytes;
    } };
    const query = stack.fuseki.query.bind(stack.fuseki);
    let graphRows = 0, graphBytes = 0;
    const graphWork: Array<{ name: string; ms: number }> = [];
    stack.fuseki.query = async (sparql, bytes) => {
      if (stack.fuseki.isBackgroundContext) return query(sparql, bytes);
      const start = performance.now(), result = await query(sparql, bytes);
      graphRows += result.results?.bindings.length ?? 0; graphBytes += Buffer.byteLength(JSON.stringify(result));
      graphWork.push({ name: sparql.match(/# reading-position:([\w-]+)/)?.[1] ?? 'fence/disclosure', ms: performance.now() - start });
      return result;
    };
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      platformAccess: new AccessExposure(stack.accessPool),
      media: stack.media, mediaAccess: stack.mediaAccess, readingPositions: new ReadingPositionStore(stack.contentPool),
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async request => {
        if (request.headers.get('authorization') !== `Bearer ${member.token}`) throw new AccountAssertionDenied('Unknown bearer');
        return member.principal;
      } } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const makeWork = async (title: string, semanticTypes = ['https://schema.org/Book']) => {
      const work = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const contribution = await stack.contribution(work.work, member.actor, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
        contribution: contribution.contribution, publicationDecision: contribution.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
      await selectMainDefault(stack.env, stack.admission(member.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await member.grant(`work:edit:${work.work}`, 'work.edit');
      await member.grant(`work:read:${work.work}`, 'work.read');
      return work;
    };
    const samples: object[] = [];
    let flatNumberCost: { graphCalls: number; graphRows: number; objectReads: number; objectBytes: number } | undefined;
    for (const count of [100, 1000, 10000]) {
      const buildStarted = performance.now();
      const rootWork = await makeWork(`G1021 ${count} chapters`);
      const chapter = await makeWork(`G1021 ${count} chapter`, ['https://schema.org/DigitalDocument']);
      const root = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'work-composition',
        work: rootWork.work, mainVersion: rootWork.mainVersion, actingSubject: member.actor }), 201);
      const volumes = [];
      for (let index = 0; index < 3; index++) volumes.push(await makeWork(`G1021 ${count} volume ${index}`));
      await json(await call('POST', `/v1/compositions/${short(root.structure)}/changes`, {
        profile: 'work-composition', expectedHead: root.revision, actingSubject: member.actor,
        operations: volumes.map(volume => ({ op: 'insert', role: 'part', parent: root.structure,
          position: 'last', target: volume.work, displayLabel: 'Volume', inclusion: 'required' })) }));
      let last = '', lastCount = 0;
      for (const [index, volume] of volumes.entries()) {
        const size = Math.floor(count / 3) + (index === 2 ? count % 3 : 0); lastCount = size;
        const composition = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
          work: volume.work, mainVersion: volume.mainVersion, actingSubject: member.actor }), 201);
        const path = `/v1/compositions/${short(composition.structure)}/stages`;
        const stage = await json<Stage>(await call('POST', path, { expectedHead: composition.revision,
          actingSubject: member.actor }), 201);
        for (let offset = 0, page = 0; offset < size; offset += 256, page++) {
          const entries = Array.from({ length: Math.min(256, size - offset) }, (_, at) => {
            const local = offset + at, occurrence = `https://rezics.com/id/${randomUUID()}`;
            last = occurrence;
            return { occurrence, state: 'active', parent: composition.structure,
              segmentKey: Math.floor(local / 32).toString(36).padStart(4, '0'),
              orderKey: (local % 32).toString(36).padStart(2, '0'), role: 'chapter',
              target: chapter.work, selection: { mode: 'follow-context' }, introducedBy: stage.revision,
              labels: [{ value: index === 2 && local === size - 1 ? '重逢' : `Chapter ${local + 1}`, language: 'yue' }] };
          });
          await json(await call('PUT', `${path}/${stage.id}/pages/${page}`, { actingSubject: member.actor,
            holder: stage.holder, fence: stage.fence, entries }));
        }
        await json(await call('POST', `${path}/${stage.id}/seal`, { actingSubject: member.actor,
          holder: stage.holder, fence: stage.fence }));
        await json(await call('POST', `${path}/${stage.id}/activate`, { actingSubject: member.actor }));
      }
      // Activation queues the label projection; seek assertions require its completed index.
      await backfillOccurrenceLabels(stack.env);
      const buildMs = performance.now() - buildStarted;
      expect(buildMs).toBeLessThan(600_000);
      const measured = async (operation: string, params: Record<string, string>) => {
        const start = performance.now(), calls = stack.fuseki.queries, rows = graphRows, bytes = graphBytes,
          reads = objectReads, objectSize = objectBytes, work = graphWork.length;
        const page = await json<Page>(await app.handle(new Request(
          `http://main.local/v1/reading-positions/${short(rootWork.work)}?${new URLSearchParams(params)}`)));
        samples.push({ count, operation, ms: performance.now() - start, graphCalls: stack.fuseki.queries - calls,
          graphRows: graphRows - rows, graphBytes: graphBytes - bytes, objectReads: objectReads - reads,
          objectBytes: objectBytes - objectSize, queries: graphWork.slice(work) });
        return page;
      };
      const first = await measured('first-page', { limit: '100' });
      expect(first.items).toHaveLength(100);
      let cursor = first.nextCursor, total = first.items.length;
      while (cursor) {
        const page = await measured('continuation', { limit: '100', cursor });
        total += page.items.length; cursor = page.nextCursor;
      }
      expect(total).toBe(count + 3);
      // The indexed Structure read, when built, turns this case back into a seek.
      // The refusal assertion forces that update.
      const numberStart = performance.now(), numberCalls = stack.fuseki.queries, numberRows = graphRows,
        numberGraphBytes = graphBytes, numberReads = objectReads, numberObjectBytes = objectBytes,
        numberWork = graphWork.length;
      const number = await json<{ code: string }>(await app.handle(new Request(
        `http://main.local/v1/reading-positions/${short(rootWork.work)}?${new URLSearchParams({ q: String(lastCount), limit: '100' })}`)), 503);
      const numberCost = { graphCalls: stack.fuseki.queries - numberCalls, graphRows: graphRows - numberRows,
        graphBytes: graphBytes - numberGraphBytes, objectReads: objectReads - numberReads,
        objectBytes: objectBytes - numberObjectBytes };
      samples.push({ count, operation: 'number', ms: performance.now() - numberStart, ...numberCost,
        queries: graphWork.slice(numberWork) });
      expect(number).toMatchObject({ code: 'reading_seek_unavailable' });
      // Graph bytes follow the width of the episode number. Calls, rows and object
      // reads stay flat: the refusal does not walk the chapter inventory.
      const flat = { graphCalls: numberCost.graphCalls, graphRows: numberCost.graphRows,
        objectReads: numberCost.objectReads, objectBytes: numberCost.objectBytes };
      if (flatNumberCost === undefined) flatNumberCost = flat;
      else expect(flat).toEqual(flatNumberCost);
      const cjk = await measured('cjk', { q: '重逢', limit: '1' });
      expect(cjk.items.map(item => item.occurrence)).toEqual([last]); expect(cjk.complete).toBe(true);
      const saved = await measured('saved-position', { q: '重逢', position: last, limit: '1' });
      expect(saved.resolved).toBe(last);
      const savedOnly = await measured('saved-position-only', { position: last, limit: '1' });
      expect(savedOnly.resolved).toBe(last); expect(savedOnly.items).toHaveLength(1);
      console.log('G1021 scale', JSON.stringify({ count, buildMs, samples: samples.filter(sample => (sample as { count: number }).count === count) }));
    }
  } finally { await stack.stop(); }
}, 600_000);
