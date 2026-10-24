import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import type { exactContentRevision } from '../../../services/main/src/api-responses.ts';
import type { chapterRead, contentsPage } from '../../../services/main/src/modules/work-contents/read-contract.ts';
import type { ReleaseView } from '../../../services/main/src/modules/release/read.ts';
import type { EditionPreference } from '../../../services/main/src/modules/session/preference-contract.ts';
import { answer, publicDomainFixture, short, viewer } from '../support/catalogue-public-domain.ts';
import { personaNames } from '../support/personas.ts';

setDefaultTimeout(120_000);
let fixture: Awaited<ReturnType<typeof publicDomainFixture>>;
beforeAll(async () => {
  fixture = await publicDomainFixture('book');
  // Real publication is a prerequisite. A descriptive PublicationEvent is insufficient.
  expect(await answer(fixture.people.visitor.main('GET', `/v1/works/${short(fixture.corpus.book.work)}`)))
    .toMatchObject({ id: fixture.corpus.book.work, publicationState: 'published', disclosure: 'public' });
}, 600_000);
afterAll(async () => { await fixture?.close(); });

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
function contentText(value: unknown): string {
  if (Array.isArray(value)) return value.map(contentText).join('');
  if (!value || typeof value !== 'object') return '';
  if ('body' in value && typeof value.body === 'string') return value.body;
  return Object.entries(value).map(([key, child]) => key === 'text' && typeof child === 'string'
    ? child : contentText(child)).join('');
}

// Content references carry a UUID; selection carries its exact Content revision URN.
function contentRevisionUrn(reference: { owner: string; resourceId: string; revisionId: string }, target: string): string | null {
  if (reference.owner !== 'content' || reference.resourceId !== target
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(target)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(reference.revisionId)) return null;
  return `urn:rezics:content:revision:${reference.revisionId}`;
}

test('C28 representation premise refuses identity lookalikes and preserves body bytes', () => {
  const target = 'https://rezics.com/id/c3d6212e-6b90-847a-84aa-2017108a42c6';
  const revisionId = '8933c22e-e959-435e-ad63-53db33b306d4';
  const selected = `urn:rezics:content:revision:${revisionId}`;
  const reference = { owner: 'content', resourceId: target, revisionId };
  expect(contentRevisionUrn(reference, target)).toBe(selected);
  for (const wrong of [revisionId, target, `urn:other:content:revision:${revisionId}`,
    `urn:rezics:work:revision:${revisionId}`, `urn:rezics:content:variant:${revisionId}`,
    `https://elsewhere.example/id/${revisionId}`, `prefix:${selected}`]) {
    expect(contentRevisionUrn(reference, target)).not.toBe(wrong);
  }
  expect(contentRevisionUrn({ ...reference, owner: 'work' }, target)).toBeNull();
  expect(contentRevisionUrn({ ...reference, resourceId: target.replace('rezics.com', 'elsewhere.example') }, target)).toBeNull();
  expect(contentRevisionUrn(reference, target.replace('rezics.com', 'elsewhere.example'))).toBeNull();
  const wrongAuthority = target.replace('rezics.com', 'rezics.com.elsewhere.example');
  expect(contentRevisionUrn({ ...reference, resourceId: wrongAuthority }, wrongAuthority)).toBeNull();
  expect(contentRevisionUrn({ ...reference, resourceId: target.replace('/id/', '/other/') }, target)).toBeNull();
  expect(contentRevisionUrn(reference, target.replace('c3d6212e', 'd3d6212e'))).toBeNull();
  for (const wrong of [selected, `prefix:${revisionId}`, `${revisionId}suffix`, revisionId.toUpperCase()]) {
    expect(contentRevisionUrn({ ...reference, revisionId: wrong }, target)).toBeNull();
  }
  const body = 'Retained paragraph.\n\nSecond paragraph with  exact spacing.\r\n';
  expect(contentText({ body })).toBe(body);
  expect(contentText({ type: 'doc', content: [{ type: 'text', text: body }] })).toBe(body);
  expect(contentText({ body, document: { type: 'doc', content: [{ type: 'text', text: body }] } })).toBe(body);
  expect(contentText({ body: 42 })).toBe('');
  expect(contentText({ title: body })).toBe('');
  expect(contentText({ body: body.replace('Retained', 'Changed') })).not.toBe(body);
});

