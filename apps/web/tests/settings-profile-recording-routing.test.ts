import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadThreadPage } from '../src/threads/thread-page';
import { createRecordedKernelFetch, deletedOrganizationId, mentionThreadId } from '../src/kernel/fake';
import { answerFakeRoute } from '../src/kernel/fake-modules';
import { traversalSubjects } from '../src/kernel/fake/edition-work';
import accountsRecording from '../src/kernel/recorded/accounts.json';
import { storyViewerId } from '../src/kernel/fake/identities';

type StoryContext = { visitor: 'Signed In' | 'Signed Out'; url: string };
type StoryGlobal = typeof globalThis & { __rezicsStoryContext?: StoryContext };

const kernelUrl = 'https://kernel.test';

function story(url: string): void {
  (globalThis as StoryGlobal).__rezicsStoryContext = { visitor: 'Signed In', url };
}

function accountRequest(query: string): Request {
  return new Request(`${kernelUrl}/v1/accounts?${query}`);
}

test('Settings profile recording handles only its exact scene and single owned target while canonical public account batches and handle or agent selectors fall through unchanged', async () => {
  const runtime = globalThis as StoryGlobal;
  const previous = runtime.__rezicsStoryContext;
  const fetchRecorded = createRecordedKernelFetch({});
  const mira = accountsRecording.accounts[0]!;

  try {
    story('/en/settings?profile=extended');

    const ownedRead = accountRequest(`ids=${storyViewerId}`);
    expect(await answerFakeRoute('story', ownedRead)).toMatchObject({
      status: 200,
      accounts: [{ id: storyViewerId, handle: 'reader', displayName: 'Avery Reader' }],
    });
    const ownedResponse = await fetchRecorded(ownedRead);
    expect(await ownedResponse.json()).toMatchObject({
      accounts: [{ id: storyViewerId, handle: 'reader', displayName: 'Avery Reader' }],
      next: null,
    });

    const profileResponse = await fetchRecorded(new Request(`${kernelUrl}/v1/accounts/${storyViewerId}/profile`));
    expect(profileResponse.status).toBe(200);
    expect(await profileResponse.json()).toMatchObject({
      profile: { id: storyViewerId, handle: 'reader', displayName: 'Avery Reader' },
      editing: {
        viewer: { accountId: storyViewerId },
        target: { accountId: storyViewerId, kind: 'actor' },
      },
    });

    const commaBatch = accountRequest(`ids=${mira.id},${deletedOrganizationId}`);
    expect(await answerFakeRoute('story', commaBatch)).toBeUndefined();
    const batchResponse = await fetchRecorded(commaBatch);
    expect(await batchResponse.json()).toEqual({
      accounts: [mira, { id: deletedOrganizationId, kind: 'organization', state: 'deleted' }],
      next: null,
    });

    const unsupportedId = await answerFakeRoute('story', accountRequest('ids=other-settings-account'));
    expect(unsupportedId).toBeUndefined();
    expect(await (await fetchRecorded(accountRequest('ids=other-settings-account'))).json()).toEqual({
      accounts: [],
      next: null,
    });

    const unsupportedQuery = accountRequest(`ids=${storyViewerId}&limit=1`);
    expect(await answerFakeRoute('story', unsupportedQuery)).toBeUndefined();
    expect(await (await fetchRecorded(unsupportedQuery)).json()).toEqual({ accounts: [], next: null });

    const handleRequest = accountRequest('handle=mira');
    expect(await answerFakeRoute('story', handleRequest)).toBeUndefined();
    expect(await (await fetchRecorded(handleRequest)).json()).toEqual({ accounts: [mira], next: null });

    const agentSubject = Object.values(traversalSubjects)[0]!.id;
    const agentRequest = accountRequest(`agent=${agentSubject}`);
    expect(await answerFakeRoute('story', agentRequest)).toEqual({ status: 200, accounts: [], next: null });
    expect(await (await fetchRecorded(agentRequest)).json()).toEqual({ accounts: [], next: null });

    const requests: URL[] = [];
    const kernel = createKernelClient(kernelUrl, {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(new URL(request.url));
        return fetchRecorded(request);
      }) as typeof fetch,
    });
    const page = await loadThreadPage(
      kernel,
      new Request(`https://site.test/en/threads/${mentionThreadId}`),
      {},
      { id: mentionThreadId },
      { sitekey: '', scriptUrl: '' },
      'anonymous',
    );
    expect(page.mentions).toEqual({ [mira.id]: { handle: 'mira' } });
    const mentionLookup = requests.find((url) => url.pathname === '/v1/accounts');
    expect(mentionLookup?.searchParams.get('ids')).toContain(mira.id);
    expect(mentionLookup?.searchParams.get('ids')).toContain(deletedOrganizationId);

    story(`/en/threads/${mentionThreadId}/thread`);
    const unrelatedScene = accountRequest(`ids=${storyViewerId}`);
    expect(await answerFakeRoute('story', unrelatedScene)).toBeUndefined();
    expect(await (await fetchRecorded(unrelatedScene)).json()).toEqual({ accounts: [], next: null });

    story('/en/settings?profile=organization');
    const organizationProfile = await fetchRecorded(new Request(`${kernelUrl}/v1/accounts/${storyViewerId}/profile`));
    expect(organizationProfile.status).toBe(200);
    expect(await organizationProfile.json()).toMatchObject({
      profile: { id: storyViewerId, kind: 'organization', speakersListed: false },
      editing: { target: { accountId: storyViewerId, kind: 'organization' } },
    });

    for (const variant of ['self', 'handleless', 'readback', 'refused']) {
      story(`/en/settings?profile=${variant}`);
      const editable = await fetchRecorded(new Request(`${kernelUrl}/v1/accounts/${storyViewerId}/profile`));
      expect(editable.status).toBe(200);
      expect(await editable.json()).toMatchObject({
        profile: { id: storyViewerId },
        editing: { target: { accountId: storyViewerId } },
      });
      const saved = await fetchRecorded(
        new Request(`${kernelUrl}/v1/accounts/${storyViewerId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'idempotency-key': `profile-${variant}` },
          body: JSON.stringify({ displayName: 'Avery Updated' }),
        }),
      );
      expect(saved.status).toBe(variant === 'refused' ? 403 : 200);
      if (variant !== 'refused') expect(await saved.json()).toEqual({ accountId: storyViewerId });
    }

    story('/en/settings?profile=handleless');
    const handleless = await fetchRecorded(new Request(`${kernelUrl}/v1/accounts/${storyViewerId}/profile`));
    expect(await handleless.json()).toMatchObject({ profile: { id: storyViewerId, handle: null } });

    story('/en/settings?profile=extended');
    const extended = await fetchRecorded(new Request(`${kernelUrl}/v1/accounts/${storyViewerId}/profile`));
    expect(await extended.json()).toMatchObject({
      profile: { id: storyViewerId, links: expect.any(Array), avatar: expect.any(Object) },
    });

    story('/en/settings?profile=unavailable');
    const unavailable = await fetchRecorded(new Request(`${kernelUrl}/v1/accounts/${storyViewerId}/profile`));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'dependency_unavailable' });

    story('/en/settings?managedAccount=managed-organization&view=accounts');
    const managedAccount = new Request(`${kernelUrl}/v1/accounts/managed-organization`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'managed-profile' },
      body: JSON.stringify({ displayName: 'Unexpected' }),
    });
    expect(await answerFakeRoute('story', managedAccount)).toBeUndefined();
    expect((await fetchRecorded(managedAccount)).status).toBe(404);
  } finally {
    if (previous === undefined) delete runtime.__rezicsStoryContext;
    else runtime.__rezicsStoryContext = previous;
  }
});
