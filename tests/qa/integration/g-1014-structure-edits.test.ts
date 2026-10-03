import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { StructureStageStore, type StructureStage } from '../../../services/main/src/modules/structure/stage.ts';
import type { CompositionCost } from '../../../services/main/src/modules/structure/change.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { startMediaStack } from './media-support.ts';

type Composition = { structure: string; revision: string; occurrences: string[]; cost: CompositionCost };
const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status} (expected ${status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G1014: dense segment splits remain local, preserve order and compose with moves, removes, replay and stale heads', async () => {
  const stack = await startMediaStack('g-1014-local-edits');
  try {
    const member = await stack.member('local-editor');
    const title = 'G1014 dense segment story', semanticTypes = ['https://schema.org/Book'];
    const work = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    await member.grant(`work:edit:${work.work}`, 'work.edit');
    await member.grant(`work:read:${work.work}`, 'work.read');
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async () => member.principal } });
    const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const base = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
      work: work.work, mainVersion: work.mainVersion, actingSubject: member.actor }), 201);
    const path = `/v1/compositions/${short(base.structure)}`;
    const stage = await json<StructureStage>(await call('POST', `${path}/stages`, {
      expectedHead: base.revision, actingSubject: member.actor }), 201);
    const anchors = Array.from({ length: 33 }, () => `https://rezics.com/id/${randomUUID()}`);
    await json(await call('PUT', `${path}/stages/${stage.id}/pages/0`, {
      actingSubject: member.actor, holder: stage.holder, fence: stage.fence,
      entries: anchors.map((occurrence, index) => ({ occurrence, state: 'active', parent: base.structure,
        segmentKey: index < 32 ? 'a' : `a${'0'.repeat(30)}1`, orderKey: (index % 32).toString(36).padStart(2, '0'),
        role: 'chapter', target: work.work, selection: { mode: 'follow-context' },
        labels: [], introducedBy: stage.revision })) }));
    await json(await call('POST', `${path}/stages/${stage.id}/seal`, {
      actingSubject: member.actor, holder: stage.holder, fence: stage.fence }));
    const activated = await json<StructureStage>(await call('POST', `${path}/stages/${stage.id}/activate`, {
      actingSubject: member.actor }));
    const insert = (position: 'last' | { after: string }) => ({ op: 'insert', parent: base.structure,
      position, role: 'chapter', target: work.work });
    const changed = await json<Composition>(await call('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: activated.revision, actingSubject: member.actor,
      operations: [insert({ after: anchors[0]! })] }));
    expect(changed.cost.placementsWritten).toBe(33);
    expect(changed.cost.segmentsWritten).toBe(2);
    const read = async () => (await json<{ occurrences: Array<{ occurrence: string }> }>(await call('GET',
      `${path}?actingSubject=${encodeURIComponent(member.actor)}&limit=100`))).occurrences.map(item => item.occurrence);
    expect(await read()).toEqual([anchors[0]!, changed.occurrences[0]!, ...anchors.slice(1)]);
    const moving = anchors.at(-1)!;
    const moved = await json<Composition>(await call('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: changed.revision, actingSubject: member.actor,
      operations: [{ op: 'move', occurrence: moving, parent: base.structure, position: 'first' },
        { op: 'move', occurrence: anchors[31], parent: base.structure, position: 'last' }] }));
    const body = { profile: 'book-composition', expectedHead: moved.revision, actingSubject: member.actor,
      operations: [insert('last')] };
    const key = randomUUID();
    const composed = await json<Composition>(await call('POST', `${path}/changes`, body, key));
    await json<Composition>(await call('POST', `${path}/changes`, { profile: 'book-composition',
      expectedHead: composed.revision, actingSubject: member.actor,
      operations: [{ op: 'remove', occurrence: changed.occurrences[0] }] }));
    expect(await read()).toEqual([moving, ...anchors.slice(0, -1), composed.occurrences[0]!]);
    expect((await json<Composition>(await call('POST', `${path}/changes`, body, key))).revision).toBe(composed.revision);
    expect((await call('POST', `${path}/changes`, body)).status).toBe(409);
    expect(await readCompositionHeader(stack.env, base.structure)).toMatchObject({ placementCount: 34 });
  } finally { await stack.stop(); }
}, 60_000);
