import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  new URLSearchParams({ actingSubject: person.actingSubject! });
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
afterAll(async () => {
  await sessions?.close();
});

import discussion from '../../../../../scripts/qa/cases/outcomes/zone/attached-realm-discussion.ts';
type Page = {
  realm: string;
  zone: string;
  about: string;
  targetRevision: string;
  routeRevision: string;
  path: string;
};
type Posted = { realm: string; about: string; author: string; reply: string; revisionId: string };
type Lookup = {
  realm: string;
  about: string;
  thread: { reply: string; rootRevision: string } | null;
};
type Thread = {
  thread: string;
  rootRevision: string;
  items: {
    reply: string;
    author: { id: string };
    revisionId: string;
    title: string | null;
    body: string;
    language: string | null;
    parent: string | null;
  }[];
};
let privateSessions: PersonaSessions;
let publicPage: Page, privatePage: Page, ownerPage: Page, moderationPage: Page, operatorPage: Page;
async function answerPage(fixture: PersonaSessions, segment: string): Promise<Page> {
  const owner = fixture.owner;
  const zoneRoot = `/v1/zones/${short(fixture.zone)}`;
  const work = await answer<{ work: string; mainVersion: string }>(
    owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1',
      title: `Original discussion fixture ${segment}`,
      language: 'en',
      authoring: 'own-work',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const contribution = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1',
      work: work.work,
      language: 'en',
      body: 'An original fixture essay about attachment and discussion.',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1',
      contribution: contribution.contribution,
      expectedDraftHead: contribution.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  await answer(
    owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1',
      work: work.work,
      contribution: contribution.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: work.mainVersion },
      selectionBasis: 'main-maintainer',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const navigation = await answer<{ revision: string }>(
    owner.main('GET', `${zoneRoot}?${acting(owner)}`),
  );
  const mount = await answer<{ revision: string }>(
    owner.main('POST', `${zoneRoot}/mounts`, {
      expectedHead: navigation.revision,
      target: work.work,
      routeSegment: segment,
      disclosure: 'public',
      actingSubject: owner.actingSubject,
    }),
  );
  // Every page bundle pins an original Zone home draft, credited to this steward.
  const prior = await answer<{ revision: string }>(
    owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`),
  );
  await answer(
    owner.main('PUT', `${zoneRoot}/configuration`, {
      expectedHead: prior.revision,
      prepareHomeDocument: true,
      actingSubject: owner.actingSubject,
    }),
  );
  const homeDocument = (
    await answer<{ configuration: { homeDocument: string } }>(
      owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`),
    )
  ).configuration.homeDocument;
  expect(homeDocument).toBeString();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{
    revisionId: string;
    byteDigest: string;
    sourcePosition: { dataEpoch: string };
  }>(
    owner.main('POST', '/v1/content-drafts', {
      profile: 'content-text-v1',
      resourceId: homeDocument,
      variantId,
      expectedHead: null,
      document: fromPlainText('Original steward-authored discussion home.', 'blocks'),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr',
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const config = await answer<{ revision: string }>(
    owner.main('GET', `${zoneRoot}/configuration?${acting(owner)}`),
  );
  await answer(
    owner.main('POST', `${zoneRoot}/site-publications`, {
      expectedHead: config.revision,
      routesRevision: mount.revision,
      navigationRevision: mount.revision,
      pages: [
        {
          page: homeDocument,
          variantId,
          revisionId: draft.revisionId,
          byteDigest: draft.byteDigest,
          contentEpoch: draft.sourcePosition.dataEpoch,
        },
      ],
      actingSubject: owner.actingSubject,
    }),
    201,
  );
  const route = await answer<{ revision: string; realm: string; resource: { id: string } }>(
    owner.main('GET', `${zoneRoot}/routes?path=%2F${segment}`),
  );
  expect(route.realm).toBe(fixture.realm);
  expect(route.resource.id).toBe(work.work);
  const header = await answer<{ revision: string }>(
    owner.main('GET', `/v1/works/${short(work.work)}?${acting(owner)}`),
  );
  return {
    realm: fixture.realm,
    zone: fixture.zone,
    about: work.work,
    targetRevision: header.revision,
    routeRevision: route.revision,
    path: `/${segment}`,
  };
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  privateSessions = await personaSessions('private');
  publicPage = await answerPage(sessions, 'public');
  privatePage = await answerPage(privateSessions, 'private');
  ownerPage = await answerPage(sessions, 'owner');
  moderationPage = await answerPage(sessions, 'moderation');
  operatorPage = await answerPage(sessions, 'operator');
  // Each later publication changes the route basis, so observe the final published cut.
  for (const page of [publicPage, ownerPage, moderationPage, operatorPage]) {
    page.routeRevision = (
      await answer<{ revision: string }>(
        sessions.owner.main(
          'GET',
          `/v1/zones/${short(page.zone)}/routes?${new URLSearchParams({ path: page.path })}`,
        ),
      )
    ).revision;
  }
}, 240_000);
function lookup(person: PersonaSession, page: Page) {
  const query = new URLSearchParams({
    about: page.about,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
  return person.main('GET', `/v1/realms/${short(page.realm)}/about-thread?${query}`);
}
function post(person: PersonaSession, page: Page, body: string, key = randomUUID()) {
  const { realm, ...basis } = page;
  return person.main(
    'POST',
    `/v1/realms/${short(realm)}/about-posts`,
    {
      profile: 'realm-about-post-v1',
      ...basis,
      actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
      language: 'en',
      direction: 'ltr',
      body,
    },
    key,
  );
}
async function thread(person: PersonaSession, page: Page, reply: string) {
  const query = new URLSearchParams({
    sort: 'new',
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
  return answer<Thread>(
    person.main('GET', `/v1/realms/${short(page.realm)}/threads/${short(reply)}?${query}`),
  );
}
async function privateAccess(name: PersonaName, status: number) {
  const response = await answer<Lookup | { code: string }>(
    lookup(privateSessions[name], privatePage),
    status,
  );
  if (status === 200)
    expect(response).toMatchObject({ realm: privatePage.realm, about: privatePage.about });
  else expect(response).toMatchObject({ code: 'work_unavailable' });
}
async function concurrent(page: Page, first: PersonaSession, second: PersonaSession) {
  const firstKey = randomUUID(),
    secondKey = randomUUID();
  const requests = await Promise.all([
    post(first, page, 'First independent contribution', firstKey),
    post(second, page, 'Second independent contribution', secondKey),
  ]);
  // A 202 is a durable pending write: explicitly replay the same intent, never sleep.
  const settle = async (response: Response, person: PersonaSession, body: string, key: string) => {
    for (let attempt = 0; response.status === 202 && attempt < 20; attempt++) {
      expect(await response.json()).toMatchObject({ operationId: expect.any(String) });
      response = await post(person, page, body, key);
    }
    expect([200, 201], `${response.status}: ${await response.clone().text()}`).toContain(
      response.status,
    );
    return answer<Posted>(Promise.resolve(response), response.status);
  };
  const [a, b] = await Promise.all([
    settle(requests[0]!, first, 'First independent contribution', firstKey),
    settle(requests[1]!, second, 'Second independent contribution', secondKey),
  ]);
  expect(a.author).toBe(first.actingSubject!);
  expect(b.author).toBe(second.actingSubject!);
  expect(a.reply).not.toBe(b.reply);
  expect(await answer(post(first, page, 'First independent contribution', firstKey))).toEqual(a);
  expect(await answer(post(second, page, 'Second independent contribution', secondKey))).toEqual(b);
  const canonical = await answer<Lookup>(lookup(first, page));
  expect(canonical.thread!.rootRevision).toBe(page.targetRevision);
  expect([a.reply, b.reply]).toContain(canonical.thread!.reply);
  const read = await thread(first, page, canonical.thread!.reply);
  expect(read.rootRevision).toBe(page.targetRevision);
  expect(read.items.map((item) => item.reply).sort()).toEqual([a.reply, b.reply].sort());
  for (const [posted, body] of [
    [a, 'First independent contribution'],
    [b, 'Second independent contribution'],
  ] as const) {
    const item = read.items.find((item) => item.reply === posted.reply)!;
    expect(item).toMatchObject({
      author: { id: posted.author },
      revisionId: posted.revisionId,
      language: 'en',
    });
    expect(
      item.title === null ? item.body : [item.title, item.body].filter(Boolean).join('\n'),
    ).toBe(body);
  }
  expect(read.items.filter((item) => item.parent === null)).toHaveLength(1);
  return canonical;
}
outcomeTest(discussion, 'visitor', async () => {
  expect(await answer<Lookup>(lookup(sessions.visitor, publicPage))).toEqual({
    realm: publicPage.realm,
    about: publicPage.about,
    thread: null,
  });
  await answer(post(sessions.visitor, publicPage, 'Signed-out attempt'), 401);
  expect((await answer<Lookup>(lookup(sessions.visitor, publicPage))).thread).toBeNull();
  await privateAccess('visitor', 404);
});
outcomeTest(discussion, 'stranger', async () => {
  await privateAccess('stranger', 404);
  const canonical = await concurrent(publicPage, sessions.stranger, sessions.member);
  expect(await answer(lookup(sessions.stranger, publicPage))).toEqual(canonical);
  expect(await answer(lookup(sessions.visitor, publicPage))).toEqual(canonical);
  // The contribution does not join the stranger to the attached Realm.
  const joining = await answer<{ state: string }>(
    sessions.stranger.main(
      'GET',
      `/v1/realms/${short(sessions.realm)}/joining?${acting(sessions.stranger)}`,
    ),
  );
  expect(joining.state).toBe('absent');
});
outcomeTest(discussion, 'member', async () => {
  await privateAccess('member', 200);
  const canonical = await concurrent(privatePage, privateSessions.member, privateSessions.owner);
  expect(await answer(lookup(privateSessions.member, privatePage))).toEqual(canonical);
  await privateAccess('stranger', 404);
  await privateAccess('operator', 404);
});
outcomeTest(discussion, 'owner', async () => {
  await privateAccess('owner', 200);
  const canonical = await concurrent(ownerPage, sessions.owner, sessions.member);
  await answer(
    sessions.owner.main('POST', `/v1/zones/${short(sessions.zone)}/realm-attachment-withdrawals`, {
      realm: sessions.realm,
      actingSubject: sessions.owner.actingSubject,
    }),
  );
  expect(await answer(lookup(sessions.visitor, ownerPage))).toEqual(canonical);
  expect((await thread(sessions.visitor, ownerPage, canonical.thread!.reply)).items).toHaveLength(
    2,
  );
  const refused = await post(sessions.owner, ownerPage, 'After withdrawal');
  expect([409, 503]).toContain(refused.status);
  expect(await answer(lookup(sessions.owner, ownerPage))).toEqual(canonical);
  // Subsequent cells need their original current attachment.
  const config = await answer<{ revision: string }>(
    sessions.owner.main(
      'GET',
      `/v1/zones/${short(sessions.zone)}/configuration?${acting(sessions.owner)}`,
    ),
  );
  await answer(
    sessions.owner.main('PUT', `/v1/zones/${short(sessions.zone)}/configuration`, {
      expectedHead: config.revision,
      defaultRealm: sessions.realm,
      actingSubject: sessions.owner.actingSubject,
    }),
  );
});
outcomeTest(discussion, 'moderator', async () => {
  await privateAccess('moderator', 200);
  const root = `/v1/realms/${short(sessions.realm)}/settings`;
  const current = await answer<{
    generation: string;
    ruleBasis: { revision: string | null };
    settings: object;
  }>(sessions.owner.main('GET', `${root}?${acting(sessions.owner)}`));
  const settings = {
    visibility: 'public',
    reviewMode: 'mandatory',
    reviewRequired: true,
    whoMaySubmit: 'members',
    selfJoin: true,
    rules: [],
  };
  await answer(
    sessions.owner.main('PUT', root, {
      expectedGeneration: current.generation,
      expectedRulesRevision: current.ruleBasis.revision,
      reason: 'Require review without moderator bypass',
      settings,
      actingSubject: sessions.owner.actingSubject,
    }),
    201,
  );
  try {
    const refusal = await answer<{ code: string }>(
      post(sessions.moderator, moderationPage, 'Requires review'),
      503,
    );
    expect(refusal.code).toBe('realm_reply_unavailable');
    expect((await answer<Lookup>(lookup(sessions.moderator, moderationPage))).thread).toBeNull();
  } finally {
    const updated = await answer<{ generation: string; ruleBasis: { revision: string | null } }>(
      sessions.owner.main('GET', `${root}?${acting(sessions.owner)}`),
    );
    await answer(
      sessions.owner.main('PUT', root, {
        expectedGeneration: updated.generation,
        expectedRulesRevision: updated.ruleBasis.revision,
        reason: 'Restore open discussion policy',
        settings: { ...settings, reviewMode: 'open', reviewRequired: false },
        actingSubject: sessions.owner.actingSubject,
      }),
      201,
    );
  }
});
outcomeTest(discussion, 'operator', async () => {
  await privateAccess('operator', 404);
  const own = await answer<Posted>(
    post(sessions.operator, operatorPage, 'Operator as its own Person'),
    201,
  );
  expect(own.author).toBe(sessions.operator.actingSubject!);
  const forged = await sessions.operator.main(
    'POST',
    `/v1/realms/${short(sessions.realm)}/about-posts`,
    {
      profile: 'realm-about-post-v1',
      about: operatorPage.about,
      zone: operatorPage.zone,
      targetRevision: operatorPage.targetRevision,
      routeRevision: operatorPage.routeRevision,
      path: operatorPage.path,
      actingSubject: sessions.owner.actingSubject,
      language: 'en',
      direction: 'ltr',
      body: 'Impersonation attempt',
    },
  );
  expect([403, 503]).toContain(forged.status);
  const canonical = await answer<Lookup>(lookup(sessions.operator, operatorPage));
  expect(
    (await thread(sessions.operator, operatorPage, canonical.thread!.reply)).items.map(
      (item) => item.author.id,
    ),
  ).toEqual([sessions.operator.actingSubject!]);
});
