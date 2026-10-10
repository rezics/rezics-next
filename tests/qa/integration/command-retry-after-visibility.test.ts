import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { GRAPHS, ID, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;

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
    const member = await stack.member('visibility');
    await retryCredit(stack, member);
    await retrySubmission(stack, member);
    await retryReply(stack, member);
  } finally { await stack.stop(); }
}, 240_000);

async function retryCredit(stack: MediaStack, member: Member) {
  const created = await stack.publicWork(member.actor, ['en'], 'Credit visibility');
  await member.grant(`work:edit:${created.work}`, 'work.edit');
  const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
  const agent = `${ID}${randomUUID()}`;
  const body = { profile: 'native-agent-credit-v1', credit: `${ID}${randomUUID()}`, agent, role: 'author',
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

async function retrySubmission(stack: MediaStack, member: Member) {
  await member.grant('space:create:root', 'space.create');
  const space = await member.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Visibility Realm',
    capabilities: ['realm'], actingSubject: member.actor });
  const spaceText = await space.text();
  expect(space.status, spaceText).toBe(201);
  const realm = (JSON.parse(spaceText) as { realm: string }).realm;
  await member.grant(`submission:submit:${realm}`, 'submission.submit');
  const work = await stack.privateWork(member.actor);
  const contribution = await stack.contribution(work.work, member.actor, 'en', 'Offered when public');
  const draft = (await stack.fuseki.query(`SELECT ?draft WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(contribution.decision)} <${RV}selectedDraft> ?draft } }`)).results!.bindings[0]!.draft!.value;
  const body = { actingSubject: member.actor, kind: 'contribution', work: work.work, mainVersion: work.mainVersion,
    contribution: contribution.contribution, publicationDecision: contribution.decision, selectedDraft: draft,
    correctionOf: null };
  const hide = (from: 'Public' | 'Private', to: 'Public' | 'Private') => `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(contribution.decision)} rv:disclosure rv:${from} } }
    INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(contribution.decision)} rv:disclosure rv:${to} } }
    WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(contribution.decision)} rv:disclosure rv:${from} } }`;
  await stack.fuseki.update(hide('Public', 'Private'));
  const key = randomUUID();
  const hidden = await member.send('POST', `/v1/realms/${realm.slice(-36)}/submissions`, body, key);
  const hiddenText = await hidden.text();
  expect(hidden.status, hiddenText).toBe(404);
  const open = await admissions(stack, member, key);
  expect(open.rows.every(row => row.graph_outcome === null)).toBe(true);
  await stack.fuseki.update(hide('Private', 'Public'));
  const visible = await member.send('POST', `/v1/realms/${realm.slice(-36)}/submissions`, body, key);
  const visibleText = await visible.text();
  expect(visible.status, visibleText).toBe(201);
  const recorded = await admissions(stack, member, key);
  expect(recorded.rows).toHaveLength(1);
  expect(recorded.rows[0]!.graph_outcome).not.toBeNull();
  const operations = await stack.accessPool.query<{ count: string }>(
    `SELECT count(*) FROM access.realm_submission_operation o
     JOIN access.admission a ON a.id = o.admission_id WHERE a.idempotency_key = $1`, [key]);
  expect(operations.rows[0]!.count).toBe('1');
}

async function retryReply(stack: MediaStack, member: Member) {
  const created = await stack.publicWork(member.actor, ['en'], 'Reply visibility');
  const revision = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
  const reply = `${ID}${randomUUID()}`;
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  await member.grant(`reply:create:${created.work}`, 'reply.create');
  await member.grant(`content:draft:${reply}`, 'content.draft');
  const draftBody = { profile: 'member-reply-draft-v1', reply, variantId, rootTarget: created.work,
    rootRevision: revision, expectedHead: null, language: 'en', direction: 'ltr',
    document: fromPlainText('Reply words', 'blocks'), actingSubject: member.actor };
  const draft = await member.send('POST', '/v1/member-reply-drafts', draftBody);
  const draftText = await draft.text();
  expect(draft.status, draftText).toBe(201);
  const revisionId = (JSON.parse(draftText) as { revisionId: string }).revisionId;
  const protection = `${ID}${randomUUID()}`;
  await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
    ${iri(created.work)} rv:protectionHead ${iri(protection)} } }`);
  const body = { profile: 'realm-reply-identity-v1', reply, variantId, revisionId, author: member.actor,
    rootTarget: created.work, rootRevision: revision, parentReply: null, parentRevision: null, contextRevision: null };
  const key = randomUUID();
  const hidden = await member.send('POST', '/v1/realm-replies', body, key);
  const hiddenText = await hidden.text();
  expect([403, 404, 503], hiddenText).toContain(hidden.status);
  expect((await admissions(stack, member, key)).rows.every(row => row.graph_outcome === null)).toBe(true);
  await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
    ${iri(created.work)} rv:protectionHead ${iri(protection)} } }`);
  const visible = await member.send('POST', '/v1/realm-replies', body, key);
  const visibleText = await visible.text();
  expect(visible.status, visibleText).toBe(201);
  expect((await admissions(stack, member, key)).rows).toHaveLength(1);
}
