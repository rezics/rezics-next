import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('anonymous author-page readers cannot read retired native attribution', async () => {
  const stack = await startMediaStack('review-retired-author-readers', { profileCredits: true });
  try {
    const editor = await stack.member('catalogue editor');
    const contributor = await stack.member('incorrectly credited contributor');
    const created = await stack.publicWork(editor.actor);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    const workPath = `/v1/works/${created.work.slice(-36)}`;
    const { revision: head } = await json<{ revision: string }>(await stack.call('GET', workPath));
    const credit = native();
    const written = await json<{ revision: string }>(await editor.send('POST', `${workPath}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit, agent: contributor.actor,
      role: 'author', expectedWorkHead: head, actingSubject: editor.actor,
    }), 201);
    const author = `OL${1 + Number.parseInt(randomUUID().slice(0, 8), 16)}A`;
    await json(await editor.send('POST', `${workPath}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: native(),
      participant: { kind: 'external-reference', provider: 'open-library', namespace: 'author', key: `/authors/${author}` },
      role: 'author', ordinal: 0, expectedWorkHead: head, actingSubject: editor.actor,
    }), 201);
    type Page = { items: Array<{ id: string; authors: Array<{ agent?: string }> }> };
    const authorPath = `/v1/authors/open-library/${author}/works`;
    const before = await json<Page>(await stack.call('GET', authorPath));
    expect(before.items.find(item => item.id === created.work)?.authors.map(item => item.agent))
      .toContain(contributor.actor);
    await json(await editor.send('POST', `${workPath}/author-credits/${credit.slice(-36)}/retirements`, {
      profile: 'work-author-credit-retirement-v1', revision: written.revision,
      expectedHead: head, actingSubject: editor.actor, reason: 'Incorrect attribution',
    }), 201);
    const current = await json<{ items: Array<{ id: string }> }>(await stack.call('GET', `${workPath}/agent-credits`));
    expect(current.items.map(item => item.id)).not.toContain(credit);
    const after = await json<Page>(await stack.call('GET', authorPath));
    expect(after.items.find(item => item.id === created.work)?.authors.map(item => item.agent))
      .not.toContain(contributor.actor);
  } finally {
    await stack.stop();
  }
}, 180_000);
