import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { emptyRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { png, sha } from './media-support.ts';

setDefaultTimeout(120_000);
const short = (id: string) => id.slice(-36);
const query = (agent: string) => new URLSearchParams({ actingSubject: agent });
async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
type Page = { nextCursor: string | null };
type Fixture = {
  person: PersonaSession; agent: string; secret: string; collection: string; revision: string;
  shelvesCursor: string; statusCursor: string; progressCursor: string; followsCursor: string;
  snapshot: string; exportCursor: string; file: string; copyCursor: string; loanCursor: string;
  representation: string; asset: string; etag: string;
};
let people: PersonaSessions, works: Array<{ work: string; mainVersion: string }>;
let structure: string, occurrences: string[], release: string;
const fixtures: Fixture[] = [];

beforeAll(async () => {
  people = await personaSessions();
  works = [];
  for (let index = 0; index < 2; index++) {
    const person = people.owner, actingSubject = person.actingSubject!;
    const work = await json<{ work: string; mainVersion: string }>(person.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', actingSubject,
      title: `Disclosure public volume ${index} ${randomUUID()}`, language: 'en', semanticTypes: ['https://schema.org/Book'],
    }), 201);
    const draft = await json<{ contribution: string; draftRevision: string }>(person.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', actingSubject, work: work.work, language: 'en', body: 'An original disclosure audit fixture.',
    }), 201);
    const publication = await json<{ publicationDecision: string }>(person.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', actingSubject, contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
    }), 201);
    await json(person.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', actingSubject, context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer',
    }), 201);
    works.push(work);
  }
  const composition = await json<{ structure: string; revision: string }>(people.owner.main('POST', '/v1/compositions', {
    profile: 'book-composition', actingSubject: people.owner.actingSubject, work: works[0]!.work, mainVersion: works[0]!.mainVersion,
  }), 201);
  structure = composition.structure;
  occurrences = (await json<{ occurrences: string[] }>(people.owner.main('POST', `/v1/compositions/${short(structure)}/changes`, {
    profile: 'book-composition', actingSubject: people.owner.actingSubject, expectedHead: composition.revision,
    operations: [1, 2, 3].map(number => ({ op: 'insert', parent: structure, position: 'last', role: 'chapter',
      target: 'https://schema.org/DigitalDocument', label: { value: `Chapter ${number}`, language: 'en' } })),
  }))).occurrences;
  release = `https://rezics.com/id/${randomUUID()}`;
  await json(people.owner.main('PUT', `/v1/works/${short(works[0]!.work)}/releases/${short(release)}`, {
    profile: 'release-v1', actingSubject: people.owner.actingSubject, expectedHead: null, id: release, kind: 'formal', status: 'official',
    contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
    title: { value: 'Disclosure paperback', language: 'en' }, editionStatement: null, publisher: null,
    publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
  }));
  // The Realm owner also attacks a different Person. No persona is a positive
  // controller disguised as an adversary, and staff receive no private bypass.
  for (const person of [people.owner, people.member]) {
    const agent = person.actingSubject!, secret = `private-disclosure-${randomUUID()}`;
    const own = { actingSubject: agent }, q = query(agent);
    const profile = await json<{ revision: string }>(person.main('GET', `/v1/agents/${short(agent)}?${q}`));
    await json(person.main('PUT', `/v1/agents/${short(agent)}/profile`, { profile: 'agent-public-profile-v1',
      expectedHead: profile.revision, displayName: secret, bio: { text: secret, language: 'en' }, avatarSelection: null }), 201);
    let shelf: { collection: string; revision: string } | undefined;
    for (let index = 0; index < 2; index++) {
      shelf = await json(person.main('POST', '/v1/collections', { ...own, collection: `https://rezics.com/id/${randomUUID()}`,
        name: `${secret} shelf ${index}`, language: 'en', disclosure: 'private' }), 201);
    }
    for (const work of works) {
      await json(person.main('PUT', `/v1/works/${short(work.work)}/reader-status`, { ...own, expectedVersion: 0, status: 'reading' }));
      const follow = await json<{ revision: string | null }>(person.main('GET', `/v1/follows/${short(work.work)}?${q}`));
      await json(person.main('POST', '/v1/follows', { ...own, profile: 'follow-command-v1', target: work.work,
        kind: 'work', following: true, expectedRevision: follow.revision }));
    }
    for (const [index, occurrence] of occurrences.entries()) {
      await json(person.main('PUT', `/v1/compositions/${short(structure)}/occurrences/${short(occurrence)}/progress`, {
        ...own, expectedVersion: 0, completed: index < 2, position: secret,
      }));
    }
    // A second device's stale version must not disclose a different reader's
    // conflict state; the owner confirms the current bookmark remains version 1.
    expect((await person.main('PUT', `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[2]!)}/progress`, {
      ...own, expectedVersion: 0, completed: false, position: `${secret} stale`,
    })).status).toBe(409);
    await json(person.main('PUT', '/v1/me/reading-goal', { ...own, expectedVersion: 0, year: 2026, target: 37 }));
    await json(person.main('PUT', '/v1/me/person-preferences', { ...own, expectedVersion: 0,
      profileVisibility: 'private', followPolicy: 'nobody', hideReadingActivity: true,
      contentLanguages: ['ja'], spoilerPolicy: 'show' }));
    const file = await json<{ id: string }>(person.main('POST', '/v1/me/library-imports', { ...own, format: 'rezics',
      file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: [0, 1].map(index => emptyRow(String(index), secret, { secret })) }) }), 201);
    for (let index = 0; index < 2; index++) {
      const copy = await json<{ id: string }>(person.main('POST', '/v1/me/library-copies', { ...own, release,
        expectedVersion: 0, format: secret, acquiredFrom: { kind: 'name', name: secret } }), 201);
      await json(person.main('POST', '/v1/me/library-loans', { ...own, expectedVersion: 0, copy: copy.id,
        direction: 'lent', counterparty: { kind: 'name', name: secret },
        startedAt: '2026-01-01T00:00:00Z', dueAt: '2026-02-01T00:00:00Z' }), 201);
    }
    const bytes = png(73, 39);
    const upload = await json<{ asset: string; upload: string }>(person.main('POST', '/v1/media/uploads', {
      ...own, profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: bytes.length,
      sha256: sha(bytes), disclosure: 'private',
    }), 201);
    const activated = await json<{ representation: string }>(person.main('PUT', `/v1/media/uploads/${upload.upload}/bytes`,
      undefined, undefined, { bytes, headers: { 'content-type': 'image/png' } }), 201);
    await json(person.main('GET', `/v1/media/representations/${activated.representation}?${q}`));
    const download = await person.main('GET', `/v1/media/assets/${upload.asset}/bytes?${q}&target=${encodeURIComponent(works[0]!.work)}`);
    expect(download.status, await download.clone().text()).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get('etag')).toBe(`"${sha(bytes)}"`);
    const cursor = async (path: string) => {
      const page = await json<Page>(person.main('GET', `${path}${path.includes('?') ? '&' : '?'}${q}&limit=1`));
      expect(page.nextCursor, path).toBeString();
      return page.nextCursor!;
    };
    const exported = await json<Page & { snapshot: string }>(person.main('GET', `/v1/me/library-export?${q}&limit=1`));
    expect(exported.nextCursor).toBeString();
    fixtures.push({ person, agent, secret, collection: shelf!.collection, revision: shelf!.revision,
      shelvesCursor: await cursor('/v1/me/shelves'), statusCursor: await cursor('/v1/me/shelves/status/reading/works'),
      progressCursor: await cursor(`/v1/compositions/${short(structure)}/progress`), followsCursor: await cursor('/v1/me/follows'),
      copyCursor: await cursor(`/v1/works/${short(works[0]!.work)}/copies`), loanCursor: await cursor('/v1/me/library-loans'),
      snapshot: exported.snapshot, exportCursor: exported.nextCursor!, file: file.id,
      representation: activated.representation, asset: upload.asset, etag: `"${sha(bytes)}"` });
  }
}, 600_000);
afterAll(async () => { await people?.close(); });

