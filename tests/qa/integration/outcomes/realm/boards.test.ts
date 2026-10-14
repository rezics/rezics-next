import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import boards from '../../../../../scripts/qa/cases/outcomes/realm/boards.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { recordRealmDiscussion } from '../../../support/realm-discussion-recording.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../../../support/persona-fixture-authority.ts';

type Vocabulary = { scheme: string; schemeHead: string; concept: string; conceptHead: string };
type Target = { work: string; workRevision: string; mainVersion: string };
type Reply = { reply: string; variantId: string; revisionId: string; revisionDigest: string; placement: string };
type Page = { items: { reply: string }[]; nextCursor: string | null;
  count: { value: number; kind: string; total: null } };
type Observation = { request: string; status: number; answer: unknown; expected: string };
setDefaultTimeout(120_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(boards);
let recordedVocabulary: Vocabulary, emptyVocabulary: Vocabulary;
let recordedTarget: Target;
let context: string, news: Vocabulary, empty: Vocabulary, retiring: Vocabulary, retirement: Observation;
let memberReply: Reply, ownerReply: Reply;
const short = (iri: string) => iri.slice(-36);
const id = () => `https://rezics.com/id/${randomUUID()}`;
const acting = (person: PersonaSession) => new URLSearchParams(person.actingSubject ? { actingSubject: person.actingSubject } : {});

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}

function placementHead(value: unknown, reply: Reply): string {
  expect(value).toMatchObject({ profile: 'realm-reply-placement-v1', realm: sessions.realm,
    reply: reply.reply, revisionId: reply.revisionId });
  const { placement } = value as { placement: string };
  expect(placement).toBeString();
  expect(placement).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  return placement;
}

