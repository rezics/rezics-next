import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { NATIVE_CREDIT_ROLES } from '../../../services/main/src/modules/work/credit-roles.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

test('every native credit role follows attribution privacy and retirement on public readers', async () => {
  const stack = await startMediaStack('credit-attribution-visibility', { profileCredits: true });
  try {
    const editor = await stack.member('credit editor');
    const controller = await stack.member('contributor controller', { verified: true });
    const { agent } = await json<{ agent: string }>(await controller.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Contributor',
    }), 201);
    const created = await stack.publicWork(editor.actor);
    await editor.grant(`work:edit:${created.work}`, 'work.edit');
    const workPath = `/v1/works/${created.work.slice(-36)}`;
    const { revision: head } = await json<{ revision: string }>(await stack.call('GET', workPath));
    const written = [];
    for (const role of NATIVE_CREDIT_ROLES) {
      const credit = `https://rezics.com/id/${randomUUID()}`;
      const { revision } = await json<{ revision: string }>(await editor.send('POST', `${workPath}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit, agent, role,
        expectedWorkHead: head, actingSubject: editor.actor,
      }), 201);
      written.push({ credit, revision, role });
    }
    type Credits = { items: Array<{ id: string; agent: string | null }> };
    const readQuery = async () => (await json<{ result: Credits }>(await stack.call('POST', '/v1/query', { body: {
      profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
      parameters: { roots: [created.work] }, limit: 64,
    } }))).result;
    const expected = written.map(item => item.credit).sort();
    expect((await readQuery()).items.map(item => item.id).sort()).toEqual(expected);
    const preferencesPath = `/v1/me/person-preferences?actingSubject=${encodeURIComponent(agent)}`;
    const setVisibility = async (profileVisibility: 'public' | 'private') => {
      const preferences = await json<{
        version: number; followPolicy: 'everyone' | 'nobody'; hideReadingActivity: boolean;
        contentLanguages: string[]; spoilerPolicy: 'hide-unread' | 'show';
      }>(await controller.send('GET', preferencesPath));
      await json(await controller.send('PUT', '/v1/me/person-preferences', {
        actingSubject: agent, expectedVersion: preferences.version, profileVisibility,
        followPolicy: preferences.followPolicy, hideReadingActivity: preferences.hideReadingActivity,
        contentLanguages: preferences.contentLanguages, spoilerPolicy: preferences.spoilerPolicy,
      }));
    };
    await setVisibility('private');
    expect((await readQuery()).items).toEqual([]);
    for (const suffix of ['credits', 'agent-credits']) {
      expect((await json<Credits>(await stack.call('GET', `${workPath}/${suffix}`))).items).toEqual([]);
    }
    await setVisibility('public');
    expect((await readQuery()).items.map(item => item.id).sort()).toEqual(expected);
    const retired = written.find(item => item.role === 'translator')!;
    await json(await editor.send('POST', `${workPath}/author-credits/${retired.credit.slice(-36)}/retirements`, {
      profile: 'work-author-credit-retirement-v1', revision: retired.revision,
      expectedHead: head, actingSubject: editor.actor, reason: 'Incorrect attribution',
    }), 201);
    const retained = expected.filter(credit => credit !== retired.credit);
    expect((await readQuery()).items.map(item => item.id).sort()).toEqual(retained);
    const profile = await json<{ items: Array<{ id: string; attribution: Array<{ credit: string }> }> }>(
      await stack.call('GET', `/v1/agents/${agent.slice(-36)}/works?limit=1`));
    expect(profile.items.map(item => item.id)).toEqual([created.work]);
    expect(profile.items[0]!.attribution.map(item => item.credit).sort()).toEqual(retained);
  } finally { await stack.stop(); }
}, 180_000);