for (const name of personaNames) test(`C28 real public Book / ${name}: understand, choose, read, navigate and return`, async () => {
  const { book } = fixture.corpus, people = fixture.people, person = people[name];
  const workPath = `/v1/works/${short(book.work)}`;
  const read = <T,>(path: string) => answer<T>(person.main('GET', viewer(person, path)));
  const header = await read<{ id: string; title: { value: string }; selectedLanguage: string;
    description: { value: string; language: string } | null }>(`${workPath}?language=${book.language}`);
  expect(header).toMatchObject({ id: book.work, title: { value: book.title }, selectedLanguage: book.language,
    description: { value: book.description.value, language: book.description.language } });
  const credits: Array<{ role: string; agent: string | null; displayName: string | null }> = [];
  let cursor: string | null = null;
  const creditCursors = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const page = await read<{ items: typeof credits; nextCursor: string | null }>(`${workPath}/credits?${query}`);
    credits.push(...page.items); cursor = page.nextCursor;
    if (cursor) { expect(creditCursors.has(cursor)).toBe(false); creditCursors.add(cursor); }
  } while (cursor);
  expect(credits).toContainEqual(expect.objectContaining({ role: 'author', agent: book.author.agent, displayName: book.author.name }));

  const releases: ReleaseView[] = [], releaseCursors = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: '1' });
    if (cursor) query.set('cursor', cursor);
    const page = await read<{ items: ReleaseView[]; nextCursor: string | null }>(`${workPath}/releases?${query}`);
    releases.push(...page.items); cursor = page.nextCursor;
    if (cursor) { expect(releaseCursors.has(cursor)).toBe(false); releaseCursors.add(cursor); }
    expect(releases.length).toBeLessThanOrEqual(book.releases.length);
  } while (cursor);
  expect(releases.map(item => item.id).sort()).toEqual(book.releases.map(item => item.id).sort());
  for (const source of book.releases) {
    const release = await read<ReleaseView>(`${workPath}/releases/${short(source.id)}`);
    expect(release).toMatchObject({ id: source.id, revision: source.revision, platform: source.platform });
    expect(release.coverage).toContainEqual(expect.objectContaining({ work: book.work, realization: source.realization,
      revision: source.realizationRevision, language: source.language }));
  }

  // Walk the actual contents hierarchy; a group heading does not count as a readable chapter.
  const chapters: string[] = [];
  const walk = async (parent?: string, depth = 0): Promise<void> => {
    expect(depth).toBeLessThan(16);
    let next: string | null = null;
    const cursors = new Set<string>();
    do {
      const query = new URLSearchParams({ language: book.language, limit: '1' });
      if (parent) query.set('parent', parent);
      if (next) query.set('cursor', next);
      const page = await read<Static<typeof contentsPage>>(`${workPath}/contents?${query}`);
      expect(page).toMatchObject({ work: book.work, composition: book.composition,
        compositionRevision: book.compositionRevision });
      for (const item of page.items) {
        if (item.role === 'group') await walk(item.occurrence, depth + 1);
        else if (item.role === 'chapter') {
          const source = book.chapters.find(chapter => chapter.occurrence === item.occurrence)!;
          expect(source).toBeDefined();
          expect(item).toMatchObject({ availability: 'available', target: source.target,
            selectedRevision: source.selectedRevision });
          chapters.push(item.occurrence);
        }
      }
      next = page.nextCursor;
      if (next) { expect(cursors.has(next)).toBe(false); cursors.add(next); }
    } while (next);
  };
  await walk();
  expect(chapters).toEqual(book.chapters.map(item => item.occurrence));
  for (const [index, source] of book.chapters.entries()) {
    const chapter = await read<Static<typeof chapterRead>>(`/v1/chapters/${short(source.occurrence)}?language=${book.language}`);
    expect(chapter).toMatchObject({ work: book.work, composition: book.composition,
      compositionRevision: book.compositionRevision, occurrence: source.occurrence,
      parent: source.parent, selectedRevision: source.selectedRevision,
      previous: book.chapters[index - 1]?.occurrence ?? null, next: book.chapters[index + 1]?.occurrence ?? null });
    const exact = await read<Static<typeof exactContentRevision>>(`/v1/content-revisions/${short(source.selectedRevision)}`);
    expect(exact).toEqual(chapter.content);
    expect(contentRevisionUrn(exact.reference, source.target)).toBe(source.selectedRevision);
    expect(createHash('sha256').update(exact.serializedJson).digest('hex')).toBe(exact.reference.byteDigest);
    expect(normalize(contentText(exact.body))).toContain(normalize(source.bodyText));
  }

  const chosen = book.releases[0]!, preferencePath = `/v1/me/edition-preferences/${short(book.work)}`;
  const source = book.chapters[0]!;
  const progressPath = `/v1/compositions/${short(book.composition)}/occurrences/${short(source.occurrence)}/progress`;
  const other = name === 'owner' ? people.stranger : people.owner;
  const actingSubject = person.actingSubject ?? other.actingSubject;
  const choice = { language: chosen.language,
    edition: { kind: 'release', resource: chosen.id, revision: chosen.revision } };
  if (name === 'visitor') {
    await answer(person.main('PUT', preferencePath, { actingSubject, expectedVersion: 0, ...choice }), 401);
    await answer(person.main('PUT', progressPath, { actingSubject, expectedVersion: 0,
      selectedRevision: source.selectedRevision, completed: true, position: null }), 401);
    return;
  }
  const previous = await read<EditionPreference | null>(preferencePath);
  const key = randomUUID(), body = { actingSubject, expectedVersion: previous?.version ?? 0, ...choice };
  const saved = await answer<EditionPreference>(person.main('PUT', preferencePath, body, key));
  expect(saved).toMatchObject({ work: book.work, ...choice, version: body.expectedVersion + 1 });
  expect(await answer(person.main('PUT', preferencePath, body, key))).toMatchObject({ ...saved, replayed: true });
  await answer(person.main('PUT', preferencePath, body), 409);
  const persistedChoice = { work: book.work, ...choice, version: saved.version };
  expect(await read(preferencePath)).toEqual(persistedChoice);

  const current = await read<{ version: number }>(`${progressPath}?selectedRevision=${encodeURIComponent(source.selectedRevision)}`);
  const progressBody = { actingSubject, expectedVersion: current.version,
    selectedRevision: source.selectedRevision, completed: true, position: 'retained chapter paragraph 2' };
  const progressKey = randomUUID();
  const progress = await answer<{ version: number }>(person.main('PUT', progressPath, progressBody, progressKey));
  expect(await answer(person.main('PUT', progressPath, progressBody, progressKey))).toMatchObject({ ...progress, replayed: true });
  await answer(person.main('PUT', progressPath, { ...progressBody, completed: false }), 409);
  expect(await read(`${progressPath}?selectedRevision=${encodeURIComponent(source.selectedRevision)}`))
    .toMatchObject({ occurrence: source.occurrence, selectedRevision: source.selectedRevision,
      completed: true, position: progressBody.position, version: progress.version });
  expect(await read(`${workPath}/reader-state`)).toMatchObject({ work: book.work,
    progress: { structure: book.composition, occurrence: source.occurrence,
      selectedRevision: source.selectedRevision, position: progressBody.position } });
  expect(await read(`/v1/reading-positions/${short(book.work)}?position=mine&limit=1`))
    .toMatchObject({ work: book.work, resolved: source.occurrence });
  expect(await read(`/v1/me/progress-summaries/${short(book.work)}?language=${chosen.language}`))
    .toMatchObject({ resource: book.work, preference: persistedChoice });
  const returned = await read<Static<typeof chapterRead>>(`/v1/chapters/${short(source.occurrence)}`);
  expect(returned.selectedRevision).toBe(source.selectedRevision);
  expect(normalize(contentText(returned.content.body))).toContain(normalize(source.bodyText));
  for (const path of [preferencePath, progressPath, `${workPath}/reader-state`,
    `/v1/me/progress-summaries/${short(book.work)}`]) {
    await answer(person.main('GET', `${path}?${new URLSearchParams({ actingSubject: other.actingSubject! })}`), 403);
  }
  await answer(person.main('PUT', preferencePath, { ...body, actingSubject: other.actingSubject }), 403);
  await answer(person.main('PUT', progressPath, { ...progressBody, actingSubject: other.actingSubject }), 403);
});
