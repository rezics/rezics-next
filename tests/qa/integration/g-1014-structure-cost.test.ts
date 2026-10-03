import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { StructureStageStore, type StructureStage } from '../../../services/main/src/modules/structure/stage.ts';
import type { CompositionCost } from '../../../services/main/src/modules/structure/change.ts';
import { evenKeys } from '../../../services/main/src/modules/structure/order-key.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { startMediaStack } from './media-support.ts';

type Composition = { structure: string; revision: string; occurrences: string[]; cost: CompositionCost };
const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status} (expected ${status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G1014: one occurrence write at 100, 1000 and 10000 chapters touches only its order segment and tree paths', async () => {
  const stack = await startMediaStack('g-1014-write-cost');
  try {
    const member = await stack.member('structure-importer');
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async (request: Request) => {
        if (request.headers.get('authorization') !== `Bearer ${member.token}`) throw new AccountAssertionDenied('Unknown bearer');
        return member.principal;
      } } });
    const call = (method: string, path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': randomUUID(),
        'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const title = 'G1014 large chapter inventory', semanticTypes = ['https://schema.org/Book'];
    const work = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    await member.grant(`work:edit:${work.work}`, 'work.edit');
    await member.grant(`work:read:${work.work}`, 'work.read');
    const chapterTitle = 'G1014 repeated chapter target';
    const chapter = await activateMetadataWork(stack.env, { title: chapterTitle,
      admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(chapterTitle)) });
    await member.grant(`work:read:${chapter.work}`, 'work.read');
    const originalCanRead = stack.access.canReadWork.bind(stack.access);
    let targetChecks = 0;
    stack.access.canReadWork = async (...args) => {
      if (args[2] === chapter.work) targetChecks++;
      return originalCanRead(...args);
    };
    let composition = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
      work: work.work, mainVersion: work.mainVersion, actingSubject: member.actor }), 201);
    const path = `/v1/compositions/${short(composition.structure)}`;
    const stage = await json<StructureStage>(await call('POST', `${path}/stages`, {
      expectedHead: composition.revision, actingSubject: member.actor }), 201);
    const anchors = Array.from({ length: 100 }, () => `https://rezics.com/id/${randomUUID()}`);
    const segmentKeys = evenKeys(4), orderKeys = evenKeys(32);
    await json(await call('PUT', `${path}/stages/${stage.id}/pages/0`, {
      actingSubject: member.actor, holder: stage.holder, fence: stage.fence,
      entries: anchors.map((occurrence, index) => ({ occurrence, state: 'active', parent: composition.structure,
        segmentKey: segmentKeys[Math.floor(index / 32)], orderKey: orderKeys[index % 32],
        role: 'chapter', target: chapter.work, selection: { mode: 'follow-context' },
        labels: [], introducedBy: stage.revision })) }));
    await json(await call('POST', `${path}/stages/${stage.id}/seal`, {
      actingSubject: member.actor, holder: stage.holder, fence: stage.fence }));
    expect(targetChecks).toBe(1);
    const activated = await json<StructureStage>(await call('POST', `${path}/stages/${stage.id}/activate`, {
      actingSubject: member.actor }));
    composition.revision = activated.revision;
    expect(targetChecks).toBe(2);
    const insert = (position: 'last' | { after: string }) => ({ op: 'insert', parent: composition.structure,
      position, role: 'chapter', target: chapter.work });
    const change = async (operations: object[]) => {
      composition = await json<Composition>(await call('POST', `${path}/changes`, {
        profile: 'book-composition', expectedHead: composition.revision, actingSubject: member.actor, operations }));
      return composition;
    };
    // Spread importer edits across known source anchors. This also exercises
    // middle splits; each HTTP command uses the public 16-operation batch.
    let count = 100;
    const measurements: object[] = [];
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    let segmentRows = 0;
    stack.fuseki.query = async (sparql, maxBytes) => {
      const result = await originalQuery(sparql, maxBytes);
      segmentRows += (result.results?.bindings ?? []).filter(row => row.segment && row.count).length;
      return result;
    };
    for (const size of [100, 1000, 10000]) {
      const buildStarted = performance.now();
      while (count < size) {
        const batch = Math.min(16, size - count);
        const anchor = anchors[Math.floor(count / 16) % anchors.length]!;
        try { await change(Array.from({ length: batch }, () => insert({ after: anchor }))); }
        catch (error) { throw new Error(`API import failed at ${count} chapters`, { cause: error }); }
        count += batch;
      }
      const samples = [];
      for (let sample = 0; sample < 3; sample++) {
        const beforeQueries = stack.fuseki.queries, beforeRows = segmentRows, started = performance.now();
        const added = await change([insert('last')]);
        samples.push({ milliseconds: performance.now() - started, graphQueries: stack.fuseki.queries - beforeQueries,
          segmentRows: segmentRows - beforeRows, cost: added.cost });
        expect(added.cost.placementsWritten).toBeLessThanOrEqual(33);
        expect(added.cost.segmentsWritten).toBeLessThanOrEqual(2);
        expect(added.cost.rebalanced).toBeLessThanOrEqual(32);
        expect(added.cost.pagesRead).toBeLessThanOrEqual(20);
        expect(added.cost.pagesWritten).toBeLessThanOrEqual(10);
        expect(segmentRows - beforeRows).toBeLessThanOrEqual(3);
        await change([{ op: 'remove', occurrence: added.occurrences[0] }]);
      }
      measurements.push({ size, buildMs: performance.now() - buildStarted, samples });
      console.log('G1014: single occurrence write profile', JSON.stringify(measurements.at(-1)));
    }
    expect(await readCompositionHeader(stack.env, composition.structure)).toMatchObject({ placementCount: 10000 });
  } finally { await stack.stop(); }
}, 450_000);
