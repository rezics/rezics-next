import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { TAG_PROPOSAL_COST } from '../../../services/main/src/modules/classification/tag-proposal.ts';
import { CONCEPT_SEARCH_COST } from '../../../services/main/src/modules/semantic/concept-search.ts';
import { authorProposalFixture, json } from './tag-proposal-support.ts';

interface Proposal { statement: string; revision: string; concept: string; meaningKey: string; replayed: boolean }
interface ConceptPage { items: { concept: string; label: string; language: string; realm: string | null }[] }

test('G-354 tags: author-only proposals, CJK language lookup, independent Global/Realm decisions and immutable retries', async () => {
  const h = await authorProposalFixture();
  try {
    const work = await h.work();
    const other = await h.agent();
    const otherWork = await h.work(other);
    const realm = await h.realm();
    await h.grant(other, `classification:context:${realm}`, 'classification.context.configure');
    await json(await h.call('POST', '/v1/classification-contexts', { profile: 'classification-context-v1',
      realm, actingSubject: other }));
    // An unrelated semantic Context must not bind the absent context pin of a
    // personal Statement. This also exercises the public Statement reader.
    const unrelatedContext = `urn:rezics:test:g354:context:${randomUUID()}`;
    await h.fuseki.update(`INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(unrelatedContext)} <${RV}disclosure> <${RV}Public> }
      GRAPH ${iri(GRAPHS.revisions)} { <urn:rezics:test:g354:context-revision:${randomUUID()}>
        a <${RV}ContextSemanticRevision> ; <${RV}component> ${iri(unrelatedContext)} }
    }`);
    const label = `真後宮 ＡＢＣ ${randomUUID().slice(0, 8)}`;
    const input = { work: work.work, mainVersion: work.mainVersion, actingSubject: h.actor,
      tag: { label, language: 'zh' }, acceptance: { kind: 'global' } };
    expect((await h.call('POST', '/v1/tag-proposals', { ...input, work: otherWork.work,
      mainVersion: otherWork.mainVersion })).status).toBe(403);
    expect((await h.call('POST', '/v1/tag-proposals', { ...input, actingSubject: other })).status).toBe(403);
    h.oauth(false);
    expect((await h.call('POST', '/v1/tag-proposals', input)).status).toBe(401);
    h.oauth(true);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [h.user.id]);
    expect((await h.call('POST', '/v1/tag-proposals', input)).status).toBe(403);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
    const key = randomUUID();
    const graphBefore = h.graphCalls();
    const proposed = await json<Proposal>(await h.call('POST', '/v1/tag-proposals', input, key));
    expect(h.graphCalls() - graphBefore).toBeLessThanOrEqual(TAG_PROPOSAL_COST.graphCalls);
    expect(await json(await h.call('POST', '/v1/tag-proposals', input, key), 200)).toMatchObject({
      statement: proposed.statement, concept: proposed.concept, replayed: true });
    expect((await h.call('POST', '/v1/tag-proposals', { ...input, tag: { label: 'changed', language: 'zh' } }, key)).status).toBe(409);
    const resolve = (acceptance: unknown) => h.call('POST', '/v1/statement-resolutions', {
      profile: 'statement-resolution-v1', target: { kind: 'statement', statement: proposed.statement }, acceptance });
    expect(await json(await resolve({ kind: 'global' }), 200)).toMatchObject({ result: { state: 'absent' } });
    const decision = { profile: 'statement-decision-v1', target: { kind: 'statement', statement: proposed.statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: h.actor };
    expect((await h.call('POST', '/v1/statement-decisions', decision)).status).toBe(403);
    expect((await h.call('POST', '/v1/classification-propositions', {
      profile: 'classification-proposition-v1', label: 'unrestricted definition', actingSubject: h.actor })).status).toBe(403);
    const search = (language: string, realm?: string) => h.call('GET', '/v1/concepts?'
      + new URLSearchParams({ q: '後宮 abc', language, ...(realm ? { realm } : {}) }));
    expect((await json<ConceptPage>(await search('zh'), 200)).items).toContainEqual({ concept: proposed.concept,
      label: label.normalize('NFKC'), language: 'zh', realm: null });
    expect((await json<ConceptPage>(await search('ja'), 200)).items).toEqual([]);
    const sameConcept = await json<Proposal>(await h.call('POST', '/v1/tag-proposals', {
      ...input, tag: { concept: proposed.concept } }));
    expect(sameConcept.meaningKey).toBe(proposed.meaningKey);
    expect(sameConcept.statement).not.toBe(proposed.statement);

    await h.grant(other, 'classification:decide:global', 'statement.decide');
    const accepted = await json<{ decision: string }>(await h.call('POST', '/v1/statement-decisions', { ...decision, actingSubject: other }));
    expect(await json(await resolve({ kind: 'global' }), 200)).toMatchObject({ result: { state: 'accepted' } });
    expect((await h.call('POST', '/v1/statement-decisions', { ...decision, actingSubject: other })).status).toBe(409);
    expect((await h.call('POST', '/v1/statement-decisions', { ...decision, actingSubject: other,
      acceptance: { kind: 'realm', realm }, outcome: 'rejected' })).status).toBe(403);
    await h.grant(other, `classification:decide:${realm}`, 'statement.decide');
    await json(await h.call('POST', '/v1/statement-decisions', { ...decision, actingSubject: other,
      acceptance: { kind: 'realm', realm }, outcome: 'rejected' }));
    expect(await json(await resolve({ kind: 'realm', realm }), 200)).toMatchObject({ result: { state: 'rejected' } });
    expect(await json(await resolve({ kind: 'global' }), 200)).toMatchObject({ result: { state: 'accepted', decision: accepted.decision } });
    const local = await json<Proposal>(await h.call('POST', '/v1/tag-proposals', {
      ...input, acceptance: { kind: 'realm', realm } }));
    expect((await json<ConceptPage>(await search('zh'), 200)).items.map(item => item.concept)).not.toContain(local.concept);
    expect((await json<ConceptPage>(await search('zh', realm), 200)).items.map(item => item.concept)).toContain(local.concept);
    expect((await h.call('POST', '/v1/tag-proposals', { ...input, tag: { concept: local.concept } })).status).toBe(409);
    // A definition's existence never asserts the Work's base classification.
    expect((await h.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work.mainVersion)} <${RV}classifiedAs> ?concept } }`)).boolean).toBe(false);
    // Revoke this Work's proposal authority while retaining the Agent's last controller.
    expect((await h.accessPool.query(`UPDATE access.scope_gate
      SET open = false, dispatch_open = false, authority_epoch = authority_epoch + 1
      WHERE id = $1`, [`work:edit:${work.work}`])).rowCount).toBe(1);
    expect((await h.call('POST', '/v1/tag-proposals', input)).status).toBe(403);
    // An overflow is unavailable, never a false-negative search result.
    await h.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${Array.from({ length: CONCEPT_SEARCH_COST.candidates + 1 }, () =>
        `<https://rezics.com/id/${randomUUID()}> a <http://www.w3.org/2004/02/skos/core#Concept>, <${RV}AuthorTagConcept> ;
        <http://www.w3.org/2004/02/skos/core#prefLabel> "予算"@ja ; <${RV}conceptRealm> ${iri(realm)} .`).join('\n')}
    } }`);
    expect((await search('ja', realm)).status).toBe(503);
  } finally { await h.close(); }
}, 120_000);
