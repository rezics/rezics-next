import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

test('anonymous profile readers cannot read retired attribution as current credit', async () => {
  const stack = await startMediaStack('review-credit-retirement', { profileCredits: true });
  try {
    const editor = await stack.member('credit editor');
    const contributor = await stack.member('incorrectly credited contributor');
    const created = await stack.publicWork(editor.actor);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    const workPath = `/v1/works/${created.work.slice(-36)}`;
    const header = await json<{ revision: string }>(await stack.call('GET', workPath));
    const credit = `https://rezics.com/id/${randomUUID()}`;
    const written = await json<{ revision: string }>(await editor.send('POST', `${workPath}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit, agent: contributor.actor,
      role: 'author', expectedWorkHead: header.revision, actingSubject: editor.actor,
    }), 201);
    const profilePath = `/v1/agents/${contributor.actor.slice(-36)}/works`;
    type Page = { items: Array<{ id: string; attribution: Array<{ credit: string }> }> };
    const before = await json<Page>(await stack.call('GET', profilePath));
    expect(before.items.flatMap(item => item.attribution).map(item => item.credit)).toContain(credit);
    await json(await editor.send('POST', `${workPath}/author-credits/${credit.slice(-36)}/retirements`, {
      profile: 'work-author-credit-retirement-v1', revision: written.revision,
      expectedHead: header.revision, actingSubject: editor.actor, reason: 'Incorrect attribution',
    }), 201);
    const credits = await json<{ items: Array<{ id: string }> }>(await stack.call('GET', `${workPath}/agent-credits`));
    expect(credits.items.map(item => item.id)).not.toContain(credit);
    const after = await json<Page>(await stack.call('GET', profilePath));
    expect(after.items.flatMap(item => item.attribution).map(item => item.credit)).not.toContain(credit);
  } finally {
    await stack.stop();
  }
}, 180_000);
