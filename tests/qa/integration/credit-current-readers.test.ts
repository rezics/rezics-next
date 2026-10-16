import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const native = () => `https://rezics.com/id/${randomUUID()}`;
type WorkCard = { id: string; authors: Array<{ agent?: string; key?: string }> };
type AuthorPage = { works: { items: WorkCard[] } };
type FollowedAuthors = { items: Array<{ id: string; available: boolean; newestWork: { id: string } | null }> };

test('retiring attribution withdraws it from author pages, followed authors and name searches', async () => {
  const stack = await startMediaStack('credit-current-readers', { profileCredits: true });
  try {
    const editor = await stack.member('current-credit-editor');
    const unique = randomUUID().slice(0, 8);
    const contributor = await stack.member(`Creditedname${unique}`);
    const reader = await stack.member('current-credit-reader', { verified: true });
    const { agent: readerAgent } = await json<{ agent: string }>(await reader.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Following reader',
    }), 201);
    const created = await stack.publicWork(editor.actor, ['en'], `Livingtitle${unique}`);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    const workPath = `/v1/works/${created.work.slice(-36)}`;
    const { revision: head } = await json<{ revision: string }>(await stack.call('GET', workPath));
    const credit = native();
    const written = await json<{ revision: string }>(await editor.send('POST', `${workPath}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit, agent: contributor.actor,
      role: 'author', expectedWorkHead: head, actingSubject: editor.actor,
    }), 201);
    const base = 1 + Number.parseInt(unique, 16);
    const authors = [`OL${base}A`, `OL${base + 1}A`];
    const external = [];
    for (const [ordinal, author] of authors.entries()) {
      const id = native();
      const { revision } = await json<{ revision: string }>(await editor.send('POST', `${workPath}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit: id,
        participant: { kind: 'external-reference', provider: 'open-library', namespace: 'author', key: `/authors/${author}` },
        role: 'author', ordinal, expectedWorkHead: head, actingSubject: editor.actor,
      }), 201);
      external.push({ id, revision });
    }
    const externalTarget = `open-library:${authors[0]}`;
    for (const [target, kind] of [[contributor.actor, 'agent'], [externalTarget, 'external-author']]) {
      await json(await reader.send('POST', '/v1/follows', { profile: 'follow-command-v1',
        target, kind, following: true, expectedRevision: null, actingSubject: readerAgent }));
    }
    const readFollowed = () => reader.send('GET', `/v1/me/follows/authors?actingSubject=${encodeURIComponent(readerAgent)}`)
      .then(response => json<FollowedAuthors>(response));
    const readPage = (author: string) => stack.call('GET', `/v1/authors/open-library/${author}`)
      .then(response => json<AuthorPage>(response));
    const searchName = () => stack.call('POST', '/v1/queries', { body: {
      profile: 'public-main-phrase-v1', phrase: contributor.name, language: null,
    } })
      .then(response => json<{ results: Array<{ work: string }> }>(response));
    const suggestName = () => stack.call('GET', `/v1/search/typeahead?prefix=${contributor.name}`)
      .then(response => json<{ items: Array<{ work: string }> }>(response));
    expect((await readPage(authors[0]!)).works.items[0]!.authors.map(item => item.agent)).toContain(contributor.actor);
    expect((await readFollowed()).items.map(item => item.newestWork?.id)).toEqual([created.work, created.work]);
    expect((await searchName()).results.map(item => item.work)).toContain(created.work);
    expect((await suggestName()).items.map(item => item.work)).toContain(created.work);

    const retire = async (id: string, revision: string) => json(await editor.send('POST',
      `${workPath}/author-credits/${id.slice(-36)}/retirements`, {
        profile: 'work-author-credit-retirement-v1', revision, expectedHead: head,
        actingSubject: editor.actor, reason: 'Incorrect attribution',
      }), 201);
    await retire(credit, written.revision);
    expect((await readPage(authors[0]!)).works.items[0]!.authors.map(item => item.agent)).not.toContain(contributor.actor);
    expect((await readFollowed()).items.find(item => item.id === contributor.actor)?.newestWork).toBeNull();
    expect((await searchName()).results.map(item => item.work)).not.toContain(created.work);
    expect((await suggestName()).items.map(item => item.work)).not.toContain(created.work);

    await retire(external[0]!.id, external[0]!.revision);
    for (const suffix of ['', '/works', '/follow']) {
      expect((await stack.call('GET', `/v1/authors/open-library/${authors[0]}${suffix}`)).status).toBe(404);
    }
    expect((await readFollowed()).items.find(item => item.id === externalTarget))
      .toMatchObject({ available: false, newestWork: null });
    const retained = await readPage(authors[1]!);
    expect(retained.works.items.map(item => item.id)).toEqual([created.work]);
    expect(retained.works.items[0]!.authors).toMatchObject([{ key: `/authors/${authors[1]}` }]);
  } finally { await stack.stop(); }
}, 180_000);
