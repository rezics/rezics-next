import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { StructureStageStore, type StructureStage } from '../../../services/main/src/modules/structure/stage.ts';
import type { CompositionCost } from '../../../services/main/src/modules/structure/change.ts';
import { evenKeys } from '../../../services/main/src/modules/structure/order-key.ts';
import { startMediaStack } from './media-support.ts';

type Composition = { structure: string; revision: string; occurrences: string[]; cost: CompositionCost };
type NativeWork = { focuses: number; validationMs: number; updateMs: number };

const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status} (expected ${status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}
function field(source: string, name: string): number {
  const match = new RegExp(`(?:^|,)\\s*${name}(?:=|;dur=)(\\d+(?:\\.\\d+)?)`).exec(source);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`missing ${name} in ${source}`);
  return value;
}

test('a 16-occurrence composition change validates the same focus at 100 and 1000 chapters', async () => {
  const stack = await startMediaStack('composition-change-cost');
  const originalFetch = globalThis.fetch;
  const compositionWork: NativeWork[] = [];
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.endsWith('/command') && body.includes('composition.change')) {
      const counters = response.headers.get('x-rezics-command-work') ?? '';
      const timing = response.headers.get('server-timing') ?? '';
      compositionWork.push({
        focuses: field(counters, 'validation_focuses'),
        validationMs: field(timing, 'validation'),
        updateMs: field(timing, 'update'),
      });
    }
    return response;
  };
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
    const title = 'Bounded composition change', semanticTypes = ['https://schema.org/Book'];
    const work = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    await member.grant(`work:edit:${work.work}`, 'work.edit');
    await member.grant(`work:read:${work.work}`, 'work.read');
    const chapterTitle = 'Repeated chapter target';
    const chapter = await activateMetadataWork(stack.env, { title: chapterTitle,
      admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(chapterTitle)) });
    await member.grant(`work:read:${chapter.work}`, 'work.read');
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
    const activated = await json<StructureStage>(await call('POST', `${path}/stages/${stage.id}/activate`, {
      actingSubject: member.actor }));
    composition.revision = activated.revision;
    const insert = (position: { after: string }) => ({ op: 'insert', parent: composition.structure,
      position, role: 'chapter', target: chapter.work, selection: { mode: 'follow-context' } });
    const change = async (operations: object[]) => {
      composition = await json<Composition>(await call('POST', `${path}/changes`, {
        profile: 'book-composition', expectedHead: composition.revision, actingSubject: member.actor, operations }));
    };
    const sample = async (count: number) => {
      const before = compositionWork.length;
      const anchor = anchors[count % anchors.length]!;
      await change(Array.from({ length: 16 }, () => insert({ after: anchor })));
      const work = compositionWork.at(-1);
      if (!work || compositionWork.length === before) throw new Error('composition command did not report native work');
      console.log('composition-change-cost', JSON.stringify({ chapters: count, ...work }));
      return work;
    };
    let count = 100;
    const at100 = await sample(count);
    count += 16;
    while (count + 16 <= 1000) {
      const anchor = anchors[Math.floor(count / 16) % anchors.length]!;
      await change(Array.from({ length: 16 }, () => insert({ after: anchor })));
      count += 16;
    }
    const at1000 = await sample(count);
    // A segment split rewrites one neighbourhood (at most 32 members). The focus
    // stays inside that bound at both scales; it does not track the structure.
    expect(at100.focuses).toBeLessThan(250);
    expect(at1000.focuses).toBeLessThan(250);
    expect(Math.abs(at1000.focuses - at100.focuses)).toBeLessThan(120);
    expect(at100.validationMs).toBeGreaterThan(0);
    expect(at1000.updateMs).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = originalFetch;
    await stack.stop();
  }
}, 300_000);
