import { createHash, randomUUID } from 'node:crypto';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';
import type { HomeStack } from './feed-read-support.ts';

/** Saved-view matching needs one public Work and one reviewed post. Chapters,
 * reading shelves, unrelated follows and the Home projection are not its inputs. */
export async function seedSavedView(home: HomeStack) {
  const { stack, call, json } = home;
  const author = await home.provision('Saved-view author', home.author.token);
  const reader = await home.provision('Saved-view reader', home.reader.token);
  const work = await stack.publicWork(author, ['en'], 'Saved-view Work');
  const realm = await json<{ realm: string; space: string }>(await call('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: 'Saved-view community', capabilities: ['realm'], actingSubject: author,
  }, home.author.token), 201);
  const selection = {
    context: { kind: 'realm-local' as const, id: realm.realm }, work: work.work,
    mainVersion: work.mainVersion, contribution: work.variants[0]!.contribution,
    publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
    selectionBasis: 'realm-manager-review' as const, actingSubject: author,
  };
  const adopted = await selectRealmLocal(stack.env,
    stack.admission(author, `publication:adopt:${realm.realm}`, 'publication.adopt', realmSelectionDigest(selection)),
    selection);
  if (adopted.outcome !== 'succeeded') throw new Error('Saved-view Realm pick failed');
  const rootRevision = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?draft WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work.variants[0]!.contribution)} rv:publicationHead ?decision }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:selectedDraft ?draft } } LIMIT 1`)).results!.bindings[0]!.draft!.value;
  for (const [scope, action] of [[`review:decide:${realm.realm}`, 'review.decide'],
    [`reply:place:${realm.realm}`, 'reply.place']] as const) {
    await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES($1,$2,$3,$4,now()+interval '1 hour')`, [randomUUID(), home.author.principalId, author, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES($1,$2,$2,$3,$4,now()+interval '1 hour')`, [randomUUID(), author, scope, action]);
  }
  const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await json<{ revisionId: string; revisionDigest: string }>(await call('POST', '/v1/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply, variantId, rootTarget: work.work, rootRevision,
    language: 'en', direction: 'ltr', expectedHead: null, body: 'A reviewed saved-view post', actingSubject: reader,
  }, home.reader.token), 201);
  await json(await call('POST', '/v1/realm-replies', {
    profile: 'realm-reply-identity-v1', reply, variantId, revisionId: draft.revisionId, author: reader,
    rootTarget: work.work, rootRevision, parentReply: null, parentRevision: null, contextRevision: null,
  }, home.reader.token), 201);
  const identity = { reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest };
  const approved = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: realm.realm, ...identity, expectedGeneration: '0', supersedes: null,
    outcome: 'approved', method: 'human', methodRevision: 'saved-view-fixture-v1',
    dependencyDigest: createHash('sha256').update(work.work).digest('hex'), reasonReference: null, actingSubject: author,
  }, home.author.token), 201);
  await json(await call('POST', '/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm: realm.realm, ...identity, reviewDecisionId: approved.decisionId,
    expectedHead: null, actingSubject: author,
  }, home.author.token), 201);
  return { author, reader, realm, work, discussion: identity };
}
