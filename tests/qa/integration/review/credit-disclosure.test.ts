import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

test('anonymous credit readers cannot disclose a private translator', async () => {
  const stack = await startMediaStack('review-credit-disclosure', { profileCredits: true });
  try {
    const editor = await stack.member('catalogue editor');
    const translator = await stack.member('translator controller', { verified: true });
    const person = await json<{ agent: string }>(await translator.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Private translator',
    }), 201);
    const created = await stack.publicWork(editor.actor);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    const workPath = `/v1/works/${created.work.slice(-36)}`;
    const header = await json<{ revision: string }>(await stack.call('GET', workPath));
    const credit = `https://rezics.com/id/${randomUUID()}`;
    await json(await editor.send('POST', `${workPath}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit, agent: person.agent,
      role: 'translator', expectedWorkHead: header.revision, actingSubject: editor.actor,
    }), 201);
    type Credits = { items: Array<{ id: string; agent: string | null }> };
    const before = await json<Credits>(await stack.call('GET', `${workPath}/credits`));
    expect(before.items.map(item => item.agent)).toContain(person.agent);
    const preferences = await json<{
      version: number; followPolicy: 'everyone' | 'nobody'; hideReadingActivity: boolean;
      contentLanguages: string[]; spoilerPolicy: 'hide-unread' | 'show';
    }>(await translator.send('GET', `/v1/me/person-preferences?actingSubject=${encodeURIComponent(person.agent)}`));
    await json(await translator.send('PUT', '/v1/me/person-preferences', {
      actingSubject: person.agent, expectedVersion: preferences.version, profileVisibility: 'private',
      followPolicy: preferences.followPolicy, hideReadingActivity: preferences.hideReadingActivity,
      contentLanguages: preferences.contentLanguages, spoilerPolicy: preferences.spoilerPolicy,
    }));
    expect((await stack.call('GET', `/v1/agents/${person.agent.slice(-36)}`)).status).toBe(404);
    const native = await json<Credits>(await stack.call('GET', `${workPath}/agent-credits`));
    expect(native.items.map(item => item.agent)).not.toContain(person.agent);
    const publicCredits = await json<Credits>(await stack.call('GET', `${workPath}/credits`));
    expect(publicCredits.items.map(item => item.agent)).not.toContain(person.agent);
  } finally {
    await stack.stop();
  }
}, 180_000);
