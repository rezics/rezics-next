import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { GRAPHS, ID, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;

const native = () => `${ID}${randomUUID()}`;

async function admissions(stack: MediaStack, member: Member, key: string) {
  return stack.accessPool.query<{ state: string; graph_outcome: string | null }>(
    `SELECT a.state, a.graph_outcome FROM access.admission a
     JOIN access.principal p ON p.id = a.principal_id
     WHERE p.account_issuer = $1 AND p.account_subject = $2 AND a.idempotency_key = $3`,
    [member.principal.issuer, member.principal.subject, key]);
}

test('a command key is re-evaluated after its target becomes visible', async () => {
  const stack = await startMediaStack('command-retry-visibility', { profileCredits: true });
  try {
    const member = await stack.member('visibility', { verified: true });
    await retryCredit(stack, member);
    await retryFollow(stack, member);
    await retryRating(stack, member);
    await retrySubmission(stack, member);
    await retryReply(stack, member);
  } finally { await stack.stop(); }
}, 240_000);

async function retryCredit(stack: MediaStack, member: Member) {
  const created = await stack.publicWork(member.actor, ['en'], 'Credit visibility');
  await member.grant(`work:edit:${created.work}`, 'work.edit');
  const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
  const agent = native();
  const body = { profile: 'native-agent-credit-v1', credit: native(), agent, role: 'author',
    expectedWorkHead: head, actingSubject: member.actor };
  const key = randomUUID();
  const hidden = await member.send('POST', `/v1/works/${created.work.slice(-36)}/agent-credits`, body, key);
  const hiddenText = await hidden.text();
  expect(hidden.status, hiddenText).toBe(404);
  expect((await admissions(stack, member, key)).rows).toEqual([]);
  await stack.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [agent]);
  await createAgentGraph(stack.env, { id: randomUUID(), agent, kind: 'person', displayName: 'Later author',
    digest: createHash('sha256').update(agent).digest('hex') });
  const visible = await member.send('POST', `/v1/works/${created.work.slice(-36)}/agent-credits`, body, key);
  const visibleText = await visible.text();
  expect(visible.status, visibleText).toBe(201);
  const recorded = await admissions(stack, member, key);
  expect(recorded.rows).toHaveLength(1);
  expect(recorded.rows[0]!.graph_outcome).not.toBeNull();
  const replay = await member.send('POST', `/v1/works/${created.work.slice(-36)}/agent-credits`, body, key);
  expect(replay.status).toBe(200);
  expect((await admissions(stack, member, key)).rows).toHaveLength(1);
}

async function retryFollow(stack: MediaStack, member: Member) {
  // Follow authority is the acting member's controlled person, checked before
  // the target's visibility. The fixture Agent is only an authority subject.
  const provisioned = await member.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Visibility follower',
  });
  const provisionText = await provisioned.text();
  expect(provisioned.status, provisionText).toBe(201);
  const person = (JSON.parse(provisionText) as { agent: string }).agent;
  const agent = native();
  const body = { profile: 'follow-command-v1', target: agent, kind: 'agent', actingSubject: person,
    following: true, expectedRevision: null };
  const key = randomUUID();
  const hidden = await member.send('POST', '/v1/follows', body, key);
  const hiddenText = await hidden.text();
  expect(hidden.status, hiddenText).toBe(404);
  const hiddenReceipts = await stack.accessPool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM access.follow_receipt WHERE idempotency_key = $1', [key]);
  expect(hiddenReceipts.rows[0]!.n).toBe('0');
  await stack.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [agent]);
  await createAgentGraph(stack.env, { id: randomUUID(), agent, kind: 'person', displayName: 'Later follow',
    digest: createHash('sha256').update(agent).digest('hex') });
  const visible = await member.send('POST', '/v1/follows', body, key);
  const visibleText = await visible.text();
  expect(visible.status, visibleText).toBe(200);
  const recorded = await stack.accessPool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM access.follow_receipt WHERE idempotency_key = $1', [key]);
  expect(recorded.rows[0]!.n).toBe('1');
  const replay = await member.send('POST', '/v1/follows', body, key);
  expect(replay.status).toBe(200);
  expect((await stack.accessPool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM access.follow_receipt WHERE idempotency_key = $1', [key])).rows[0]!.n).toBe('1');
}

async function retryRating(stack: MediaStack, member: Member) {
  await member.grant('space:create:root', 'space.create');
  const settings = { visibility: 'private', reviewRequired: true, reviewMode: 'mandatory',
    whoMaySubmit: 'granted', selfJoin: false, rules: [] };
  const space = await member.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Hidden rating realm',
    capabilities: ['realm'], actingSubject: member.actor, initialSettings: settings });
  const spaceText = await space.text();
  expect(space.status, spaceText).toBe(201);
  const realm = (JSON.parse(spaceText) as { realm: string }).realm;
  const governance = `governance:realm:${realm}`;
  await member.grant(governance, 'rating.configure');
  const body = { profile: 'realm-standing-rating-context-v1', realm, question: 'Visible later',
    actingSubject: member.actor };
  const key = randomUUID();
  const hidden = await member.send('POST', '/v1/rating-contexts', body, key);
  const hiddenText = await hidden.text();
  expect(hidden.status, hiddenText).toBe(403);
  expect((await admissions(stack, member, key)).rows).toEqual([]);
  await member.grant(governance, 'realm.settings.manage');
  await member.grant(governance, 'governance.rule.publish');
  const current = await member.read(`/v1/realms/${realm.slice(-36)}/settings`);
  const currentText = await current.text();
  expect(current.status, currentText).toBe(200);
  const view = JSON.parse(currentText) as { generation: string;
    settings: { visibility: string; reviewRequired: boolean; reviewMode?: string; whoMaySubmit: string;
      selfJoin?: boolean; rules: unknown[] };
    ruleBasis: { revision: string | null } };
  const opened = await member.send('PUT', `/v1/realms/${realm.slice(-36)}/settings`, {
    actingSubject: member.actor, expectedGeneration: view.generation, expectedRulesRevision: view.ruleBasis.revision,
    reason: 'Make the Realm public', settings: { ...view.settings, visibility: 'public' } });
  const openedText = await opened.text();
  expect(opened.status, openedText).toBe(201);
  const visible = await member.send('POST', '/v1/rating-contexts', body, key);
  const visibleText = await visible.text();
  expect(visible.status, visibleText).toBe(201);
  const recorded = await admissions(stack, member, key);
  expect(recorded.rows).toHaveLength(1);
  expect(recorded.rows[0]!.graph_outcome).not.toBeNull();
  const replay = await member.send('POST', '/v1/rating-contexts', body, key);
  expect(replay.status).toBe(200);
  expect((await admissions(stack, member, key)).rows).toHaveLength(1);
}

