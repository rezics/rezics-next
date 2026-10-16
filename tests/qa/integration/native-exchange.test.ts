import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';

setDefaultTimeout(240_000);
let sessions: PersonaSessions;
beforeAll(async () => { sessions = await personaSessions('public'); }, 240_000);
afterAll(async () => { await sessions?.close(); });
const short = (value: string) => value.slice(-36);
async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('a Book composition exports all 260 exact pins in bounded resumable manifests', async () => {
  const owner = sessions.owner, actingSubject = owner.actingSubject!;
  const create = (title: string) => json<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
    semanticTypes: ['https://schema.org/Book'], actingSubject,
  }), 201);
  const work = await create('Native exchange inventory');
  const composition = await json<{ structure: string; revision: string }>(owner.main('POST', '/v1/compositions', {
    profile: 'book-composition', work: work.work, mainVersion: work.mainVersion, actingSubject,
  }), 201);
  const path = `/v1/compositions/${short(composition.structure)}`;
  const chapter = await json<{ post: string; occurrence: string; compositionRevision: string }>(owner.main('POST',
    `/v1/works/${short(work.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'An exact reusable chapter',
      language: 'en', direction: 'ltr', parent: composition.structure, position: 'last',
      expectedCompositionHead: composition.revision, actingSubject }));
  let revision = chapter.compositionRevision;
  const occurrences: string[] = [chapter.occurrence];
  while (occurrences.length < 260) {
    const changed = await json<{ revision: string; occurrences: string[] }>(owner.main('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: revision, actingSubject,
      operations: Array.from({ length: Math.min(16, 260 - occurrences.length) }, (_, index) => ({
        op: 'insert', parent: composition.structure, position: 'last', role: 'chapter', target: chapter.post,
        label: { value: `Chapter ${occurrences.length + index}`, language: 'en' },
      })),
    }));
    revision = changed.revision; occurrences.push(...changed.occurrences);
  }
  const seal = await json<{ seal: string; sourcePosition: { dataEpoch: string; sequence: string } }>(owner.main('POST', `${path}/seals`, {
    expectedHead: revision, actingSubject,
  }));
  await grantPersonaFixtureAuthority(owner, [{ scope: `export:${seal.seal}`, action: 'export.create' }]);
  type Manifest = { manifestId: string; manifestDigest: string; plan: { work: { members: number; bytes: number };
    members: Array<{ exactRef: string; data: { next?: string | null; after?: string | null; structureRevision?: string } }> } };
  let after: string | undefined;
  const exported: string[] = [];
  do {
    const body = { profile: 'export-create-v1', actingSubject, useScope: 'evaluation',
      selection: { kind: 'composition-seal', reference: seal.seal, structure: composition.structure,
        expectedPosition: { dataEpoch: seal.sourcePosition.dataEpoch, sequence: seal.sourcePosition.sequence }, ...(after ? { after } : {}) } };
    const key = randomUUID();
    const page = await json<Manifest>(owner.main('POST', '/v1/exports', body, key), 201);
    expect(page.plan.work.members).toBeLessThanOrEqual(256);
    expect(page.plan.work.bytes).toBeLessThanOrEqual(1_048_576);
    expect(page.plan.members[0]!.data.structureRevision).toBe(revision);
    const replay = await json<Manifest>(owner.main('POST', '/v1/exports', body, key));
    expect(replay.manifestDigest).toBe(page.manifestDigest);
    expect((await json<Manifest>(owner.main('GET', `/v1/exports/${page.manifestId}`))).manifestDigest).toBe(page.manifestDigest);
    exported.push(...page.plan.members.slice(1).map(member => member.exactRef));
    after = page.plan.members[0]!.data.next ?? undefined;
  } while (after);
  expect(exported).toEqual([...occurrences].sort());
  expect(new Set(exported).size).toBe(260);
  type NativePage = { revision: string; next: string | null; occurrences: Array<{ occurrence: string }>; cost: { occurrences: number } };
  const native: string[] = [];
  after = undefined;
  do {
    const query = new URLSearchParams({ actingSubject, revision, ...(after ? { after } : {}) });
    const page = await json<NativePage>(owner.main('GET', `${path}/export?${query}`));
    expect(page.revision).toBe(revision);
    expect(page.cost.occurrences).toBeLessThanOrEqual(64);
    native.push(...page.occurrences.map(item => item.occurrence));
    after = page.next ?? undefined;
  } while (after);
  expect(native).toEqual(occurrences);
  expect((await sessions.stranger.main('GET', `${path}/export?actingSubject=${encodeURIComponent(sessions.stranger.actingSubject!)}&revision=${encodeURIComponent(revision)}`)).status).toBe(404);
});

test('a Paprika collection resumes retained rows by file ID without reuploading', async () => {
  const owner = sessions.owner, actingSubject = owner.actingSubject!;
  const entries = Object.fromEntries(Array.from({ length: 2 }, (_, index) => [`${index}.paprikarecipe`, gzipSync(Buffer.from(JSON.stringify({
    uid: randomUUID(), name: `Retained recipe ${index}`, ingredients: '1 cup water', directions: 'Boil water.',
  })))]));
  type Page = { fileId: string; total: number; next: number | null; pending: boolean; state: string;
    items: Array<{ status: string; work: string; replayed: boolean }> };
  const uploaded = await json<Page>(owner.main('POST', `/v1/recipes/file-imports?${new URLSearchParams({ actingSubject, format: 'paprikarecipes', limit: '1' })}`,
    undefined, randomUUID(), { bytes: zipSync(entries), headers: { 'content-type': 'application/zip' } }));
  expect(uploaded).toMatchObject({ total: 2, next: 1, pending: false });
  expect(uploaded.fileId).toBeString();
  const path = `/v1/recipes/file-imports?${new URLSearchParams({ actingSubject, fileId: uploaded.fileId, after: '1', limit: '1' })}`;
  const key = randomUUID();
  const resumed = await json<Page>(owner.main('POST', path, undefined, key));
  expect(resumed).toMatchObject({ fileId: uploaded.fileId, total: 2, next: null, pending: false, state: 'completed' });
  expect(resumed.items[0]!.status).toBe('imported');
  const replay = await json<Page>(owner.main('POST', path, undefined, key));
  expect(replay.items[0]!.work).toBe(resumed.items[0]!.work);
  const status = await json<{ total: number; completed: number; state: string }>(owner.main('GET',
    `/v1/recipes/file-imports/${uploaded.fileId}?${new URLSearchParams({ actingSubject })}`));
  expect(status).toMatchObject({ total: 2, completed: 2, state: 'completed' });
  const denied = await sessions.stranger.main('GET', `/v1/recipes/file-imports/${uploaded.fileId}?${new URLSearchParams({ actingSubject: sessions.stranger.actingSubject! })}`);
  expect(denied.status).toBe(404);
});
