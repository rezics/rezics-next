import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { StudioAccess } from '../../../services/main/src/modules/studio/access.ts';

const short = (value: string) => value.slice(-36);
async function json<T>(response: Response, expected = 200): Promise<T> {
  const value = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, received ${response.status}: ${value}`);
  return JSON.parse(value) as T;
}

test('A second Person identity reads and edits its own unpublished chapter Post revision without per-resource grants', async () => {
  const stack = await startMediaStack('post-note-custody', { library: true, agents: true, contentProjection: true });
  try {
    const member = await stack.member('chapter-account');
    const person = async (name: string) => (await json<{ agent: string }>(await member.send('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: name }), 201)).agent;
    const sessionIdentity = await person('Session Person');
    const writer = await person('Author Notes Writer');
    const principal = { ...member.principal, emailVerified: true as const };
    await stack.contentCursor.initialize(stack.contentConsumer);
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    const studio = new StudioAccess(stack.accessPool, stack.fuseki);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      studioAccess: studio, structureObjects: objects, content: stack.content, contentAuthoring: stack.content,
      contentProjection: { content: stack.content, cursor: stack.contentCursor, consumer: stack.contentConsumer },
      account: { verify: async () => ({ ...principal, currentAssertion: async () => principal }) } });
    const call = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${member.token}`, 'idempotency-key': randomUUID(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const book = await json<{ work: string; mainVersion: string }>(await call('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Second identity serial', language: 'en',
      semanticTypes: ['https://schema.org/Book'], actingSubject: writer }), 201);
    const composition = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: writer }), 201);
    const chapter = await json<{ post: string; variantId: string }>(await call('POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'Opening',
        language: 'en', direction: 'ltr', parent: composition.structure, position: 'last',
        expectedCompositionHead: composition.revision, actingSubject: writer }));
    expect((await stack.accessPool.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id LIKE $2`, [writer, `%${chapter.post}`])).rows).toHaveLength(0);
    expect(await studio.chapterWriters(principal, writer, [chapter.post]))
      .toEqual(new Map([[chapter.post, { writer, controlled: true }]]));
    expect(await stack.access.canReadWork(principal, writer, chapter.post)).toBe(true);
    expect(await studio.canReadContentVariants(principal, writer, chapter.post)).toBe(true);
    expect(await stack.access.canReadWork(principal, sessionIdentity, chapter.post)).toBe(false);
    expect(await studio.canReadContentVariants(principal, sessionIdentity, chapter.post)).toBe(false);
    const draft = { profile: 'content-text-v1', resourceId: chapter.post, variantId: chapter.variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
      body: 'A chapter written as another Person.',
      notes: { before: { body: 'Before note' }, after: { body: 'After note' } }, actingSubject: writer };
    const saved = await json<{ revisionId: string }>(await call('POST', '/v1/content-drafts', draft), 201);
    // Storage and custody are already successful before exercising the HTTP exact-read guard.
    expect((await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0])
      .toMatchObject({ status: 'available', body: { body: draft.body, notes: draft.notes } });
    const variants = await json<{ items: Array<{ draftHead: string }> }>(await call('GET',
      `/v1/works/${short(chapter.post)}/content-variants?actingSubject=${encodeURIComponent(writer)}`));
    expect(variants.items).toMatchObject([{ draftHead: saved.revisionId }]);
    const revisionPath = `/v1/content-revisions/${saved.revisionId}`;
    expect(await json(await call('GET', `${revisionPath}?actingSubject=${encodeURIComponent(writer)}`)))
      .toMatchObject({ body: { body: draft.body, notes: draft.notes } });
    expect((await call('GET', `${revisionPath}?actingSubject=${encodeURIComponent(sessionIdentity)}`)).status).toBe(404);
    expect((await call('POST', '/v1/content-drafts', { ...draft, expectedHead: saved.revisionId,
      actingSubject: sessionIdentity })).status).toBe(403);
    const updated = await json<{ revisionId: string }>(await call('POST', '/v1/content-drafts', {
      ...draft, expectedHead: saved.revisionId, notes: { ...draft.notes, after: { body: 'Updated note' } },
    }), 201);
    expect(await json(await call('GET', `/v1/content-revisions/${updated.revisionId}?actingSubject=${encodeURIComponent(writer)}`)))
      .toMatchObject({ body: { body: draft.body, notes: { before: draft.notes.before, after: { body: 'Updated note' } } } });
  } finally { await stack.stop(); }
}, 240_000);