for (const name of personaNames) {
  test(`${name}: another Person's private library, progress, preferences and continuation tokens`, async () => {
    const person = people[name], victim = fixtures[name === 'owner' ? 1 : 0]!;
    const q = query(victim.agent), work = short(works[0]!.work);
    const expected = name === 'visitor' ? 401 : 403;
    const paths = [
      `/v1/me/shelves?${q}`, `/v1/me/shelves?${q}&cursor=${victim.shelvesCursor}`,
      `/v1/me/shelves/status/reading/works?${q}&cursor=${victim.statusCursor}`,
      `/v1/me/reading-goal?${q}&year=2026`, `/v1/me/reading-stats?${q}&year=2026`,
      `/v1/compositions/${short(structure)}/progress?${q}&cursor=${victim.progressCursor}`,
      `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[2]!)}/progress?${q}`,
      `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[2]!)}/progress?${q}&selectedRevision=urn:rezics:content:revision:${randomUUID()}`,
      `/v1/works/${work}/progress?${q}`, `/v1/me/progress-summaries/${work}?${q}`,
      `/v1/me/sessions?${q}`, `/v1/me/edition-preferences/${work}?${q}`,
      `/v1/works/${work}/copies?${q}&cursor=${victim.copyCursor}`,
      `/v1/me/library-loans?${q}&cursor=${victim.loanCursor}`,
      `/v1/me/library-imports/${victim.file}/rows?${q}&cursor=0`, `/v1/me/library-imports/${victim.file}/apply?${q}`,
      `/v1/me/library-export?${q}`, `/v1/me/library-export?${q}&snapshot=${victim.snapshot}&cursor=${victim.exportCursor}`,
      `/v1/me/person-preferences?${q}`, `/v1/me/feed-preferences?${q}`, `/v1/me/mutes?${q}`,
      `/v1/me/follows?${q}&cursor=${victim.followsCursor}`, `/v1/me/follows?${q}&q=${victim.secret}`,
      `/v1/me/follows/authors?${q}`, `/v1/follows/${work}?${q}`,
      `/v1/agents/${short(victim.agent)}/library-visibility`, `/v1/agents/${short(victim.agent)}/listing`,
    ];
    for (const path of paths) {
      const response = await person.main('GET', path, undefined, randomUUID(), { headers: { 'if-none-match': victim.etag } });
      const raw = await response.text();
      expect(response.status, `${path}: ${raw}`).toBe(name === 'visitor' && path.startsWith('/v1/follows/') ? 400 : expected);
      expect(raw, path).not.toContain(victim.secret);
      expect(response.headers.get('etag'), path).toBeNull();
    }
    for (const path of [`/v1/works/${work}/reader-state?${q}`, `/v1/me/work-states?${q}&works=${encodeURIComponent(works[0]!.work)}`]) {
      const response = await person.main('GET', path);
      const raw = await response.text();
      expect(response.status, raw).toBe(name === 'visitor' ? 200 : 403);
      expect(raw).not.toContain(victim.secret);
      if (name === 'visitor') expect(raw).toContain('"status":null');
    }
    // Even replacing the victim's Person with one's own cannot transfer a token.
    if (person.actingSubject) for (const path of [
      `/v1/me/library-export?${query(person.actingSubject)}&snapshot=${victim.snapshot}&cursor=${victim.exportCursor}`,
      `/v1/me/follows?${query(person.actingSubject)}&cursor=${victim.followsCursor}`,
    ]) {
      const response = await person.main('GET', path), raw = await response.text();
      expect(response.status, raw).toBe(400);
      expect(raw).not.toContain(victim.secret);
    }
  });

  test(`${name}: private shelves, profile, media and cache validators cannot be disclosed through public reads`, async () => {
    const person = people[name], victim = fixtures[name === 'owner' ? 1 : 0]!;
    const actor = person.actingSubject ? `?${query(person.actingSubject)}` : '';
    for (const path of [
      `/v1/collections/${short(victim.collection)}${actor}`,
      `/v1/collections/${short(victim.collection)}/revisions/${short(victim.revision)}${actor}`,
      `/v1/agents/${short(victim.agent)}${actor}`,
      `/v1/agents/${short(victim.agent)}/shelves${actor}`,
      `/v1/agents/${short(victim.agent)}/shelves/status/reading/works${actor}`,
      `/v1/media/representations/${victim.representation}${actor}`,
      `/v1/media/representations/${victim.representation}/bytes${actor}`,
    ]) {
      const response = await person.main('GET', path, undefined, undefined, { headers: { 'if-none-match': victim.etag } });
      const raw = await response.text();
      expect(response.status, `${path}: ${raw}`).toBe(404);
      expect(raw).not.toContain(victim.secret);
      expect(response.headers.get('etag')).toBeNull();
    }
    const catalogue = await json<{ results: unknown[]; count: { value: number } }>(
      person.main('GET', `/v1/search/catalogue?q=${victim.secret}`));
    expect(catalogue.results).toEqual([]);
    expect(catalogue.count.value).toBe(0);
    const typeahead = await json<{ items: unknown[]; hasMore: boolean }>(
      person.main('GET', `/v1/search/typeahead?prefix=${victim.secret}`));
    expect(typeahead.items).toEqual([]);
    expect(typeahead.hasMore).toBe(false);
    const anonymousFollow = await json<{ following: boolean | null; revision: string | null }>(
      people.visitor.main('GET', `/v1/follows/${short(works[0]!.work)}`));
    expect(anonymousFollow).toMatchObject({ following: null, revision: null });
  });

  test(`${name}: Account identity and notification payloads stay in the caller's partition`, async () => {
    const person = people[name], victim = fixtures[name === 'owner' ? 1 : 0]!;
    const response = await person.account('GET', `/api/auth/get-session?userId=${victim.person.accountId}`,
      undefined, undefined, { headers: { 'if-none-match': victim.etag } });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(raw).not.toContain(victim.person.accountId!);
    if (person.accountId) expect(JSON.parse(raw)).toMatchObject({ user: { id: person.accountId } });
    else expect(JSON.parse(raw)).toBeNull();
    for (const path of ['/v1/me/notifications?before=latest&limit=1', '/v1/me/notifications/unread-count', '/v1/me/notifications/hint', '/v1/me/notification-preferences']) {
      const notification = await person.main('GET', path), body = await notification.text();
      expect(notification.status, body).toBe(name === 'visitor' ? 401 : 200);
      expect(body).not.toContain(victim.secret);
      expect(notification.headers.get('etag')).toBeNull();
    }
    const first = await json<{ next: string | null }>(victim.person.main('GET', '/v1/me/notifications?before=latest&limit=1'));
    if (first.next) {
      const copied = await person.main('GET', `/v1/me/notifications?before=${encodeURIComponent(first.next)}&limit=1`);
      expect(copied.status, await copied.text()).toBe(name === 'visitor' ? 401 : 400);
    }
  });
}
