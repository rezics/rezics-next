import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import {
  PAGE_GLOBAL_CONTEXT,
  planReads,
  platformRegistry,
  validateProfile,
  type CompositionDocument,
  type PageContinuation,
} from '@rezics/composition';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { platformProfile } from '../../src/presentation/setup.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

type Kind = 'discussion' | 'review';
let fixture: ReleasedDiscoveryFixture;
let subject: string;
let hidden: string;
const expected: Record<Kind, string[]> = { discussion: [], review: [] };
const concealed: string[] = [];
const kinds = ['discussion', 'review'] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected native object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected native string');
  return value;
}
function threads(response: HttpResponse): Record<string, unknown>[] {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  if (!Array.isArray(response.body.threads)) throw new Error('Expected native threads');
  return response.body.threads.map(object);
}
const write = (path: string, body: unknown, persona: DiscoveryPersona = 'steward') =>
  fixture.request(persona, 'POST', path, body, discoveryKey());
function standalone(persona: DiscoveryPersona, kind: Kind, cursor?: string, limit = 6, id = subject, session?: string) {
  const query = new URLSearchParams({ place: PAGE_GLOBAL_CONTEXT, kind, limit: String(limit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return fixture.request(
    persona,
    'GET',
    `/v1/subjects/${id}/threads?${query}`,
    undefined,
    session ? { [SESSION_HEADER]: session } : undefined,
  );
}
function page(persona: DiscoveryPersona, view?: string, continuation?: PageContinuation, id = subject) {
  return fixture.request(persona, 'POST', '/v1/pages:read', {
    target: { subject: id, ...(view ? { view } : {}) },
    ...(continuation ? { continuation } : {}),
  });
}
function leaves(response: HttpResponse) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const plan = planReads(platformRegistry, response.body.document as CompositionDocument, {
    subject,
    ...(response.body.continuation ? { continuation: response.body.continuation as PageContinuation } : {}),
  });
  return { plan, reads: object(response.body.reads) };
}
async function board(conceptId: string, kind: Kind, visibility: 'published' | 'protected' = 'published') {
  const result = await write('/v1/boards', {
    conceptId,
    title: `Native ${kind} board`,
    purpose: kind === 'review' ? 'reviews' : 'discussion',
    visibility,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const id = text(object(result.body.board).id);
  await fixture.grant('steward', ['thread:create', 'board:read'], id);
  return id;
}
async function contribution(
  boardId: string,
  kind: Kind,
  title: string,
  visibility: 'published' | 'draft' = 'published',
) {
  const result = await write('/v1/threads', {
    boardId,
    kind,
    title,
    body: fromPlainText(`${title} opening body`),
    licence: 'MIT',
    subjectIds: [subject],
    visibility,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return object(result.body.thread);
}

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  await fixture.grant('steward', ['board:create'], PAGE_GLOBAL_CONTEXT);
  subject = (await fixture.createSubject('schema:Book', 'Composed native discussion and review')).id;
  const concept = await fixture.createSubject('skos:Concept', 'Native community topic');
  const changes: { kind: 'board' | 'post'; id: string }[] = [];
  const initiallyVisible: Record<Kind, string[]> = { discussion: [], review: [] };
  for (const kind of kinds) {
    const discussions = kind === 'discussion' ? await board(concept.id, kind) : undefined;
    for (let index = 0; index < 7; index++) {
      const boardId = discussions ?? (await board(concept.id, kind));
      const thread = await contribution(boardId, kind, `Public ${kind} ${index}`);
      expected[kind].push(text(thread.id));
    }
    initiallyVisible[kind].push(...expected[kind]);
    for (const target of ['board', 'post'] as const) {
      const boardId = await board(concept.id, kind);
      const title = `Concealed ${kind} ${target}`;
      const thread = await contribution(boardId, kind, title);
      initiallyVisible[kind].push(text(thread.id));
      concealed.push(text(thread.id), title, `${title} opening body`);
      changes.push({ kind: target, id: target === 'board' ? boardId : text(object(thread.firstPost).id) });
    }
    const protectedBoard = await board(concept.id, kind, 'protected');
    const protectedThread = await contribution(protectedBoard, kind, `Protected ${kind}`);
    concealed.push(text(protectedThread.id), `Protected ${kind}`, `Protected ${kind} opening body`);
    const draftBoard = await board(concept.id, kind);
    const draft = await contribution(draftBoard, kind, `Draft ${kind}`, 'draft');
    concealed.push(text(draft.id), `Draft ${kind}`, `Draft ${kind} opening body`);
  }
  // Only actual owner responses witness the default worker's progress; no SQL/effect runner or replacement Source.
  const deadline = Date.now() + 30_000;
  for (const kind of kinds) {
    for (;;) {
      const result = await standalone('anonymous', kind, undefined, 20);
      const ids = threads(result).map((thread) => text(thread.id));
      if (initiallyVisible[kind].every((id) => ids.includes(id))) break;
      if (Date.now() >= deadline)
        throw new Error(`Default worker subject threads did not converge: ${JSON.stringify(result.body)}`);
      await Bun.sleep(25);
    }
  }
  // Current point authority must conceal these immediately, independently of projection removal.
  for (const change of changes) {
    await fixture.grant('steward', ['moderation:takedown'], change.id);
    const result = await write(`/v1/${change.kind === 'board' ? 'boards' : 'posts'}/${change.id}:takeDown`, {
      reason: 'Native current-disclosure control',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  }
  hidden = (await fixture.createSubject('schema:Book', 'Hidden community subject')).id;
  await fixture.grant('steward', ['moderation:hide'], hidden);
  expect((await write(`/v1/subjects/${hidden}:hide`, { reason: 'Native subject concealment control' })).status).toBe(
    200,
  );
}, 180_000);

afterAll(async () => {
  // The shared fixture drains its actual default runtime before deleting owned state, including on substantive failure.
  await fixture?.close();
}, 180_000);

test('anonymous and editor subject pages contain the same currently disclosed discussion and review previews as the real standalone subject-thread route', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    const response = await page(persona);
    const { plan, reads } = leaves(response);
    for (const kind of kinds) {
      const binding = Object.entries(plan.reads).find(
        ([, read]) => read.kind === 'subjectThreads' && read.threadKind === kind,
      );
      expect(binding).toBeDefined();
      const [key, descriptor] = binding!;
      expect(descriptor).toEqual({
        kind: 'subjectThreads',
        id: subject,
        place: PAGE_GLOBAL_CONTEXT,
        threadKind: kind,
        limit: 6,
      });
      const owner = await standalone(persona, kind);
      const composed = object(reads[key]);
      expect(composed.status).toBe(owner.status);
      const body = object(composed.body);
      expect(body.threads).toEqual(owner.body.threads);
      expect(threads(owner)).toHaveLength(6);
      // Cursors carry their native issuance time. Consume the exact returned token from each response,
      // rather than normalizing it or treating tokens minted by independent requests as byte-identical.
      const next = text(body.next);
      const final = await standalone(persona, kind, next, 6, subject, text(response.headers.get(SESSION_HEADER)));
      expect(threads(final)).toHaveLength(1);
      expect(final.body.next).toBeNull();
      const ownerFinal = await standalone(persona, kind, text(owner.body.next));
      expect(final.status).toBe(ownerFinal.status);
      expect(final.body).toEqual(ownerFinal.body);
    }
    const wire = JSON.stringify(response.body);
    for (const withheld of concealed) expect(wire).not.toContain(withheld);
    for (const id of [hidden, '00000000-0000-7000-8000-ffffffffffff']) {
      expect((await page(persona, undefined, undefined, id)).status).toBe(404);
      expect((await standalone(persona, 'discussion', undefined, 6, id)).status).toBe(404);
    }
  }
});

test('public subject thread previews continue through the owner cursor and conceal hidden content', async () => {
  for (const persona of ['anonymous', 'editor'] as const) {
    for (const kind of kinds) {
      const view = kind === 'review' ? 'reviews' : 'discussion';
      let response = await page(persona, view);
      const seen: string[] = [];
      const cursors = new Set<string>();
      for (let step = 0; step < 8; step++) {
        const { plan, reads } = leaves(response);
        const binding = Object.entries(plan.reads).find(
          ([, read]) => read.kind === 'subjectThreads' && read.threadKind === kind,
        )!;
        const body = object(object(reads[binding[0]]).body);
        if (!Array.isArray(body.threads)) throw new Error('Expected composed native threads');
        seen.push(...body.threads.map((thread) => text(object(thread).id)));
        const wire = JSON.stringify(response.body);
        for (const withheld of concealed) expect(wire).not.toContain(withheld);
        if (body.next === null) break;
        const cursor = text(body.next);
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
        const node = Object.entries(plan.nodes).find(([, key]) => key === binding[0])![0];
        const owner = await standalone(persona, kind, cursor);
        response = await page(persona, view, { node, cursor });
        const continued = leaves(response);
        const leaf = object(continued.reads[continued.plan.nodes[node]!]);
        expect(leaf.status).toBe(owner.status);
        // Seven real contributions make this native continuation terminal, so the entire DTO matches exactly.
        expect(leaf.body).toEqual(owner.body);
        expect(owner.body.next).toBeNull();
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual([...expected[kind]].sort());
      expect(cursors.size).toBe(1);
    }
  }
});

test('Bind actual discussion and review composition reads and continuation', async () => {
  // A newly published configuration exercises independent nodes without changing an immutable profile.
  const document: CompositionDocument = {
    root: { props: {} },
    content: [
      { type: 'SubjectHeader', props: { id: 'header' } },
      { type: 'ThreadList', props: { id: 'discussion-one', paged: true } },
      { type: 'ThreadList', props: { id: 'discussion-two', paged: true } },
      { type: 'ReviewList', props: { id: 'reviews', paged: true } },
    ],
  };
  await fixture.grant('editor', ['presentation:publish', 'presentation:activate'], PAGE_GLOBAL_CONTEXT);
  const active = await fixture.request('editor', 'GET', '/v1/presentation/active');
  expect(active.status).toBe(200);
  const profile = structuredClone(platformProfile());
  profile.types = [
    ...profile.types.filter((entry) => entry.type !== 'schema:Book'),
    { type: 'schema:Book', views: { overview: document, discussion: document, reviews: document } },
  ].sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0));
  expect(validateProfile(platformRegistry, profile)).toEqual([]);
  const published = await write('/v1/presentation/profiles', { profile }, 'editor');
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  expect(
    (
      await write(
        `/v1/presentation/profiles/${text(published.body.digest)}:activate`,
        { expected_head: active.body.head },
        'editor',
      )
    ).status,
  ).toBe(200);
  const first = leaves(await page('anonymous', 'discussion'));
  expect(first.plan.nodes['discussion-one']).toBe(first.plan.nodes['discussion-two']);
  const cursor = text(object(object(first.reads[first.plan.nodes['discussion-one']!]).body).next);
  const next = await page('anonymous', 'discussion', { node: 'discussion-one', cursor });
  const continued = leaves(next);
  const owner = await standalone('anonymous', 'discussion', cursor);
  expect(continued.reads[continued.plan.nodes['discussion-one']!]).toEqual({ status: owner.status, body: owner.body });
  for (const node of ['discussion-two', 'reviews']) {
    expect(continued.reads[continued.plan.nodes[node]!]).toEqual({ status: 204, body: {} });
  }
  const invalid = await page('anonymous', 'reviews', { node: 'reviews', cursor });
  const invalidLeaves = leaves(invalid);
  expect(object(invalidLeaves.reads[invalidLeaves.plan.nodes.reviews!]).status).toBe(400);
});
