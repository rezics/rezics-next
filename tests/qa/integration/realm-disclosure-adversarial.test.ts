import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaNames, personaSessions, type PersonaSession, type PersonaSessions } from '../support/personas.ts';
import { closeRealm, closureCommand, closureOriginal, closureReply, closureRole } from './outcomes/realm/closure-fixture.ts';

setDefaultTimeout(180_000);
const short = (id: string) => id.slice(-36);
const absent = `https://rezics.com/id/${randomUUID()}`;
let sessions: PersonaSessions;
let original: Awaited<ReturnType<typeof closureOriginal>>;
let reply: Awaited<ReturnType<typeof closureReply>>;
let hidden: { work: string; mainVersion: string; mainRevision: string };
let closed: PersonaSessions;
let closedReply: Awaited<ReturnType<typeof closureReply>>;
let rosterCursor: string;
let threadCursor: string;
const hiddenTitle = `Unpublishedprovenance${randomUUID().replaceAll('-', '')}`;

beforeAll(async () => {
  sessions = await personaSessions('private');
  original = await closureOriginal(sessions.owner, `Independent disclosure control ${randomUUID()}`);
  await closureRole(sessions, sessions.moderator, ['review.decide', 'publication.adopt']);
  reply = await closureReply(sessions, original, 'Private Realm discussion must stay within its audience.');
  hidden = await closureCommand(sessions.owner, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', title: hiddenTitle,
    language: 'en', authoring: 'own-work', actingSubject: sessions.owner.actingSubject,
  }, 201);
  closed = await personaSessions('public');
  await closureRole(closed, closed.moderator, ['review.decide', 'publication.adopt']);
  for (const person of [closed.member, closed.moderator]) {
    await closureCommand(person, 'PUT', `/v1/realms/${short(closed.realm)}/roster/listing`, {
      actingSubject: person.actingSubject, expectedMembershipGeneration: '1', listed: true,
    });
  }
  closedReply = await closureReply(closed, original, 'A public discussion before closure.');
  await closureReply(closed, original, 'Another public discussion before closure.');
  const root = `/v1/realms/${short(closed.realm)}`;
  const roster = await closureCommand<{ nextCursor: string | null }>(closed.visitor, 'GET', `${root}/roster?limit=1`);
  const threads = await closureCommand<{ nextCursor: string | null }>(closed.visitor, 'GET', `${root}/threads?sort=new&limit=1`);
  expect(roster.nextCursor).not.toBeNull();
  expect(threads.nextCursor).not.toBeNull();
  rosterCursor = roster.nextCursor!;
  threadCursor = threads.nextCursor!;
  expect(await closeRealm(closed)).toBeNull();
});
afterAll(async () => { await sessions?.close(); });

async function concealed(person: PersonaSession, path: string, missing: string) {
  for (const headers of [{}, { 'if-none-match': '*' }, { 'if-modified-since': new Date().toUTCString() }]) {
    const response = await person.main('GET', path, undefined, undefined, { headers });
    const ordinary = await person.main('GET', missing, undefined, undefined, { headers });
    const body = await response.text();
    expect(response.status, `${path}: ${body}`).toBe(ordinary.status);
    expect([403, 404], path).toContain(response.status);
    expect(body, path).toBe(await ordinary.text());
    expect(response.headers.get('etag'), path).toBeNull();
  }
}

