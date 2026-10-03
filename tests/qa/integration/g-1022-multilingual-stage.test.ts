import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { StructureStageStore } from '../../../services/main/src/modules/structure/stage.ts';
import { backfillOccurrenceLabels } from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`, short = (value: string) => value.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
test('G1022: sealing, activation, search and later edits preserve every staged label language', async () => {
  const stack = await startMediaStack('g-1022-multilingual');
  try {
    const member = await stack.member('multilingual-editor'), objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const makeWork = async (title: string, semanticTypes: string[]) => {
      const work = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const content = await stack.contribution(work.work, member.actor, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
        contribution: content.contribution, publicationDecision: content.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
      await selectMainDefault(stack.env, stack.admission(member.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await member.grant(`work:edit:${work.work}`, 'work.edit'); await member.grant(`work:read:${work.work}`, 'work.read');
      return work;
    };
    const work = await makeWork('Multilingual chapter labels', ['https://schema.org/Book']);
    const chapter = await makeWork('Multilingual chapter', ['https://schema.org/DigitalDocument']);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async () => member.principal } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const composition = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject: member.actor,
    }), 201);
    const path = `/v1/compositions/${short(composition.structure)}/stages`;
    const stage = await json<{ id: string; revision: string; holder: string; fence: string }>(await call('POST', path, {
      expectedHead: composition.revision, actingSubject: member.actor,
    }), 201);
    const occurrence = id(), labels = [{ value: '魔法禁書目錄', language: 'zh-Hant' },
      { value: 'ｶﾞﾗｽ ＲＵＳＴ', language: 'ja' }, { value: 'Cafe\u0301', language: 'fr' }];
    const entry = { occurrence, state: 'active', parent: composition.structure, segmentKey: 'a', orderKey: 'a',
      role: 'chapter', target: chapter.work, selection: { mode: 'follow-context' }, introducedBy: stage.revision, labels };
    await json(await call('PUT', `${path}/${stage.id}/pages/0`, { actingSubject: member.actor,
      holder: stage.holder, fence: stage.fence, entries: [entry] }));
    await json(await call('POST', `${path}/${stage.id}/seal`, { actingSubject: member.actor, holder: stage.holder, fence: stage.fence }));
    const active = await json<{ revision: string }>(await call('POST', `${path}/${stage.id}/activate`, { actingSubject: member.actor }));
    const read = (q: string) => call('GET', `/v1/reading-positions/${short(work.work)}?${new URLSearchParams({ q, limit: '1', actingSubject: member.actor })}`);
    const pending = await json<{ complete: boolean; search: { status: string }; count: { kind: string } }>(await read('CAFÉ'));
    expect(pending).toMatchObject({ complete: false, search: { status: 'indexing' }, count: { kind: 'at-least' } });
    const lag = await json<{ status: string; occurrenceLabels: { status: string } }>(await call('GET', '/health/search-ready'));
    expect(lag).toMatchObject({ status: 'indexing', occurrenceLabels: { status: 'indexing' } });
    await backfillOccurrenceLabels(stack.env);
    expect(await json(await call('GET', '/health/search-ready'))).toMatchObject({ status: 'ready', occurrenceLabels: { status: 'current' } });
    for (const q of ['禁书目录', 'がらす', 'CAFÉ']) {
      const page = await json<{ items: Array<{ occurrence: string; labels: typeof labels }> }>(await read(q));
      expect(page.items.map(item => item.occurrence)).toEqual([occurrence]);
      expect(new Set(page.items[0]!.labels.map(label => `${label.language.toLowerCase()}|${label.value}`)))
        .toEqual(new Set(labels.map(label => `${label.language.toLowerCase()}|${label.value}`)));
    }
    await json(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'book-composition', expectedHead: active.revision, actingSubject: member.actor,
      operations: [{ op: 'update', occurrence, label: { value: 'Nouvelle rencontre', language: 'fr' } }],
    }));
    expect(await json(await read('CAFÉ'))).toMatchObject({ items: [], complete: false, search: { status: 'indexing' } });
    await backfillOccurrenceLabels(stack.env);
    expect((await json<{ items: unknown[] }>(await read('CAFÉ'))).items).toEqual([]);
    for (const q of ['禁书目录', 'がらす', 'rencontre']) {
      expect((await json<{ items: Array<{ occurrence: string }> }>(await read(q))).items.map(item => item.occurrence)).toEqual([occurrence]);
    }
    const duplicate = await json<typeof stage>(await call('POST', path, { expectedHead:
      (await json<{ revision: string }>(await call('GET', `/v1/compositions/${short(composition.structure)}?actingSubject=${encodeURIComponent(member.actor)}`))).revision,
    actingSubject: member.actor }), 201);
    const denied = await call('PUT', `${path}/${duplicate.id}/pages/0`, { actingSubject: member.actor,
      holder: duplicate.holder, fence: duplicate.fence, entries: [{ ...entry, labels:
        [{ value: 'First', language: 'en-US' }, { value: 'Second', language: 'en-us' }] }] });
    expect(denied.status).toBe(400);
  } finally { await stack.stop(); }
}, 600_000);
