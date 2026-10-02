import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { StructureStageStore, type StructureStage } from '../../../services/main/src/modules/structure/stage.ts';
import { startMediaStack } from './media-support.ts';

type Composition = { structure: string; revision: string; occurrences: string[] };
type Page = { items: Array<{ occurrence: string; ordinal: number; labels: Array<{ value: string; language: string }> }>;
  nextCursor: string | null; complete: boolean; resolved: string };
const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, expected = 200): Promise<T> {
  if (response.status !== expected) throw new Error(`${response.status} (expected ${expected}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G954: 1000-chapter chooser searches CJK and chapter numbers before paging and keeps disclosure and cursor fences', async () => {
  const started = Date.now();
  const stack = await startMediaStack('g-954-position');
  try {
    const member = await stack.member('chooser-editor');
    const store = new ReadingPositionStore(stack.contentPool);
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    let active = true;
    const deps = { environment: stack.env, access: stack.access, media: stack.media,
      mediaAccess: stack.mediaAccess, readingPositions: store,
      structureObjects: objects,
      account: { verify: async (request: Request) => {
        if (!active || request.headers.get('authorization') !== `Bearer ${member.token}`) {
          throw new AccountAssertionDenied('Unknown bearer');
        }
        return member.principal;
      } } } satisfies MainWorkDependencies;
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: object, signed = true) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(signed ? { authorization: `Bearer ${member.token}` } : {}),
        'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const semanticTypes = ['https://schema.org/Book'];
    const title = 'G954 searchable continuity';
    const work = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    const text = await stack.contribution(work.work, member.actor, 'en', title);
    const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
    await selectMainDefault(stack.env, stack.admission(member.actor, `publication:select:${work.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    await member.grant(`work:edit:${work.work}`, 'work.edit');
    await member.grant(`work:read:${work.work}`, 'work.read');
    let composition = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
      work: work.work, mainVersion: work.mainVersion, actingSubject: member.actor }), 201);
    for (let offset = 0; offset < 1000; offset += 16) {
      composition = await json<Composition>(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'book-composition', expectedHead: composition.revision, actingSubject: member.actor,
        operations: Array.from({ length: Math.min(16, 1000 - offset) }, (_, index) => {
          const number = offset + index + 1;
          return { op: 'insert', role: 'chapter', parent: composition.structure, position: 'last',
            target: 'https://schema.org/DigitalDocument', label: number === 1000
              ? { value: '重逢', language: 'zh-Hans' } : number === 999
                ? { value: '再会', language: 'ja' } : { value: `Chapter ${number}`, language: 'en' } };
        }) }));
    }
    // No rebuild or migration is needed: search reads the existing owner projection.
    expect(Date.now() - started).toBeLessThan(600_000);
    const read = (query: Record<string, string> = {}, signed = false, resource = work.work) => {
      const params = new URLSearchParams(query);
      if (signed) params.set('actingSubject', member.actor);
      return call('GET', `/v1/reading-positions/${short(resource)}?${params}`, undefined, signed);
    };
    for (const [q, ordinal] of [['重逢', 1000], ['１０００', 1000], ['再会', 999], ['999', 999]] as const) {
      const before = stack.fuseki.queries;
      const page = await json<Page>(await read({ q, language: 'en', limit: '1' }));
      expect(page.items).toHaveLength(1); expect(page.items[0]!.ordinal).toBe(ordinal);
      expect(page.nextCursor).toBeNull(); expect(page.complete).toBe(true); expect(page.resolved).toBe('start');
      expect(stack.fuseki.queries - before).toBeLessThan(12);
    }
    const inventory: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await json<Page>(await read({ limit: '100', ...(cursor ? { cursor } : {}) }));
      inventory.push(...page.items.map(item => item.occurrence)); cursor = page.nextCursor ?? undefined;
      expect(page.complete).toBe(cursor === undefined);
    } while (cursor);
    expect(inventory).toHaveLength(1000); expect(new Set(inventory).size).toBe(1000);
    const last = inventory.at(-1)!;
    const first = await json<Page>(await read({ q: 'chapter 9', limit: '2', position: last }));
    expect(first.items.map(item => item.ordinal)).toEqual([9, 90]);
    expect(first.resolved).toBe(last); expect(first.complete).toBe(false);
    const tail = await json<Page>(await read({ q: 'chapter 9', cursor: first.nextCursor!, limit: '2', position: last }));
    expect(tail.items.map(item => item.ordinal)).toEqual([91, 92]);
    for (const query of [{ q: 'chapter 8', position: last }, { q: 'chapter 9', position: 'all' }]) {
      expect((await read({ ...query, cursor: first.nextCursor! })).status).toBe(400);
    }
    expect((await read({ q: 'chapter 9', cursor: first.nextCursor!, position: last }, true)).status).toBe(400);
    const hidden = await stack.privateWork(member.actor, 'Private continuity');
    const missing = `https://rezics.com/id/${randomUUID()}`;
    const denied = await read({ q: 'Private' }, false, hidden.work);
    const absent = await read({ q: 'Private' }, false, missing);
    expect(denied.status).toBe(404); expect(await denied.json()).toEqual(await absent.json());
    expect((await read({ q: 'x'.repeat(201) })).status).toBe(422);
    expect((await read({ limit: '1.5' })).status).toBe(422);
    active = false; expect((await read({ q: '重逢' }, true)).status).toBe(401);
    active = true;
    await json(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'book-composition', expectedHead: composition.revision, actingSubject: member.actor,
      operations: [{ op: 'insert', role: 'chapter', parent: composition.structure, position: 'last',
        target: 'https://schema.org/DigitalDocument', label: { value: 'New chapter', language: 'en' } }] }));
    expect((await read({ q: 'chapter 9', cursor: first.nextCursor!, position: last })).status).toBe(409);
  } finally { await stack.stop(); }
}, 600_000);