async function retrySubmission(stack: MediaStack, member: Member) {
  await member.grant('space:create:root', 'space.create');
  const space = await member.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Submission visibility',
    capabilities: ['realm'], actingSubject: member.actor });
  const spaceText = await space.text();
  expect(space.status, spaceText).toBe(201);
  const realm = (JSON.parse(spaceText) as { realm: string }).realm;
  await member.grant(`submission:submit:${realm}`, 'submission.submit');
  // The publication decision is assigned by publish, and this dataset does not
  // dispatch SPARQL update, so the same body cannot be made public afterwards.
  // A retry while the candidate is still absent must stay unsealed.
  const body = { actingSubject: member.actor, kind: 'contribution', work: native(), mainVersion: native(),
    contribution: native(), publicationDecision: native(), selectedDraft: native(), correctionOf: null };
  const key = randomUUID();
  const hidden = await member.send('POST', `/v1/realms/${realm.slice(-36)}/submissions`, body, key);
  const hiddenText = await hidden.text();
  expect(hidden.status, hiddenText).toBe(404);
  const open = await admissions(stack, member, key);
  expect(open.rows).toHaveLength(1);
  expect(open.rows[0]!.graph_outcome).toBeNull();
  const again = await member.send('POST', `/v1/realms/${realm.slice(-36)}/submissions`, body, key);
  const againText = await again.text();
  expect(again.status, againText).toBe(404);
  const still = await admissions(stack, member, key);
  expect(still.rows).toHaveLength(1);
  expect(still.rows[0]!.graph_outcome).toBeNull();
}

async function retryReply(stack: MediaStack, member: Member) {
  const personResponse = await member.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Reply author',
  });
  const personText = await personResponse.text();
  expect(personResponse.status, personText).toBe(201);
  const person = (JSON.parse(personText) as { agent: string }).agent;
  const missingRoot = native();
  const hiddenBody = { profile: 'realm-reply-identity-v1', reply: native(),
    variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID(), author: person,
    rootTarget: missingRoot, rootRevision: native(), parentReply: null, parentRevision: null, contextRevision: null };
  const hiddenKey = randomUUID();
  const hidden = await member.send('POST', '/v1/realm-replies', hiddenBody, hiddenKey);
  const hiddenText = await hidden.text();
  expect(hidden.status, hiddenText).toBe(404);
  expect((await admissions(stack, member, hiddenKey)).rows).toEqual([]);
  const created = await stack.publicWork(member.actor, ['en'], 'Reply visibility');
  const revision = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
  const reply = native();
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await member.send('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1', reply, variantId,
    rootTarget: created.work, rootRevision: revision, expectedHead: null, language: 'en', direction: 'ltr',
    document: fromPlainText('Reply words', 'blocks'), actingSubject: person });
  const draftText = await draft.text();
  expect(draft.status, draftText).toBe(201);
  const revisionId = (JSON.parse(draftText) as { revisionId: string }).revisionId;
  const body = { profile: 'realm-reply-identity-v1', reply, variantId, revisionId, author: person,
    rootTarget: created.work, rootRevision: revision, parentReply: null, parentRevision: null, contextRevision: null };
  const key = randomUUID();
  const visible = await member.send('POST', '/v1/realm-replies', body, key);
  const visibleText = await visible.text();
  expect(visible.status, visibleText).toBe(201);
  expect((await admissions(stack, member, key)).rows).toHaveLength(1);
}
