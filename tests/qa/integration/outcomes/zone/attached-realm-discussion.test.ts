import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
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
  try { await recording.publish(); }
  finally { try { await privateSessions?.close(); } finally { await sessions?.close(); } }
});

import discussion from '../../../../../scripts/qa/cases/outcomes/zone/attached-realm-discussion.ts';
const recording = new OutcomeRecorder(discussion);
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
    vote: { score: number; value: -1 | 0 | 1; revision: string | null; open: boolean };
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
  await recording.prepare();
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
function lookup(person: PersonaSession, page: Page,
  sample?: ReturnType<typeof recording.session>, label = 'about-thread') {
  const query = new URLSearchParams({
    about: page.about,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
  return sample ? sample(label, 'GET', `/v1/realms/${short(page.realm)}/about-thread?${query}`)
    : person.main('GET', `/v1/realms/${short(page.realm)}/about-thread?${query}`);
}
function post(person: PersonaSession, page: Page, body: string, key = randomUUID(),
  sample?: ReturnType<typeof recording.session>, label = 'about-post') {
  const { realm, ...basis } = page;
  const call = sample ? (...args: Parameters<PersonaSession['main']>) => sample(label, ...args) : person.main;
  return call(
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
    { settle: false },
  );
}
async function thread(person: PersonaSession, page: Page, reply: string) {
  const query = new URLSearchParams({
    sort: 'new',
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
  const read = await answer<Thread>(
    person.main('GET', `/v1/realms/${short(page.realm)}/threads/${short(reply)}?${query}`),
  );
  for (const item of read.items) {
    expect(Number.isInteger(item.vote.score)).toBe(true);
    expect([-1, 0, 1]).toContain(item.vote.value);
  }
  return read;
}
function contributions(items: Thread['items']) {
  // The viewer's ability to vote differs between signed-in and public reads.
  return items.map(({ vote: _vote, ...contribution }) => contribution);
}
async function privateAccess(name: PersonaName, status: number,
  sample?: ReturnType<typeof recording.session>) {
  const response = await answer<Lookup | { code: string }>(
    lookup(privateSessions[name], privatePage, sample, 'private-about-thread'),
    status,
  );
  if (status === 200)
    expect(response).toMatchObject({ realm: privatePage.realm, about: privatePage.about });
  else expect(response).toMatchObject({ code: 'work_unavailable' });
}
async function concurrent(page: Page, first: PersonaSession, second: PersonaSession,
  sample?: ReturnType<typeof recording.session>) {
  // Establish the canonical opener before the concurrent contributions. Pending
  // opener recovery belongs to the owner suite, never to outcome retry loops.
  const opener = await answer<Posted>(post(first, page, 'Canonical original contribution'), 201);
  const firstKey = randomUUID(),
    secondKey = randomUUID();
  const requests = await Promise.all([
    post(first, page, 'First independent contribution', firstKey),
    post(second, page, 'Second independent contribution', secondKey),
  ]);
  const [a, b] = await Promise.all([
    answer<Posted>(Promise.resolve(requests[0]!), 201),
    answer<Posted>(Promise.resolve(requests[1]!), 201),
  ]);
  expect(a.author).toBe(first.actingSubject!);
  expect(b.author).toBe(second.actingSubject!);
  expect(a.reply).not.toBe(b.reply);
  expect(await answer(post(first, page, 'First independent contribution', firstKey))).toEqual(a);
  expect(await answer(post(second, page, 'Second independent contribution', secondKey))).toEqual(b);
  const canonical = await answer<Lookup>(lookup(first, page, sample, 'canonical-about-thread'));
  expect(canonical.thread!.rootRevision).toBe(page.targetRevision);
  expect(canonical.thread!.reply).toBe(opener.reply);
  const read = await thread(first, page, canonical.thread!.reply);
  expect(read.rootRevision).toBe(page.targetRevision);
  expect(read.items.map((item) => item.reply).sort()).toEqual([opener.reply, a.reply, b.reply].sort());
  for (const [posted, body] of [
    [opener, 'Canonical original contribution'],
    [a, 'First independent contribution'],
    [b, 'Second independent contribution'],
  ] as const) {
    const item = read.items.find((item) => item.reply === posted.reply)!;
    expect(item).toMatchObject({
      author: { id: posted.author },
      revisionId: posted.revisionId,
      language: 'en',
      vote: { score: 0, value: 0, revision: null, open: expect.any(Boolean) },
    });
    expect(
      item.title === null ? item.body : [item.title, item.body].filter(Boolean).join('\n'),
    ).toBe(body);
  }
  expect(read.items.filter((item) => item.parent === null)).toHaveLength(1);
  return canonical;
}

async function discussionState(person: PersonaSession, page: Page) {
  const canonical = await answer<Lookup>(lookup(person, page));
  const items = canonical.thread ? (await thread(person, page, canonical.thread.reply)).items : [];
  const credits = await answer<{ items: { id: string; role: string; agent: string }[]; nextCursor: string | null }>(
    person.main('GET', `/v1/works/${short(page.about)}/agent-credits${person.actingSubject ? `?${acting(person)}` : ''}`),
  );
  expect(credits.nextCursor).toBeNull();
  expect(credits.items).toHaveLength(1);
  expect(credits.items[0]).toMatchObject({ role: 'author', agent: sessions.owner.actingSubject });
  // Read native placement/Content author evidence independently of the thread
  // projection, so a refused write cannot silently change its attribution.
  const native = await Promise.all(items.map(async item => {
    const placed = await answer<{ reply: string; revisionId: string; author: string; rootTarget: string }>(
      person.main('GET', `/v1/realms/${encodeURIComponent(page.realm)}/replies/${encodeURIComponent(item.reply)}?${acting(person)}`),
    );
    expect(placed).toMatchObject({ reply: item.reply, revisionId: item.revisionId,
      author: item.author.id, rootTarget: page.about });
    return placed;
  }));
  return { canonical, items, credits: credits.items, native };
}
outcomeTest(discussion, 'visitor', async () => {
  const sample = recording.session('visitor', sessions.visitor);
  expect(await answer<Lookup>(lookup(sessions.visitor, publicPage, sample, 'empty-about-thread'))).toEqual({
    realm: publicPage.realm,
    about: publicPage.about,
    thread: null,
  });
  const before = await discussionState(sessions.visitor, publicPage);
  await answer(post(sessions.visitor, publicPage, 'Signed-out attempt', undefined, sample, 'signed-out-post-refused'), 401);
  expect((await answer<Lookup>(lookup(sessions.visitor, publicPage))).thread).toBeNull();
  expect(await discussionState(sessions.visitor, publicPage)).toEqual(before);
  await privateAccess('visitor', 404, recording.session('visitor', privateSessions.visitor));
  await visitorEntryReads(sample, publicPage, 'current-discussion-route',
    'current-discussion-target', 'realm-policy', false);
  await visitorEntryReads(recording.session('visitor', privateSessions.visitor), privatePage,
    'private-discussion-route', 'private-discussion-target', 'private-realm-policy', true);
}, recording);
outcomeTest(discussion, 'stranger', async () => {
  const sample = recording.session('stranger', sessions.stranger);
  await privateAccess('stranger', 404, recording.session('stranger', privateSessions.stranger));
  const canonical = await concurrent(publicPage, sessions.stranger, sessions.member, sample);
  expect(await answer(lookup(sessions.stranger, publicPage))).toEqual(canonical);
  expect(await answer(lookup(sessions.visitor, publicPage))).toEqual(canonical);
  await supportingReads(sample, sessions.stranger, publicPage, canonical);
  // The contribution does not join the stranger to the attached Realm.
  const joining = await answer<{ state: string }>(
    sessions.stranger.main(
      'GET',
      `/v1/realms/${short(sessions.realm)}/joining?${acting(sessions.stranger)}`,
    ),
  );
  expect(joining.state).toBe('absent');
}, recording);
outcomeTest(discussion, 'member', async () => {
  await privateAccess('member', 200, recording.session('member', privateSessions.member));
  const canonical = await concurrent(privatePage, privateSessions.member, privateSessions.owner, recording.session('member', privateSessions.member));
  expect(await answer(lookup(privateSessions.member, privatePage))).toEqual(canonical);
  await privateAccess('stranger', 404);
  await privateAccess('operator', 404);
}, recording);
outcomeTest(discussion, 'owner', async () => {
  const sample = recording.session('owner', sessions.owner);
  await privateAccess('owner', 200, recording.session('owner', privateSessions.owner));
  const canonical = await concurrent(ownerPage, sessions.owner, sessions.member, sample);
  const before = await discussionState(sessions.owner, ownerPage);
  try {
    await answer(
      sessions.owner.main('POST', `/v1/zones/${short(sessions.zone)}/realm-attachment-withdrawals`, {
        realm: sessions.realm,
        actingSubject: sessions.owner.actingSubject,
      }),
    );
    expect(await answer(lookup(sessions.visitor, ownerPage))).toEqual(canonical);
    expect(contributions((await thread(sessions.visitor, ownerPage, canonical.thread!.reply)).items))
      .toEqual(contributions(before.items));
    const refused = await answer<{ code: string }>(post(sessions.owner, ownerPage,
      'After withdrawal', undefined, sample, 'withdrawn-attachment-post-refused'), 409);
    expect(refused.code).toBe('read_basis_changed');
    expect(await discussionState(sessions.owner, ownerPage)).toEqual(before);
  } finally {
    // Even a failed response/assertion must restore the next persona's basis.
    const config = await answer<{ revision: string }>(sessions.owner.main('GET',
      `/v1/zones/${short(sessions.zone)}/configuration?${acting(sessions.owner)}`));
    await answer(sessions.owner.main('PUT', `/v1/zones/${short(sessions.zone)}/configuration`, {
      expectedHead: config.revision, defaultRealm: sessions.realm,
      actingSubject: sessions.owner.actingSubject,
    }));
  }
}, recording);
outcomeTest(discussion, 'moderator', async () => {
  const sample = recording.session('moderator', sessions.moderator);
  await privateAccess('moderator', 200, recording.session('moderator', privateSessions.moderator));
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
  const before = await discussionState(sessions.moderator, moderationPage);
  try {
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
    const refusal = await answer<{ code: string }>(
      post(sessions.moderator, moderationPage, 'Requires review', undefined, sample, 'review-required-post-refused'),
      403,
    );
    expect(refusal.code).toBe('realm_reply_denied');
    expect((await answer<Lookup>(lookup(sessions.moderator, moderationPage, sample, 'reviewed-empty-about-thread'))).thread).toBeNull();
    expect(await discussionState(sessions.moderator, moderationPage)).toEqual(before);
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
}, recording);
outcomeTest(discussion, 'operator', async () => {
  const sample = recording.session('operator', sessions.operator);
  await privateAccess('operator', 404, recording.session('operator', privateSessions.operator));
  const own = await answer<Posted>(
    post(sessions.operator, operatorPage, 'Operator as its own Person', undefined, sample, 'operator-own-post'),
    201,
  );
  expect(own.author).toBe(sessions.operator.actingSubject!);
  const before = await discussionState(sessions.operator, operatorPage);
  const forged = await answer<{ code: string }>(sample('impersonation-refused',
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
  ), 403);
  expect(forged.code).toBe('authority_denied');
  expect(await discussionState(sessions.operator, operatorPage)).toEqual(before);
  const canonical = await answer<Lookup>(lookup(sessions.operator, operatorPage, sample, 'canonical-about-thread'));
  expect(
    (await thread(sessions.operator, operatorPage, canonical.thread!.reply)).items.map(
      (item) => item.author.id,
    ),
  ).toEqual([sessions.operator.actingSubject!]);
}, recording);

async function visitorEntryReads(sample: ReturnType<typeof recording.session>, page: Page,
  routeLabel: string, targetLabel: string, realmLabel: string, concealed: boolean) {
  const route = await answer<{ realm: string | null }>(sample(routeLabel, 'GET',
    `/v1/zones/${short(page.zone)}/routes?${new URLSearchParams({ path: page.path })}`));
  expect(route.realm).toBe(concealed ? null : page.realm);
  await answer(sample(targetLabel, 'GET', `/v1/resources/${short(page.about)}/page`));
  const realm = await answer<{ code?: string }>(sample(realmLabel, 'GET',
    `/v1/realms/${short(page.realm)}`), concealed ? 404 : 200);
  if (concealed) expect(realm.code).toBe('work_unavailable');
}

async function supportingReads(sample: ReturnType<typeof recording.session>, person: PersonaSession,
  page: Page, canonical: Lookup) {
  const viewer = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${acting(person)}`;
  await answer(sample('space-address', 'GET', viewer(`/v1/addresses/resolve?${new URLSearchParams({
    scope: 'space', key: short(sessions.space),
  })}`)));
  await answer(sample('published-presentation', 'GET', viewer(`/v1/zones/${short(page.zone)}/presentation`)));
  await answer(sample('current-discussion-route', 'GET', viewer(`/v1/zones/${short(page.zone)}/routes?${
    new URLSearchParams({ path: page.path })}`)));
  await answer(sample('current-discussion-target', 'GET', viewer(`/v1/resources/${short(page.about)}/page`)));
  await answer(sample('realm-policy', 'GET', viewer(`/v1/realms/${short(page.realm)}`)));
  await answer(sample('joining-context', 'GET', viewer(`/v1/realms/${short(page.realm)}/joining`)));
  await answer(sample('follow-context', 'GET', viewer(`/v1/follows/${short(page.realm)}?kind=realm`)));
  await answer(sample('platform-access', 'GET', '/v1/me/platform-access'));
  const ban = await answer<{ code: string }>(sample('member-ban-absent', 'GET',
    viewer(`/v1/realms/${short(page.realm)}/member-ban`)), 404);
  expect(ban.code).toBe('appeal_unavailable');
  await answer(sample('showcase-editor-refused', 'GET', viewer(`/v1/zones/${short(page.zone)}/showcase-editor`)), 404);
  // The component uses the default thread order; the concurrency proof above uses new explicitly.
  await answer(sample('canonical-discussion-thread', 'GET', viewer(`/v1/realms/${short(page.realm)}/threads/${
    short(canonical.thread!.reply)}`)));
  const work = await answer<{ mainVersion: string; selectedLanguage: string | null }>(
    sample('mounted-work-header', 'GET', viewer(`/v1/works/${short(page.about)}`)));
  await answer(sample('mounted-work-text', 'GET', `/v1/main-versions/${short(work.mainVersion)}/selection${
    work.selectedLanguage ? `?language=${encodeURIComponent(work.selectedLanguage)}` : ''}`));
}