for (const name of personaNames) {
  test(`${name}: private Realm direct IDs, counts, threads, modules and public roster preserve the audience`, async () => {
    const person = sessions[name];
    const root = `/v1/realms/${short(sessions.realm)}`;
    const missing = `/v1/realms/${short(absent)}`;
    const actor = person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const admitted = ['member', 'owner', 'moderator'].includes(name);
    for (const suffix of ['', '/works', '/threads?sort=new', `/threads/${short(reply.reply)}`,
      `/about-thread?about=${encodeURIComponent(original.work)}`]) {
      const path = `${root}${suffix}${suffix.includes('?') ? '&' : '?'}${actor}`;
      if (admitted) {
        const response = await person.main('GET', path);
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
      } else {
        await concealed(person, path, `${missing}${suffix}${suffix.includes('?') ? '&' : '?'}${actor}`);
      }
    }
    // These are public inventories even when the bearer belongs to a member.
    for (const suffix of ['/roster', '/roster?featured=true', '/roster?limit=1', '/rankings',
      '/modules/discussions', '/modules/new-adoptions', '/modules/rising']) {
      await concealed(person, root + suffix, missing + suffix);
    }
    const search = `/v1/search/catalogue?q=Private&realm=${encodeURIComponent(sessions.realm)}`;
    await concealed(person, search, search.replace(encodeURIComponent(sessions.realm), encodeURIComponent(absent)));
    if (!admitted && person.actingSubject) {
      for (const suffix of [`/members?${actor}`, `/members?${actor}&search=Fixture`, `/roles?${actor}`]) {
        await concealed(person, root + suffix, missing + suffix);
      }
    }
    const control = await person.main('GET', `/v1/works/${short(original.work)}?${actor}`);
    expect(control.status, await control.clone().text()).toBe(200);
    const header = await control.json() as { mainVersionRevision: string };
    for (const surface of ['translation-links', 'work-derivations']) {
      const response = await person.main('GET', `/v1/main-versions/${short(original.mainVersion)}/revisions/${short(header.mainVersionRevision)}/${surface}`);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ complete: true, [surface === 'translation-links' ? 'links' : 'derivations']: [] });
    }
  });

  test(`${name}: closure revokes direct IDs, counts and pre-closure continuations before cache validation`, async () => {
    const person = closed[name];
    const actor = person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    const root = `/v1/realms/${short(closed.realm)}`;
    const missing = `/v1/realms/${short(absent)}`;
    for (const suffix of ['', '/works', '/decisions', '/zone', '/join-page',
      '/threads?sort=new', `/threads?sort=new&limit=1&cursor=${encodeURIComponent(threadCursor)}`,
      `/threads/${short(closedReply.reply)}`, `/about-thread?about=${encodeURIComponent(original.work)}`]) {
      await concealed(person, `${root}${suffix}${suffix.includes('?') ? '&' : '?'}${actor}`,
        `${missing}${suffix}${suffix.includes('?') ? '&' : '?'}${actor}`);
    }
    for (const suffix of ['/roster', `/roster?limit=1&after=${encodeURIComponent(rosterCursor)}`,
      '/roster?featured=true', '/rankings', '/modules/rising', '/modules/discussions', '/modules/new-adoptions']) {
      await concealed(person, root + suffix, missing + suffix);
    }
    if (person.actingSubject) for (const suffix of [`/members?${actor}`, `/roles?${actor}`]) {
      await concealed(person, root + suffix, missing + suffix);
    }
    const search = `/v1/search/catalogue?q=discussion&realm=${encodeURIComponent(closed.realm)}`;
    await concealed(person, search, search.replace(encodeURIComponent(closed.realm), encodeURIComponent(absent)));
  });

  test(`${name}: search, typeahead, directory and profile contributions omit private occurrences`, async () => {
    const person = sessions[name];
    const actor = person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
    for (const path of [`/v1/search/typeahead?prefix=${hiddenTitle}`,
      `/v1/search/catalogue?q=${hiddenTitle}`, '/v1/realms?q=Outcome',
      `/v1/agents/${short(sessions.member.actingSubject!)}/realm-contributions?kind=posts&${actor}`]) {
      const response = await person.main('GET', path);
      const bytes = await response.text();
      expect(response.status, `${path}: ${bytes}`).toBe(200);
      expect(bytes, path).not.toContain(hidden.work);
      // A profile contribution read uses this caller's live Realm membership;
      // directory and search remain public inventories for every caller.
      if (path.includes('/realm-contributions') && ['member', 'owner', 'moderator'].includes(name)) {
        expect(bytes, path).toContain(sessions.realm);
        expect(bytes, path).toContain(reply.reply);
      } else {
        expect(bytes, path).not.toContain(sessions.realm);
        expect(bytes, path).not.toContain(reply.reply);
      }
    }
  });

  test(`${name}: a public Work never authorizes another person's exact contribution draft`, async () => {
    const person = sessions[name];
    const actor = person.actingSubject ?? sessions.stranger.actingSubject!;
    const query = `actingSubject=${encodeURIComponent(actor)}`;
    const path = `/v1/contributions/${short(original.contribution)}/drafts/${short(original.draftRevision)}?${query}`;
    for (const headers of [{}, { 'if-none-match': '*' }]) {
      const response = await person.main('GET', path, undefined, undefined, { headers });
      const bytes = await response.text();
      expect(response.status, `${path}: ${bytes}`).toBe(name === 'visitor' ? 401 : name === 'owner' ? 200 : 404);
      if (name !== 'owner') {
        const missing = await person.main('GET', `/v1/contributions/${short(absent)}/drafts/${randomUUID()}?${query}`,
          undefined, undefined, { headers });
        expect(response.status).toBe(missing.status);
        expect(bytes).toBe(await missing.text());
      }
    }
  });

  for (const surface of ['translation-links', 'work-derivations']) test(`${name}: ${surface} cannot disclose an unpublished revision or validate its existence`, async () => {
    const person = sessions[name];
    await concealed(person,
      `/v1/main-versions/${short(hidden.mainVersion)}/revisions/${short(hidden.mainRevision)}/${surface}`,
      `/v1/main-versions/${short(absent)}/revisions/${randomUUID()}/${surface}`);
  });
}