async function publish(person: PersonaSession, target: Target, text: string, concept?: string): Promise<Reply> {
  async function command(path: string, input: unknown) {
    const key = randomUUID();
    for (let attempt = 0; ; attempt++) {
      const response = await person.main('POST', path, input, key);
      if (response.status !== 409 || attempt === 5) return response;
      if ((await response.clone().json() as { code: string }).code !== 'read_basis_changed') return response;
      await answer(person.main('GET', `/v1/works/${short(target.work)}?${acting(person)}`));
    }
  }
  const draft = await answer<Reply>(command('/v1/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply: id(), variantId: `urn:rezics:variant:${randomUUID()}`,
    rootTarget: target.work, rootRevision: target.workRevision, originRealm: sessions.realm,
    language: 'en', direction: 'ltr', expectedHead: null, body: text, actingSubject: person.actingSubject,
  }), 201);
  await answer(command('/v1/realm-replies', {
    profile: 'realm-reply-identity-v1', reply: draft.reply, variantId: draft.variantId,
    revisionId: draft.revisionId, author: person.actingSubject, rootTarget: target.work,
    rootRevision: target.workRevision, parentReply: null, parentRevision: null, contextRevision: null,
  }), 201);
  const placed = await answer<{ placement: string }>(command('/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm: sessions.realm, reply: draft.reply,
    revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
    reviewDecisionId: null, expectedHead: null, actingSubject: person.actingSubject,
    ...(concept ? { concepts: [concept], primaryConcept: concept } : {}),
  }), 201);
  return { ...draft, placement: placementHead(placed, draft) };
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  // These scaffold mandates create classification identities, not board
  // management rights. Conversation and placement fixtures use ordinary roles.
  await grantPersonaFixtureAuthority(sessions.owner, [
    { scope: 'classification:define:global', action: 'classification.proposition.define' },
    { scope: `classification:context:${sessions.realm}`, action: 'classification.context.configure' },
  ]);
  context = (await answer<{ context: string }>(sessions.owner.main('POST', '/v1/classification-contexts', {
    profile: 'classification-context-v1', realm: sessions.realm, actingSubject: sessions.owner.actingSubject,
  }), 201)).context;
  news = await answer<Vocabulary>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: null,
    labels: [{ language: 'en', value: `Board news ${randomUUID()}` }], alternativeLabels: [], broader: [], narrower: [],
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  empty = await answer<Vocabulary>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: { id: news.scheme, expectedHead: news.schemeHead },
    labels: [{ language: 'en', value: `Empty board ${randomUUID()}` }], alternativeLabels: [], broader: [], narrower: [],
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  retiring = await answer<Vocabulary>(sessions.owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2', scheme: { id: empty.scheme, expectedHead: empty.schemeHead },
    labels: [{ language: 'en', value: `Retirement candidate ${randomUUID()}` }], alternativeLabels: [], broader: [], narrower: [],
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  const retireInput = {
    profile: 'classification-proposition-v2', scheme: { id: retiring.scheme, expectedHead: retiring.schemeHead },
    concept: { id: retiring.concept, expectedHead: retiring.conceptHead }, state: 'retired',
    labels: [{ language: 'en', value: 'Retired board' }], alternativeLabels: [], broader: [], narrower: [],
    actingSubject: sessions.owner.actingSubject,
  };
  // Capture an unsupported prerequisite without pretending this Concept
  // actually retired. Every persona then attempts the intended gone read.
  const retired = await sessions.owner.main('POST', '/v1/classification-vocabulary', retireInput);
  retirement = { request: `owner POST /v1/classification-vocabulary ${JSON.stringify(retireInput)}`,
    status: retired.status, answer: await retired.json(), expected: '200/201: retire this exact Concept' };
  const target = await answer<Target>(sessions.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title: 'Original board discussions', language: 'en', authoring: 'own-work',
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  recordedTarget = target;
  const draft = await answer<{ contribution: string; draftRevision: string }>(sessions.owner.main('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: target.work, language: 'en',
    body: 'An original story about a gardener planting a seed.', actingSubject: sessions.owner.actingSubject,
  }), 201);
  const publication = await answer<{ publicationDecision: string }>(sessions.owner.main('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  await answer(sessions.owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: target.work, contribution: draft.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: target.mainVersion }, selectionBasis: 'main-maintainer',
    actingSubject: sessions.owner.actingSubject,
  }), 201);
  await answer(sessions.visitor.main('GET', `/v1/works/${short(target.work)}`));
  memberReply = await publish(sessions.member, target, 'Member discussion\nAn original contribution.');
  ownerReply = await publish(sessions.owner, target, 'Owner discussion\nAnother original contribution.');
  await prepareRecordedVocabulary();
  for (let index = 0; index < 21; index++)
    await publish(sessions.owner, recordedTarget, `Original classified discussion ${index}.`, recordedVocabulary.concept);
}, 390_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function prepareRecordedVocabulary() {
  const define = (prior: Vocabulary | null, value: string) => answer<Vocabulary>(sessions.owner.main('POST',
    '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2',
      scheme: prior ? { id: prior.scheme, expectedHead: prior.schemeHead } : null,
      labels: [{ language: 'en', value }], alternativeLabels: [], broader: [], narrower: [],
      actingSubject: sessions.owner.actingSubject,
    }), 201);
  let prior: Vocabulary | null = null;
  for (let index = 0; index < 21; index++)
    prior = await define(prior, `Recorded discussion board ${index} ${randomUUID()}`);
  recordedVocabulary = prior!;
  emptyVocabulary = await define(null, `Empty vocabulary ${randomUUID()}`);
  await answer(sessions.owner.main('POST', '/v1/classification-vocabulary', {
    profile: 'classification-proposition-v2',
    concept: { id: emptyVocabulary.concept, expectedHead: emptyVocabulary.conceptHead }, state: 'retired',
    actingSubject: sessions.owner.actingSubject,
  }), 201);
}
async function productionBoards(name: PersonaName) {
  const path = `/v1/realms/${short(sessions.realm)}/classification-context`;
  const basis = await answer<{ contextRevision: string; scheme: string | null }>(sessions.owner.main('GET', path));
  // Select a bounded, fixture-owned scheme. Restore the original selection so
  // supporting reads cannot change the existing board proof's jurisdiction.
  const select = async (scheme: { id: string; expectedHead: string } | null) => {
    const current = await answer<{ contextRevision: string }>(sessions.owner.main('GET', path));
    await answer(sessions.owner.main('POST', '/v1/classification-contexts', {
      profile: 'classification-context-v2', realm: sessions.realm, expectedHead: current.contextRevision,
      scheme, actingSubject: sessions.owner.actingSubject,
    }));
  };
  // The original fixture context has no selected scheme.
  expect(basis.scheme).toBeNull();
  const reads = recordRealmDiscussion(recording, name, sessions[name], sessions.realm);
  try {
    await select({ id: recordedVocabulary.scheme, expectedHead: recordedVocabulary.schemeHead });
    const first = await reads('boards-populated').boards();
    if (first.ok && first.data.nextCursor) {
      await reads('boards-continuation').boards(first.data.nextCursor);
      await reads('board-threads-mismatched-vocabulary-cursor').threads({ sort: 'best', window: 'week',
        concept: recordedVocabulary.concept, cursor: first.data.nextCursor });
    }
    for (const sort of ['best', 'new', 'top'] as const) {
      for (const window of sort === 'top' ? ['week', 'month', 'all'] as const : ['week'] as const) {
        const label = `board-threads-${sort}${sort === 'top' ? `-${window}` : ''}`;
        const query = { sort, window, concept: recordedVocabulary.concept };
        const page = await reads(label).threads(query);
        if (page.ok && page.data.nextCursor) {
          await reads(`${label}-continuation`).threads({ ...query, cursor: page.data.nextCursor });
          await reads(`${label}-mismatched-board-cursor`).threads({ ...query, concept: empty.concept,
            cursor: page.data.nextCursor });
        }
        await reads(`${label}-language`).threads({ ...query, language: 'en' });
      }
    }
    await reads('board-threads-empty').threads({ sort: 'best', window: 'week', concept: empty.concept });
    await reads('board-threads-retired').threads({ sort: 'best', window: 'week', concept: retiring.concept });
    await reads('board-threads-absent').threads({ sort: 'best', window: 'week', concept: id() });
    await reads('board-threads-unsupported-selection').threads({ sort: 'best', window: 'week', concept: 'unsupported-board-selection' });
    const beforeMove = await reads('board-threads-before-move').threads({ sort: 'new', window: 'week',
      concept: recordedVocabulary.concept });
    if (beforeMove.ok && beforeMove.data.nextCursor) {
      await publish(sessions.owner, recordedTarget, 'Original classified insertion moves the board.', recordedVocabulary.concept);
      await reads('board-threads-moved-cursor').threads({ sort: 'new', window: 'week',
        concept: recordedVocabulary.concept, cursor: beforeMove.data.nextCursor });
    }
    await select({ id: emptyVocabulary.scheme, expectedHead: emptyVocabulary.schemeHead });
    await reads('boards-empty').boards();
  } finally { await select(null); }
}