test('G954: API-built 10503-occurrence story traverses the old ceiling, seeks distant multilingual chapters and resolves saved positions', async () => {
  const started = Date.now();
  const stack = await startMediaStack('g-954-large-position');
  try {
    const member = await stack.member('large-chooser-editor');
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, readingPositions: new ReadingPositionStore(stack.contentPool),
      structureObjects: objects, structureStages: new StructureStageStore(stack.contentPool, objects),
      account: { verify: async (request: Request) => {
        if (request.headers.get('authorization') !== `Bearer ${member.token}`) throw new AccountAssertionDenied('Unknown bearer');
        return member.principal;
      } } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const createWork = async (title: string) => {
      const semanticTypes = ['https://schema.org/Book'];
      const created = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(member.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const text = await stack.contribution(created.work, member.actor, 'en', title);
      const selection = { context: { kind: 'main-version-default' as const, id: created.mainVersion }, work: created.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
      await selectMainDefault(stack.env, stack.admission(member.actor, `publication:select:${created.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await member.grant(`work:edit:${created.work}`, 'work.edit');
      return created;
    };
    const series = await createWork('G954 long composed story');
    let root = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'work-composition',
      work: series.work, mainVersion: series.mainVersion, actingSubject: member.actor }), 201);
    const volumes = await Promise.all([1, 2, 3].map(number => createWork(`G954 volume ${number}`)));
    root = await json<Composition>(await call('POST', `/v1/compositions/${short(root.structure)}/changes`, {
      profile: 'work-composition', expectedHead: root.revision, actingSubject: member.actor,
      operations: volumes.map((volume, index) => ({ op: 'insert', role: 'part', parent: root.structure, position: 'last',
        target: volume.work, displayLabel: String(index + 1), inclusion: 'required' })) }));
    const expected: string[] = [];
    for (const [volumeIndex, volume] of volumes.entries()) {
      expected.push(root.occurrences[volumeIndex]!);
      const base = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
        work: volume.work, mainVersion: volume.mainVersion, actingSubject: member.actor }), 201);
      const path = `/v1/compositions/${short(base.structure)}/stages`;
      const stage = await json<StructureStage>(await call('POST', path,
        { expectedHead: base.revision, actingSubject: member.actor }), 201);
      for (let offset = 0, page = 0; offset < 3500; offset += 256, page++) {
        const entries = Array.from({ length: Math.min(256, 3500 - offset) }, (_, index) => {
          const local = offset + index, global = volumeIndex * 3500 + local + 1;
          const occurrence = `https://rezics.com/id/${randomUUID()}`; expected.push(occurrence);
          return { occurrence, state: 'active', parent: base.structure,
            segmentKey: Math.floor(local / 32).toString(36).padStart(4, '0'),
            orderKey: (local % 32).toString(36).padStart(2, '0'), role: 'chapter',
            target: 'https://schema.org/DigitalDocument', introducedBy: stage.revision,
            labels: [{ value: global === 10500 ? '重逢' : `Chapter ${global}`,
              language: global === 10500 ? 'yue' : 'en' }] };
        });
        await json(await call('PUT', `${path}/${stage.id}/pages/${page}`, { actingSubject: member.actor,
          holder: stage.holder, fence: stage.fence, entries }));
      }
      await json(await call('POST', `${path}/${stage.id}/seal`,
        { actingSubject: member.actor, holder: stage.holder, fence: stage.fence }));
      const activated = await json<StructureStage>(await call('POST', `${path}/${stage.id}/activate`, { actingSubject: member.actor }));
      expect(activated.status).toBe('activated'); expect(activated.placementCount).toBe(3500);
    }
    expect(expected).toHaveLength(10_503);
    expect(Date.now() - started).toBeLessThan(600_000);
    const read = (query: Record<string, string> = {}) => app.handle(new Request(
      `http://main.local/v1/reading-positions/${short(series.work)}?${new URLSearchParams(query)}`));
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await json<Page>(await read({ limit: '100', ...(cursor ? { cursor } : {}) }));
      actual.push(...page.items.map(item => item.occurrence));
      expect(page.complete).toBe(page.nextCursor === null); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(actual).toEqual(expected); expect(new Set(actual).size).toBe(expected.length);
    for (const q of ['重逢', 'Chapter 10001', '１０００１']) {
      const page = await json<Page>(await read({ q, language: 'en', limit: '1', position: expected.at(-1)! }));
      expect(page.items).toHaveLength(1); expect(page.complete).toBe(true); expect(page.nextCursor).toBeNull();
      expect(page.resolved).toBe(expected.at(-1)!);
      expect(page.items[0]!.occurrence).toBe(q === '重逢' ? expected.at(-1)! : expected[10_003]!);
    }
    const numbered = await json<Page>(await read({ q: '3500', limit: '100' }));
    expect(numbered.items.map(item => item.ordinal)).toEqual([3500, 3500, 3500]);
    const boundary = await json<Page>(await read({ q: 'Chapter 10', limit: '2' }));
    expect(boundary.complete).toBe(false);
    const matches: Page['items'] = [...boundary.items];
    let searchedCursor = boundary.nextCursor;
    while (searchedCursor) {
      const resumed = await json<Page>(await read({ q: 'Chapter 10', limit: '100', cursor: searchedCursor }));
      matches.push(...resumed.items); searchedCursor = resumed.nextCursor;
    }
    expect(matches.some(item => item.ordinal > 3000 && item.labels.some(label => label.value.includes('10001')))).toBe(true);
  } finally { await stack.stop(); }
}, 600_000);
