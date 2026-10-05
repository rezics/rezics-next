import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { ReadingPositionStore, type Revelation } from '../../../services/main/src/modules/reading-position/store.ts';
import { recordStatement, recordStatementRequest } from '../../../services/main/src/modules/statement/graph.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

type Composition = { structure: string; revision: string; occurrences: string[] };
type Page = { items: { id: string }[]; nextCursor: string | null };
type Claims = { claims: { statement: string; subject: string }[]; total: number; continuation: unknown };
async function json<T>(response: Response, expected = 200): Promise<T> {
  if (response.status !== expected) throw new Error(`${response.status} (expected ${expected}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('participation revealed at chapter 3 is absent at chapter 2 in projection and statement graph reads', async () => {
  const stack = await startMediaStack('event-participants-position');
  try {
    const editor = await stack.member('position-editor');
    const revelations = new ReadingPositionStore(stack.contentPool);
    const objects = stack.objects('semantic/structure/'); await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, structureObjects: objects, readingPositions: revelations,
      projections: new ProjectionStore(stack.accessPool), account: { verify: async request => {
        if (request.headers.get('authorization') !== `Bearer ${editor.token}`) throw new AccountAssertionDenied();
        return editor.principal;
      } } });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${editor.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const title = 'Participation continuity', types = ['https://schema.org/Book'];
    const work = await activateMetadataWork(stack.env, { title, semanticTypes: types,
      admission: stack.admission(editor.actor, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, types)) });
    const text = await stack.contribution(work.work, editor.actor, 'en', title);
    const selection = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: editor.actor };
    await selectMainDefault(stack.env, stack.admission(editor.actor, `publication:select:${work.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    for (const [scope, action] of [[`work:edit:${work.work}`, 'work.edit'], [`work:read:${work.work}`, 'work.read'],
      ['semantic:create:root', 'semantic.change'], ['projection:create:root', 'projection.create']] as const) {
      await editor.grant(scope, action);
    }
    let book = await json<Composition>(await call('POST', '/v1/compositions', { profile: 'book-composition',
      work: work.work, mainVersion: work.mainVersion, actingSubject: editor.actor }), 201);
    book = await json<Composition>(await call('POST', `/v1/compositions/${book.structure.slice(-36)}/changes`, {
      profile: 'book-composition', expectedHead: book.revision, actingSubject: editor.actor,
      operations: [1, 2, 3].map(number => ({ op: 'insert', role: 'chapter', parent: book.structure, position: 'last',
        target: 'https://schema.org/DigitalDocument', label: { value: `Chapter ${number}`, language: 'en' } })) }));
    const chapter2 = book.occurrences[1]!, chapter3 = book.occurrences[2]!;
    const resource = async (type: string) => {
      const saved = await json<{ component: string }>(await editor.send('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor.actor,
        state: { component: 'resource', types: [type], properties: [{ predicate: 'https://rezics.com/vocab/semanticWork',
          value: { kind: 'resource', ref: work.work } }] } }), 201);
      await editor.grant(`semantic:read:${saved.component}`, 'semantic.read');
      return saved.component;
    };
    const event = await resource('https://schema.org/Event'), person = await resource('https://schema.org/Person');
    const latePerson = await resource('https://schema.org/Person'), lateFrame = await resource('https://schema.org/Event');
    const project = async (subject: string, frame: string) => (await json<{ projection: { id: string } }>(
      await editor.send('POST', '/v1/projections', { subject, frames: [frame], actingSubject: editor.actor }), 201)).projection.id;
    const participation = await project(person, event);
    const withheldSubject = await project(latePerson, event), withheldFrame = await project(person, lateFrame);
    const statement = async (subject: string, object = event) => {
      const input = { speaker: { kind: 'personal' as const }, subject,
        predicate: 'https://example.org/participates', relationDefinition: 'https://example.org/participation-v1',
        value: { kind: 'resource' as const, iri: object }, applicability: [],
        interpretation: { kind: 'selected' as const }, evidence: [], actingSubject: editor.actor };
      const intent = recordStatementRequest(input);
      const saved = await recordStatement(stack.env, stack.admission(editor.actor, intent.scope, intent.action, intent.digest),
        input, { kind: 'personal', canReadPrivate: async () => false });
      return saved.component!;
    };
    const claim = await statement(person), lateSubjectClaim = await statement(latePerson);
    const projectionClaim = await statement(withheldFrame);
    const reveal = async (record: string, occurrence: string, recordKind: Revelation['recordKind'] = 'entity') => {
      const client = await stack.contentPool.connect();
      try {
        await client.query('BEGIN');
        await revelations.write(client, { record, recordKind, continuityWork: work.work, occurrence, receipt: 'reviewed-publication' }, null);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    await reveal(person, chapter2); await reveal(event, chapter2);
    await reveal(claim, chapter3, 'statement'); await reveal(participation, chapter3);
    await reveal(latePerson, chapter3); await reveal(lateFrame, chapter3);
    const list = (position?: string, selectors: Record<string, string> = { frame: event }, extra: Record<string, string> = {}) => {
      const query = new URLSearchParams({ ...selectors, actingSubject: editor.actor, ...(position ? { position } : {}), ...extra });
      return call('GET', `/v1/projections?${query}`);
    };
    const graph = (position?: string, extra: object = {}) => call('POST', '/v1/graph/queries', {
      profile: 'statement-graph-v1', actingSubject: editor.actor, anchor: event, direction: 'incoming',
      ...(position ? { position } : {}), ...extra });
    // An early person alone does not reveal the later participation.
    for (const position of [undefined, 'mine', 'start', chapter2]) {
      expect(await json<Page>(await list(position))).toMatchObject({ items: [], nextCursor: null });
      if (position === chapter2) {
        expect(await json<Claims>(await graph(position))).toMatchObject({ claims: [], total: 0, continuation: null });
      } else expect((await graph(position)).status).toBe(404);
      expect(await json<Page>(await list(position, { subject: person, frames: event }))).toMatchObject({ items: [] });
    }
    for (const position of [chapter3, 'all']) {
      expect((await json<Page>(await list(position))).items.map(item => item.id).sort()).toEqual([participation, withheldSubject].sort());
      expect((await json<Claims>(await graph(position))).claims.map(item => item.statement).sort())
        .toEqual([claim, lateSubjectClaim, projectionClaim].sort());
      expect((await json<Page>(await list(position, { subject: person, frames: event }))).items).toEqual([{ id: participation,
        subject: person, frames: [event], revision: expect.any(String), disclosure: 'public' }]);
    }
    expect((await graph(chapter2, { anchor: latePerson, direction: 'outgoing' })).status).toBe(404);
    // Both direction and projection endpoints obey the same boundary.
    expect((await json<Claims>(await graph(chapter2, { anchor: person, direction: 'outgoing' }))).claims).toEqual([]);
    expect((await json<Claims>(await graph(chapter3, { anchor: person, direction: 'outgoing' }))).claims[0]?.statement).toBe(claim);
    expect((await json<Page>(await list(chapter2, { subject: person }))).items).toEqual([]);
    expect((await json<Page>(await list(chapter3, { subject: person }))).items.map(item => item.id).sort())
      .toEqual([participation, withheldFrame].sort());

    const first = await json<Page>(await list(chapter3, { frame: event }, { limit: '1' }));
    expect(first.nextCursor).toBeString();
    expect((await list(chapter2, { frame: event }, { limit: '1', cursor: first.nextCursor! })).status).toBe(400);
    expect((await json<Page>(await list(chapter3, { frame: event }, { limit: '1', cursor: first.nextCursor! }))).items).toHaveLength(1);
    await reveal(`https://rezics.com/id/${randomUUID()}`, chapter3);
    expect((await list(chapter3, { frame: event }, { limit: '1', cursor: first.nextCursor! })).status).toBe(400);
    for (const position of ['chapter 3', 'https://elsewhere.example/chapter']) {
      expect((await list(position)).status).toBe(400); expect((await graph(position)).status).toBe(400);
    }
    // Revelation storage receives bounded sets. Adding claims about the same
    // visible endpoints adds no per-claim lookup or projection expansion query.
    const lookup = revelations.lookup.bind(revelations), sizes: number[] = [];
    revelations.lookup = async records => { sizes.push(records.length); return lookup(records); };
    const measure = async () => {
      sizes.length = 0; const before = stack.fuseki.queries;
      await json<Claims>(await graph('all'));
      return { queries: stack.fuseki.queries - before, batches: sizes.length };
    };
    const small = await measure();
    for (let index = 0; index < 8; index++) await statement(person);
    expect(await measure()).toEqual(small);
    expect(sizes.every(size => size <= 50)).toBe(true);
  } finally { await stack.stop(); }
}, 240_000);