async function boardContract(name: PersonaName) {
  const source = sessions[name], sample = recording.session(name, source);
  let ordinal = 0;
  const person: PersonaSession = { ...source,
    main: (...args) => sample(`board-proof-${++ordinal}`, ...args) };
  const root = `/v1/realms/${short(sessions.realm)}`;
  const gaps: Observation[] = [];
  async function observe(method: string, path: string, body: unknown, expected: string,
    accepts: (status: number, value: unknown) => boolean) {
    const response = await person.main(method, path, body), value: unknown = await response.json();
    const observation = { request: `${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`,
      status: response.status, answer: value, expected };
    if (!accepts(response.status, value)) gaps.push(observation);
    return observation;
  }
  const ok = (status: number) => status === 200;
  const written = (status: number) => status === 200 || status === 201;
  expect(await answer<{ context: string }>(person.main('GET', `${root}/classification-context`))).toMatchObject({ context });
  await answer(person.main('GET', `/v1/concepts/${short(news.concept)}`));
  const query = acting(person); query.set('sort', 'new'); query.set('limit', '1');
  const control = await answer<Page>(person.main('GET', `${root}/threads?${query}`));
  expect(control.items).toHaveLength(1);
  expect(control.nextCursor).toBeString();
  expect(control.count).toEqual({ value: 1, kind: 'exact-page', total: null });

  await observe('GET', `/v1/classification-vocabulary?${new URLSearchParams({ context, limit: '1' })}`, undefined,
    '200: Concepts selected by this Realm context, at most one item with a scoped continuation',
    (status, value) => status === 200 && Array.isArray((value as { items?: unknown[] }).items)
      && (value as { items: unknown[] }).items.length <= 1 && Object.hasOwn(value as object, 'nextCursor'));
  // Realm-scoped discovery is an alternative, but does not declare the
  // schemes selected by the Realm's classification context as its boards.
  await observe('GET', `/v1/discovery/concepts?${new URLSearchParams({ scope: 'realm', realm: sessions.realm,
    limit: '1', personalization: 'false' })}`, undefined, '200: bounded Concept discovery', ok);
  await observe('GET', '/v1/facets', undefined, '200: discover admitted classification Facets', ok);

  const filtered = new URLSearchParams(query); filtered.set('concept', news.concept);
  await observe('GET', `${root}/threads?${filtered}`, undefined,
    '200: only placements carrying this Concept in Realm order; inaccessible replies absent and not counted',
    (status, value) => {
      const page = value as Page;
      // Neither control placement has this Concept. Ignoring the filter is
      // not success even if the collection answers 200.
      return status === 200 && page.items.length === 0 && page.count.value === 0 && page.nextCursor === null;
    });
  if (retirement.status !== 200 && retirement.status !== 201) gaps.push(retirement);
  filtered.set('concept', retiring.concept);
  await observe('GET', `${root}/threads?${filtered}`, undefined,
    '404: retired Concept board is gone, with no content or server error', status => status === 404);
  filtered.set('concept', news.concept);
  filtered.set('cursor', control.nextCursor!);
  await observe('GET', `${root}/threads?${filtered}`, undefined,
    '400: a continuation obtained outside this board cannot enter the board', status => status === 400);
  filtered.delete('cursor'); filtered.set('concept', empty.concept);
  await observe('GET', `${root}/threads?${filtered}`, undefined,
    '200: empty board has items [], count 0 and nextCursor null', (status, value) => {
      const page = value as Page;
      return status === 200 && page.items.length === 0 && page.count.value === 0 && page.nextCursor === null;
    });

  const placement = (reply: Reply, concepts: string[], primaryConcept: string | null) => ({
    profile: 'realm-reply-placement-v1', realm: sessions.realm, reply: reply.reply,
    revisionId: reply.revisionId, revisionDigest: reply.revisionDigest,
    reviewDecisionId: null, expectedHead: reply.placement,
    actingSubject: person.actingSubject ?? sessions.member.actingSubject, concepts, primaryConcept,
  });
  const mayManage = name === 'member' || name === 'owner' || name === 'moderator';
  const managementAnswer = mayManage ? written : (status: number) => status === (name === 'visitor' ? 401 : 403);
  const managementExpected = mayManage ? '200/201: author where allowed, owner or Realm moderator changes only board placement'
    : `${name === 'visitor' ? 401 : 403}: no placement authority; operator status supplies no board mandate`;
  async function place(reply: Reply, concepts: string[], primary: string | null, expected: string,
    accepts: (status: number) => boolean) {
    const result = await observe('POST', '/v1/realm-reply-placements', placement(reply, concepts, primary), expected, accepts);
    // These replies are shared across persona callbacks. Only a validated
    // successful command supplies the next placement CAS head.
    if (written(result.status)) reply.placement = placementHead(result.answer, reply);
  }
  for (const [concepts, primary] of [[[news.concept], null], [[news.concept, empty.concept], news.concept], [[], null]] as const)
    await place(memberReply, [...concepts], primary, managementExpected, managementAnswer);
  if (name === 'member') await place(ownerReply, [news.concept], null,
    '403: membership alone cannot classify another author\'s conversation', status => status === 403);

  if (name === 'moderator' || name === 'operator') {
    const roles = await answer<{ generation: string }>(sessions.owner.main('GET', `${root}/roles?${acting(sessions.owner)}`));
    const input = { actingSubject: sessions.owner.actingSubject, expectedGeneration: roles.generation,
      reason: 'Bound placement management to the news Concept',
      change: { kind: 'role', roleId: randomUUID(), name: 'News placement managers',
        permissions: ['publication.adopt'], targetScope: { kind: 'concept', id: news.concept } } };
    const response = await sessions.owner.main('POST', `${root}/role-impact`, input);
    if (response.status !== 200) gaps.push({ request: `owner POST ${root}/role-impact ${JSON.stringify(input)}`,
      status: response.status, answer: await response.json(),
      expected: '200: existing Realm role can name its Concept jurisdiction before assignment; no unbounded operator bypass' });
  }

  console.log(`Board HTTP evidence / ${name}: ${JSON.stringify(gaps)}`);
  await productionBoards(name);
  // Attempt every request before asserting, so a collection gap cannot
  // conceal placement, continuation or empty/retirement contract gaps.
  expect(gaps, JSON.stringify(gaps)).toEqual([]);
}

outcomeTest(boards, 'visitor', () => boardContract('visitor'), recording);
outcomeTest(boards, 'stranger', () => boardContract('stranger'), recording);
outcomeTest(boards, 'member', () => boardContract('member'), recording);
outcomeTest(boards, 'owner', () => boardContract('owner'), recording);
outcomeTest(boards, 'moderator', () => boardContract('moderator'), recording);
outcomeTest(boards, 'operator', () => boardContract('operator'), recording);
